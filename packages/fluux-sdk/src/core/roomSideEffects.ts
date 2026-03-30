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
import { roomStore, connectionStore } from '../stores'
import { logInfo } from './logger'

/**
 * Find the newest message in the array (regardless of delay status).
 *
 * Used as the catch-up cursor for MAM forward queries. Including delayed
 * messages ensures the catch-up always uses a forward query, which merges
 * correctly via full sort.
 */
function findNewestMessage(messages: Array<{ timestamp?: Date }>): { timestamp: Date } | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].timestamp) return messages[i] as { timestamp: Date }
  }
  return undefined
}

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

  /**
   * Triggers MAM fetch for the active room if needed (catchup).
   * Uses `start` filter to get messages AFTER the newest cached message.
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
      // before deciding the MAM query direction. Without this, the 'online'
      // handler races with the conversation subscriber's cache load, and
      // room.messages may be empty — causing a backward "before:''" query
      // instead of a forward catch-up from the newest cached message.
      await roomStore.getState().loadMessagesFromCache(roomJid, { limit: 100 })

      // Re-read room after cache load (store was mutated)
      const roomAfterCache = roomStore.getState().rooms.get(roomJid)
      const messages = roomAfterCache?.messages || []
      const newestMessage = findNewestMessage(messages)

      if (newestMessage?.timestamp) {
        // Query for messages AFTER the newest known message (catchup)
        const startTime = new Date(newestMessage.timestamp.getTime() + 1)
        await client.chat.queryRoomMAM({
          roomJid,
          start: startTime.toISOString(),
          max: 100,
        })
      } else {
        // No cached messages - fetch latest
        await client.chat.queryRoomMAM({
          roomJid,
          before: '', // Empty = get latest
          max: 50,
        })
      }
      logInfo('Room: MAM catch-up complete')
    } catch (error) {
      // Allow backup handlers (room:joined, supportsMAM watcher) to retry
      fetchInitiated.delete(roomJid)

      // Only log if it's not a disconnection error (those are expected during reconnect)
      const isConnectionError = error instanceof Error &&
        (error.message.includes('disconnected') ||
         error.message.includes('Not connected') ||
         error.message.includes('Socket not available'))

      if (isConnectionError) {
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
        // Step 1: Always load from IndexedDB cache (deduplication is handled by loadMessagesFromCache).
        // This is a fallback for cases where the hook's cache load didn't run (e.g., reconnection).
        if (debug) console.log('[SideEffects] Room: Loading from cache')
        await roomStore.getState().loadMessagesFromCache(activeRoomJid, { limit: 100 })

        // Step 2: Background MAM fetch for catchup (skip if already initiated this session)
        if (fetchInitiated.has(activeRoomJid)) {
          if (debug) console.log('[SideEffects] Room: MAM already initiated for', activeRoomJid)
          return
        }

        await fetchMAMForRoom(activeRoomJid)
      })()
    },
    { fireImmediately: false }
  )

  // Fresh session: catch up MAM for the active room.
  // 'online' fires only on fresh sessions (not SM resumption).
  const unsubscribeOnline = client.on('online', () => {
    const activeRoomJid = roomStore.getState().activeRoomJid
    if (activeRoomJid) {
      if (debug) console.log('[SideEffects] Room: Fresh session, catching up active room', activeRoomJid)

      // Clear all fetch tracking so every room gets re-fetched after reconnect
      fetchInitiated.clear()

      // Trigger MAM catch-up for the active room
      void fetchMAMForRoom(activeRoomJid)
    }
  })

  // SM resumption: no MAM catchup needed — server replays undelivered stanzas.
  // Mark ALL joined rooms as already fetched so room:joined events from the
  // rejoin flow don't trigger redundant MAM queries.
  // This runs BEFORE handleSmResumption resets room state (Connection.ts emits
  // 'resumed' before calling onConnectionSuccess), so rooms still have their
  // pre-reset joined/isJoining flags.
  const unsubscribeResumed = client.on('resumed', () => {
    if (debug) console.log('[SideEffects] Room: SM resumption — skipping MAM catchup')

    // Mark ALL joined/joining rooms as already fetched so room:joined events
    // from the rejoin flow don't trigger redundant MAM queries.
    // SM replay already delivered any undelivered stanzas.
    const state = roomStore.getState()
    for (const [jid, room] of state.rooms) {
      if (room.joined || room.isJoining) {
        fetchInitiated.add(jid)
      }
    }
    // Also mark the active room even if not yet joined (handles SM replaying
    // self-presence before handleSmResumption resets and re-joins rooms)
    if (state.activeRoomJid) {
      fetchInitiated.add(state.activeRoomJid)
    }
  })

  // When going offline, clear fetch tracking so rooms get re-fetched after reconnect.
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
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
  // This is more direct and reliable than watching store state transitions,
  // and doesn't need isFreshSession guards — fetchInitiated already prevents
  // duplicate queries for rooms caught up via SM resumption.
  const unsubscribeRoomJoined = client.subscribe('room:joined', ({ roomJid, joined }) => {
    if (!joined) return // Only handle successful joins

    const activeRoomJid = roomStore.getState().activeRoomJid
    if (roomJid !== activeRoomJid) return // Only fetch for the active room

    if (fetchInitiated.has(roomJid)) return // Already fetched this session

    if (debug) console.log('[SideEffects] Room: Self-presence received, triggering MAM fetch', roomJid)
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
