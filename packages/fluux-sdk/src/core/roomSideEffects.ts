/**
 * Room-related side effects for lazy MAM loading.
 *
 * Subscribes to active room changes and triggers:
 * 1. IndexedDB cache loading (immediate)
 * 2. Background MAM fetch for catch-up (when connected and room supports MAM)
 *
 * Also listens for `room:joined` SDK events and watches `supportsMAM` state
 * transitions to handle the race between session restore and room joining.
 *
 * Uses `fetchInitiated` set to prevent duplicate MAM queries — rooms already
 * caught up via SM resumption are marked in the set by the `'resumed'` handler.
 *
 * @module Core/RoomSideEffects
 */

import type { XMPPClient } from './XMPPClient'
import type { SideEffectsOptions } from './chatSideEffects'
import { roomStore } from '../stores/roomStore'
import { connectionStore } from '../stores/connectionStore'
import { logInfo } from './logger'
import {
  isConnectionError,
  MAM_CACHE_LOAD_LIMIT,
} from '../utils/mamCatchUpUtils'

/**
 * Sets up room-related side effects.
 *
 * Subscribes to `activeRoomJid` changes and:
 * 1. Loads messages from IndexedDB cache immediately
 * 2. Triggers background MAM fetch for catchup when connected and room supports MAM
 *
 * @param client - The XMPPClient instance
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up the subscription
 */
