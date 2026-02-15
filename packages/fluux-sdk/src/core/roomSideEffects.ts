/**
 * Room-related side effects for lazy MAM loading.
 *
 * Subscribes to active room changes and triggers:
 * 1. IndexedDB cache loading (immediate)
 * 2. Background MAM fetch for catch-up (when connected and room supports MAM)
 *
 * Also watches for `supportsMAM` and `joined` state transitions to handle
 * the race between session restore and room joining.
 *
 * Uses client events (`'online'` for fresh sessions) and an `isFreshSession`
 * flag so SM resumptions skip MAM queries entirely.
 *
 * @module Core/RoomSideEffects
 */

import type { XMPPClient } from './XMPPClient'
import type { SideEffectsOptions } from './chatSideEffects'
import { roomStore, connectionStore } from '../stores'
import { logInfo } from './logger'

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

    // Check connection
    const connectionStatus = connectionStore.getState().status
    if (connectionStatus !== 'online') {
      if (debug) console.log('[SideEffects] Room: Skipping MAM (status:', connectionStatus, ')')
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
      const newestCachedMessage = messages[messages.length - 1]

      if (newestCachedMessage?.timestamp) {
        // Query for messages AFTER the newest cached message (catchup)
        const startTime = new Date(newestCachedMessage.timestamp.getTime() + 1)
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
    (activeRoomJid, previousRoomJid) => {
      // Clear tracking for previous room (allow re-fetch on return)
      if (previousRoomJid) {
        fetchInitiated.delete(previousRoomJid)
      }

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

  // Whether the current session is fresh (set by 'online' event, cleared on disconnect/SM resumption)
  let isFreshSession = false

  // Fresh session: catch up MAM for the active room.
  // 'online' fires only on fresh sessions (not SM resumption).
  const unsubscribeOnline = client.on('online', () => {
    isFreshSession = true

    const activeRoomJid = roomStore.getState().activeRoomJid
    if (activeRoomJid) {
      if (debug) console.log('[SideEffects] Room: Fresh session, catching up active room', activeRoomJid)

      // Clear the fetch tracking so we can re-fetch after reconnect
      fetchInitiated.delete(activeRoomJid)

      // Trigger MAM catch-up for the active room
      void fetchMAMForRoom(activeRoomJid)
    }
  })

  // SM resumption: no MAM catchup needed — server replays undelivered stanzas
  const unsubscribeResumed = client.on('resumed', () => {
    isFreshSession = false
    if (debug) console.log('[SideEffects] Room: SM resumption — skipping MAM catchup')

    // Mark active room as already fetched so switching away and back
    // doesn't trigger a redundant MAM query (SM already caught us up)
    const activeRoomJid = roomStore.getState().activeRoomJid
    if (activeRoomJid) {
      fetchInitiated.add(activeRoomJid)
    }
  })

  // When going offline, clear isFreshSession.
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
        isFreshSession = false
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
        // Only trigger on fresh sessions (isFreshSession is false on SM resumption)
        if (!isFreshSession) return

        if (!fetchInitiated.has(current.jid)) {
          if (debug) console.log('[SideEffects] Room: MAM support discovered for active room', current.jid)
          void fetchMAMForRoom(current.jid)
        }
      }
    },
    { fireImmediately: false }
  )

  // Subscribe to joined state changes on the active room.
  // This handles the case where MAM fetch is skipped because room wasn't joined yet:
  // 1. Room starts joining, supportsMAM becomes true
  // 2. MAM fetch is attempted but skipped (room not joined yet)
  // 3. Join completes, joined becomes true
  // 4. This subscription catches that and triggers MAM fetch
  const unsubscribeRoomJoined = roomStore.subscribe(
    // Selector: watch joined state on the active room
    (state) => {
      const activeJid = state.activeRoomJid
      if (!activeJid) return { jid: null, joined: false, supportsMAM: false }
      const room = state.rooms.get(activeJid)
      return {
        jid: activeJid,
        joined: room?.joined ?? false,
        supportsMAM: room?.supportsMAM ?? false,
      }
    },
    // Handler: runs when joined changes for active room
    (current, previous) => {
      // If the room just finished joining and supports MAM
      if (current.joined && !previous.joined && current.supportsMAM && current.jid) {
        // Only trigger on fresh sessions (isFreshSession is false on SM resumption)
        if (!isFreshSession) return

        if (!fetchInitiated.has(current.jid)) {
          if (debug) console.log('[SideEffects] Room: Join completed for active room', current.jid)
          void fetchMAMForRoom(current.jid)
        }
      }
    },
    { fireImmediately: false }
  )

  return () => {
    unsubscribe()
    unsubscribeOnline()
    unsubscribeResumed()
    unsubscribeConnection()
    unsubscribeRoomMAMSupport()
    unsubscribeRoomJoined()
  }
}