export function setupRoomSideEffects(
  client: XMPPClient,
  options: SideEffectsOptions = {}
): () => void {
  const { debug = false } = options

  // Track whether we've initiated a fetch for each room
  const fetchInitiated = new Set<string>()
  const roomFetchOwners = new Map<string, symbol>()
  const freshSessionJoinedRooms = new Set<string>()
  let freshSessionRequiresJoinConfirmation = false
  let uninterruptedResumeMayEmitSyntheticOnline = false

  function hasConfirmedJoinForCurrentSession(roomJid: string): boolean {
    return (
      !freshSessionRequiresJoinConfirmation ||
      freshSessionJoinedRooms.has(roomJid)
    )
  }

  function isRoomFetchStillEligible(roomJid: string): boolean {
    const state = roomStore.getState()
    const room = state.rooms.get(roomJid)
    return !!(
      room &&
      state.activeRoomJid === roomJid &&
      room.joined &&
      room.supportsMAM &&
      !room.isQuickChat &&
      hasConfirmedJoinForCurrentSession(roomJid) &&
      connectionStore.getState().status === 'online' &&
      client.isConnected()
    )
  }

  // Epoch ms of the current fresh session's connection (set on 'online'). Used as
  // the forward catch-up cursor boundary so a live message arriving during catch-up
  // can't poison the cursor and silently skip the offline gap.
  let sessionStartTime: number | undefined

  /**
   * Triggers MAM fetch for the active room if needed (catchup).
   * Delegates the actual query direction/cursor selection to the shared
   * latest-first orchestrator (`client.mam.catchUpRoomHistory`) after
   * loading the IndexedDB cache.
   */
  async function fetchMAMForRoom(roomJid: string): Promise<void> {
    const room = roomStore.getState().rooms.get(roomJid)
    if (!room) {
      return
    }

    // Skip Quick Chat rooms (transient, no MAM)
    if (room.isQuickChat) {
      if (debug) console.log('[SideEffects] Room: Skipping MAM for Quick Chat')
      return
    }

    // Skip if not fully joined yet (wait for self-presence)
    if (!room.joined) {
      if (debug) console.log('[SideEffects] Room: Skipping MAM - not joined yet', roomJid)
      return
    }

    if (!hasConfirmedJoinForCurrentSession(roomJid)) {
      if (debug) {
        console.log(
          '[SideEffects] Room: Skipping MAM - fresh-session join not confirmed',
          roomJid,
        )
      }
      return
    }

    // Check if room supports MAM
    if (!room.supportsMAM) {
      if (debug) console.log('[SideEffects] Room: MAM not supported for', roomJid)
      return
    }

    // Check connection (both store status and actual client availability)
    const connectionStatus = connectionStore.getState().status
    if (connectionStatus !== 'online' || !client.isConnected()) {
      if (debug) console.log('[SideEffects] Room: Skipping MAM (status:', connectionStatus, ', connected:', client.isConnected(), ')')
      return
    }

    const mamState = roomStore.getState().getRoomMAMQueryState(roomJid)
    if (mamState.isLoading) {
      if (debug) console.log('[SideEffects] Room: MAM already loading')
      return
    }

    const fetchOwner = Symbol(roomJid)
    roomFetchOwners.set(roomJid, fetchOwner)

    // Mark as initiated BEFORE any state updates
    fetchInitiated.add(roomJid)

    // CRITICAL: Set loading state SYNCHRONOUSLY before starting the MAM query.
    // This prevents a race condition where the scroll handler (checking isLoadingOlder)
    // triggers fetchOlderHistory before the MAM event propagates through React.
    // The MAM module will also emit room:mam-loading=true, but that's idempotent.
    roomStore.getState().setRoomMAMLoading(roomJid, true)

    logInfo(`Room: starting MAM catch-up for ${roomJid}`)

    try {
      // Load IndexedDB cache first to ensure we have the latest messages
      // before deciding the MAM query direction. Without this, a foreground
      // trigger can race with the active-room subscriber's cache load, and
      // room.messages may be empty — causing a backward "before:''" query
      // instead of a forward catch-up from the newest cached message.
      await roomStore.getState().loadMessagesFromCache(roomJid, { limit: MAM_CACHE_LOAD_LIMIT })

      if (roomFetchOwners.get(roomJid) !== fetchOwner) {
        return
      }

      if (!isRoomFetchStillEligible(roomJid)) {
        roomFetchOwners.delete(roomJid)
        fetchInitiated.delete(roomJid)
        roomStore.getState().setRoomMAMLoading(roomJid, false)
        if (debug) {
          console.log(
            '[SideEffects] Room: MAM aborted after cache hydration - room no longer eligible',
            roomJid,
          )
        }
        return
      }

      // Latest-first orchestrator — room twin, Phase A only (active entity).
      const roomMessages = roomStore.getState().rooms.get(roomJid)?.messages || []
      await client.mam.catchUpRoomHistory(roomJid, roomMessages, { sessionStartTime })
      if (roomFetchOwners.get(roomJid) !== fetchOwner) {
        return
      }
      roomFetchOwners.delete(roomJid)
      logInfo('Room: MAM catch-up complete')
    } catch (error) {
      if (roomFetchOwners.get(roomJid) !== fetchOwner) {
        return
      }
      roomFetchOwners.delete(roomJid)

      // Allow backup handlers (room:joined, supportsMAM watcher) to retry
      fetchInitiated.delete(roomJid)

      if (isConnectionError(error)) {
        if (debug) console.log('[SideEffects] Room: MAM skipped - client disconnected')
      } else {
        console.error('[SideEffects] Room: MAM catchup failed:', error)
      }
      // Clear loading state on error (MAM module clears it on success)
      roomStore.getState().setRoomMAMLoading(roomJid, false)
    }
  }

  const unsubscribe = roomStore.subscribe(
    // Selector: only react to activeRoomJid changes
    (state) => state.activeRoomJid,
    // Handler: runs when activeRoomJid changes
    (activeRoomJid) => {
      // fetchInitiated is NOT cleared on room switch — within the same connected session,
      // MAM catch-up only needs to run once per room. It's cleared on disconnect / fresh session.

      if (!activeRoomJid) {
        if (debug) console.log('[SideEffects] Room: No active room')
        return
      }

      logInfo(`Room: switched to ${activeRoomJid}`)

      const room = roomStore.getState().rooms.get(activeRoomJid)
      if (!room) {
        if (debug) console.log('[SideEffects] Room: Room not found')
        return
      }

      // Quick Chat rooms don't persist history - skip cache loading
      if (room.isQuickChat) {
        if (debug) console.log('[SideEffects] Room: Skipping cache for Quick Chat')
        return
      }

      // Run async operations outside the synchronous subscriber
      void (async () => {
        // Re-entry of a room we're still joined to (no reconnect): nothing to do.
        // It was already caught up this session (fetchInitiated) AND its messages are
        // still resident (activateRoom's own cache load ran before this subscriber
        // fired on the way back in). Reloading the cache here would rebuild the
        // message array AFTER the list mounted and scrolled, knocking the restored
        // scroll position off (lands mid-list). Live delivery keeps the resident set
        // current, so there is genuinely nothing to fetch.
        const residentCount = roomStore.getState().rooms.get(activeRoomJid)?.messages.length ?? 0
        if (fetchInitiated.has(activeRoomJid) && residentCount > 0) {
          if (debug) console.log('[SideEffects] Room: re-entry of caught-up resident room, skipping cache reload + MAM', activeRoomJid)
          return
        }

        // Step 1: Load from IndexedDB cache (deduplication is handled by loadMessagesFromCache).
        // Covers paths that set the active room WITHOUT a cache load (e.g. CommandPalette's
        // setActiveRoom, session restore) and the first activation / post-reconnect catch-up.
        if (debug) console.log('[SideEffects] Room: Loading from cache')
        await roomStore.getState().loadMessagesFromCache(activeRoomJid, { limit: MAM_CACHE_LOAD_LIMIT })

        // Step 2: Background MAM fetch for catchup. Skip only if this room's archive
        // was actually fetched this session. Guard on hasQueried, NOT just
        // fetchInitiated: an SM resume can mark a room "initiated" without it ever
        // being fetched (e.g. a backgrounded autojoin), and skipping on that alone
        // would leave the archive permanently unfetched on first open — an empty
        // room. hasQueried flips true only once a MAM query completes (even empty),
        // so a genuinely-empty room still skips the redundant re-query on re-entry.
        if (
          fetchInitiated.has(activeRoomJid) &&
          roomStore.getState().getRoomMAMQueryState(activeRoomJid).hasQueried
        ) {
          if (debug) console.log('[SideEffects] Room: MAM already fetched for', activeRoomJid)
          return
        }

        await fetchMAMForRoom(activeRoomJid)
      })()
    },
    { fireImmediately: false }
  )

  // Fresh sessions require a self-presence confirmation before room MAM starts.
  // A missing-marker upgrade can also emit a synthetic 'online' after 'resumed';
  // that uninterrupted path must retain resume-seeded fetch tracking.
  const unsubscribeOnline = client.on('online', () => {
    // Record the session start before any catch-up so the forward cursor excludes
    // live messages that arrive after reconnect (silent-gap fix).
    sessionStartTime = Date.now()

    const followsUninterruptedResume = uninterruptedResumeMayEmitSyntheticOnline
    freshSessionRequiresJoinConfirmation = true
    if (!followsUninterruptedResume) {
      freshSessionJoinedRooms.clear()
      fetchInitiated.clear()
    }
    uninterruptedResumeMayEmitSyntheticOnline = false

    if (debug) {
      console.log(
        '[SideEffects] Room: Fresh session — waiting for confirmed room joins before MAM',
      )
    }
  })

  // SM resumption: no MAM catch-up needed for rooms we already hold — the server
  // replays undelivered stanzas via the SM queue, and we don't re-issue
  // presence/joinRoom so there are no spurious room:joined events. We seed
  // fetchInitiated so a belated room:joined (e.g. a bookmark-driven rejoin after a
  // long disconnect) skips redundant MAM.
  //
  // CRITICAL: only seed rooms whose archive we ACTUALLY hold — resident messages,
  // or MAM already queried this session. A room autojoined in the background but
  // never opened has neither: its archive was never fetched and the SM queue has
  // nothing to replay for it. Marking such a room caught-up makes its first open
  // skip the initial MAM fetch and show an empty room (the "archive not retrieved
  // after a reconnect" bug). hasQueried (set on any completed MAM query, even an
  // empty result) is the durable signal; it's separate from "has resident
  // messages" so a room caught up via live delivery is still covered.
  const unsubscribeResumed = client.on('resumed', () => {
    // A missing cache marker upgrades this same transport session to full fresh
    // setup, which emits a synthetic online only after room rejoins can finish.
    // Keep that next online distinguishable from a later fresh transport session.
    uninterruptedResumeMayEmitSyntheticOnline = true
    freshSessionRequiresJoinConfirmation = false
    freshSessionJoinedRooms.clear()

    if (debug) console.log('[SideEffects] Room: SM resumption — skipping MAM catchup')

    const state = roomStore.getState()
    const archiveHeld = (jid: string): boolean => {
      const room = state.rooms.get(jid)
      if (!room) return false
      return room.messages.length > 0 || state.getRoomMAMQueryState(jid).hasQueried
    }
    for (const [jid, room] of state.rooms) {
      if ((room.joined || room.isJoining) && archiveHeld(jid)) {
        fetchInitiated.add(jid)
      }
    }
    if (state.activeRoomJid && archiveHeld(state.activeRoomJid)) {
      fetchInitiated.add(state.activeRoomJid)
    }
  })

  // When going offline, clear fetch tracking so rooms get re-fetched after reconnect.
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
        uninterruptedResumeMayEmitSyntheticOnline = false
        fetchInitiated.clear()
      }
      previousStatus = status
    }
  )

  // Subscribe to supportsMAM changes on the active room.
  // This handles the case where view state is restored before rooms are joined:
  // 1. Session restore sets activeRoomJid (from previous session)
  // 2. Side effect triggers but room.supportsMAM may be false (not joined yet)
  // 3. MAM fetch is skipped
  // 4. Room joins from bookmarks, disco#info runs, supportsMAM becomes true
  // 5. This subscription catches that and triggers MAM fetch
  const unsubscribeRoomMAMSupport = roomStore.subscribe(
    // Selector: watch supportsMAM on the active room
    (state) => {
      const activeJid = state.activeRoomJid
      if (!activeJid) return { jid: null, supportsMAM: false }
      const room = state.rooms.get(activeJid)
      return { jid: activeJid, supportsMAM: room?.supportsMAM ?? false }
    },
    // Handler: runs when supportsMAM changes for active room
    (current, previous) => {
      // If supportsMAM just became true for the active room
      if (current.supportsMAM && !previous.supportsMAM && current.jid) {
        if (!fetchInitiated.has(current.jid)) {
          if (debug) console.log('[SideEffects] Room: MAM support discovered for active room', current.jid)
          void fetchMAMForRoom(current.jid)
        }
      }
    },
    { fireImmediately: false }
  )

  // Listen to room:joined SDK event to trigger MAM fetch after self-presence.
  const unsubscribeRoomJoined = client.subscribe('room:joined', ({ roomJid, joined }) => {
    if (!joined) {
      freshSessionJoinedRooms.delete(roomJid)
      return
    }

    freshSessionJoinedRooms.add(roomJid)

    const activeRoomJid = roomStore.getState().activeRoomJid
    if (roomJid !== activeRoomJid) return

    if (fetchInitiated.has(roomJid)) return

    if (debug) {
      console.log(
        '[SideEffects] Room: Self-presence received, triggering MAM fetch',
        roomJid,
      )
    }
    void fetchMAMForRoom(roomJid)
  })

  return () => {
    unsubscribe()
    unsubscribeOnline()
    unsubscribeResumed()
    unsubscribeConnection()
    unsubscribeRoomMAMSupport()
    unsubscribeRoomJoined()
  }
}
