/**
 * Store-based side effects for the SDK.
 *
 * This module sets up Zustand store subscriptions that trigger side effects
 * when certain state changes occur. This approach has several advantages:
 *
 * 1. **No render loops**: Side effects run outside React's render cycle
 * 2. **Single source of truth**: Side effect logic lives in one place
 * 3. **Granular subscriptions**: Only fires when specific state changes
 * 4. **Testable**: Easy to test subscription logic in isolation
 *
 * ## Lazy MAM Loading
 *
 * The core responsibility of this module is implementing **lazy MAM loading**:
 *
 * - **On connect**: NO MAM queries run (fast connect)
 * - **On conversation open**: Load cache first, then MAM query for newer messages
 * - **On reconnect**: Catch up only the active conversation
 *
 * This defers expensive archive queries until actually needed, dramatically
 * improving connection time for users with large message archives.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────┐
 * │         Store State Change              │
 * │   (e.g., activeConversationId)          │
 * └────────────────┬────────────────────────┘
 *                  │ Zustand subscribe()
 *                  ▼
 * ┌─────────────────────────────────────────┐
 * │         Side Effect Handler             │
 * │   - Load cache from IndexedDB           │
 * │   - Trigger MAM query (if connected)    │
 * │   - Mark as read (optional)             │
 * └─────────────────────────────────────────┘
 * ```
 *
 * ## Usage
 *
 * Side effects are automatically set up when XMPPClient is created.
 * The subscriptions are cleaned up when the client is destroyed.
 *
 * @packageDocumentation
 * @module Core/SideEffects
 */

import type { XMPPClient } from './XMPPClient'
import { chatStore, roomStore, connectionStore } from '../stores'
import { NS_MAM } from './namespaces'

/**
 * Options for configuring side effects behavior.
 */
export interface SideEffectsOptions {
  /** Whether to enable debug logging */
  debug?: boolean
}

/**
 * Sets up chat-related side effects.
 *
 * Subscribes to `activeConversationId` changes and:
 * 1. Loads messages from IndexedDB cache immediately
 * 2. Triggers background MAM fetch when connected
 *
 * @param client - The XMPPClient instance
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up the subscription
 */
export function setupChatSideEffects(
  client: XMPPClient,
  options: SideEffectsOptions = {}
): () => void {
  const { debug = false } = options

  // Track whether we've initiated a fetch for each conversation
  const fetchInitiated = new Set<string>()

  /**
   * Triggers MAM fetch for the active conversation if needed.
   * Shared logic between conversation switch and reconnection.
   */
  async function fetchMAMForConversation(conversationId: string): Promise<void> {
    const conversation = chatStore.getState().conversations.get(conversationId)
    if (!conversation || conversation.type !== 'chat') {
      return
    }

    // Check connection and MAM support
    const connectionStatus = connectionStore.getState().status
    const supportsMAM = connectionStore.getState().serverInfo?.features?.includes(NS_MAM) ?? false

    if (connectionStatus !== 'online' || !supportsMAM) {
      if (debug) console.log('[SideEffects] Chat: Skipping MAM (status:', connectionStatus, ', MAM supported:', supportsMAM, ')')
      return
    }

    const mamState = chatStore.getState().getMAMQueryState(conversationId)
    if (mamState.isLoading) {
      if (debug) console.log('[SideEffects] Chat: MAM already loading')
      return
    }

    // Mark as initiated BEFORE any state updates
    fetchInitiated.add(conversationId)

    // CRITICAL: Set loading state SYNCHRONOUSLY before starting the MAM query.
    // This prevents a race condition where the scroll handler (checking isLoadingOlder)
    // triggers fetchOlderHistory before the MAM event propagates through React.
    // The MAM module will also emit mam-loading=true, but that's idempotent.
    chatStore.getState().setMAMLoading(conversationId, true)

    if (debug) console.log('[SideEffects] Chat: Starting MAM fetch for', conversationId)

    try {
      const cachedMessages = chatStore.getState().messages.get(conversationId)
      const newestCachedMessage = cachedMessages?.[cachedMessages.length - 1]

      const queryOptions: { with: string; start?: string } = { with: conversation.id }
      if (newestCachedMessage?.timestamp) {
        const startTime = new Date(newestCachedMessage.timestamp.getTime() + 1)
        queryOptions.start = startTime.toISOString()
      }

      await client.chat.queryMAM(queryOptions)
      if (debug) console.log('[SideEffects] Chat: MAM fetch complete')
    } catch (error) {
      // Only log if it's not a disconnection error (those are expected during reconnect)
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (!errorMsg.includes('disconnected')) {
        console.error('[SideEffects] Chat: MAM fetch failed:', error)
      } else if (debug) {
        console.log('[SideEffects] Chat: MAM skipped - client disconnected')
      }
      // Clear loading state on error (MAM module clears it on success)
      chatStore.getState().setMAMLoading(conversationId, false)
    }
  }

  // Subscribe to conversation switches
  const unsubscribeConversation = chatStore.subscribe(
    // Selector: only react to activeConversationId changes
    (state) => state.activeConversationId,
    // Handler: runs when activeConversationId changes
    (activeConversationId, previousConversationId) => {
      // Clear fetch tracking for previous conversation (allow re-fetch on return)
      if (previousConversationId) {
        fetchInitiated.delete(previousConversationId)
      }

      if (!activeConversationId) {
        if (debug) console.log('[SideEffects] Chat: No active conversation')
        return
      }

      if (debug) console.log('[SideEffects] Chat: Active conversation changed to', activeConversationId)

      const conversation = chatStore.getState().conversations.get(activeConversationId)
      if (!conversation || conversation.type !== 'chat') {
        if (debug) console.log('[SideEffects] Chat: Conversation not found or not a chat')
        return
      }

      // Run async operations outside the synchronous subscriber
      void (async () => {
        // Step 1: Always load from IndexedDB cache (deduplication is handled by loadMessagesFromCache).
        // This is a fallback for cases where the hook's cache load didn't run (e.g., reconnection).
        if (debug) console.log('[SideEffects] Chat: Loading from cache')
        await chatStore.getState().loadMessagesFromCache(activeConversationId, { limit: 100 })

        // Step 2: Background MAM fetch (skip if already initiated this session)
        if (fetchInitiated.has(activeConversationId)) {
          if (debug) console.log('[SideEffects] Chat: MAM already initiated for', activeConversationId)
          return
        }

        await fetchMAMForConversation(activeConversationId)
      })()
    },
    { fireImmediately: false }
  )

  // Subscribe to connection status changes (for reconnection catch-up and cleanup)
  // Note: connectionStore doesn't use subscribeWithSelector, so we track previous status manually
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe((state) => {
    const status = state.status

    // When going offline, clear typing states to prevent stale indicators
    // and orphaned typing timeout timers
    if (status !== 'online' && previousStatus === 'online') {
      if (debug) console.log('[SideEffects] Chat: Going offline, clearing typing states')
      chatStore.getState().clearAllTyping()
    }

    // When we come back online after being disconnected
    if (status === 'online' && previousStatus !== 'online') {
      const activeConversationId = chatStore.getState().activeConversationId
      if (activeConversationId) {
        if (debug) console.log('[SideEffects] Chat: Reconnected, catching up active conversation', activeConversationId)

        // Clear the fetch tracking so we can re-fetch after reconnect
        fetchInitiated.delete(activeConversationId)

        // Trigger MAM catch-up for the active conversation
        void fetchMAMForConversation(activeConversationId)
      }
    }
    previousStatus = status
  })

  // Subscribe to serverInfo changes (for initial MAM support discovery)
  // When the app auto-selects a conversation during login, serverInfo may not be
  // populated yet. This subscription triggers MAM fetch when MAM becomes available.
  let hadMAMSupport = connectionStore.getState().serverInfo?.features?.includes(NS_MAM) ?? false
  const unsubscribeServerInfo = connectionStore.subscribe((state) => {
    const hasMAMSupport = state.serverInfo?.features?.includes(NS_MAM) ?? false

    // When MAM support is first discovered (wasn't available before, now it is)
    if (hasMAMSupport && !hadMAMSupport) {
      hadMAMSupport = hasMAMSupport

      const activeConversationId = chatStore.getState().activeConversationId
      if (activeConversationId && !fetchInitiated.has(activeConversationId)) {
        if (debug) console.log('[SideEffects] Chat: MAM support discovered, fetching for active conversation', activeConversationId)
        void fetchMAMForConversation(activeConversationId)
      }
    } else {
      hadMAMSupport = hasMAMSupport
    }
  })

  return () => {
    unsubscribeConversation()
    unsubscribeConnection()
    unsubscribeServerInfo()
  }
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

    if (debug) console.log('[SideEffects] Room: Starting MAM catchup for', roomJid)

    try {
      const messages = room.messages || []
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
      if (debug) console.log('[SideEffects] Room: MAM catchup complete')
    } catch (error) {
      // Only log if it's not a disconnection error (those are expected during reconnect)
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (!errorMsg.includes('disconnected')) {
        console.error('[SideEffects] Room: MAM catchup failed:', error)
      } else if (debug) {
        console.log('[SideEffects] Room: MAM skipped - client disconnected')
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

      if (debug) console.log('[SideEffects] Room: Active room changed to', activeRoomJid)

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

  // Subscribe to connection status changes (for reconnection catch-up)
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe((state) => {
    const status = state.status
    // When we come back online after being disconnected
    if (status === 'online' && previousStatus !== 'online') {
      const activeRoomJid = roomStore.getState().activeRoomJid
      if (activeRoomJid) {
        if (debug) console.log('[SideEffects] Room: Reconnected, catching up active room', activeRoomJid)

        // Clear the fetch tracking so we can re-fetch after reconnect
        fetchInitiated.delete(activeRoomJid)

        // Trigger MAM catch-up for the active room
        void fetchMAMForRoom(activeRoomJid)
      }
    }
    previousStatus = status
  })

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
    unsubscribeConnection()
    unsubscribeRoomMAMSupport()
    unsubscribeRoomJoined()
  }
}

/**
 * Sets up preview refresh and background catch-up side effects.
 *
 * On connect, this runs a three-stage background process:
 *
 * 1. **Preview refresh** (fast): Fetch latest message for each non-archived
 *    conversation to update sidebar previews (max=5, concurrency=3).
 * 2. **Conversation catch-up** (slow): Populate full message history for all
 *    non-archived conversations so messages are ready when opened (concurrency=2).
 * 3. **Room catch-up** (delayed): After a delay to let rooms finish joining,
 *    populate full message history for all MAM-enabled rooms (concurrency=2).
 *
 * Additionally, once per day, checks archived conversations for new activity
 * and auto-unarchives those with new incoming messages.
 *
 * @param client - The XMPPClient instance
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up the subscriptions
 */
export function setupPreviewRefreshSideEffects(
  client: XMPPClient,
  options: SideEffectsOptions = {}
): () => void {
  const { debug = false } = options

  // Track whether preview refresh has been triggered this connection cycle
  let previewRefreshDone = false
  // Timer for delayed room catch-up (cleared on cleanup or disconnect)
  let roomCatchUpTimer: ReturnType<typeof setTimeout> | undefined

  // --- Daily archived check helpers ---
  const ARCHIVED_CHECK_KEY = 'fluux:lastArchivedPreviewCheck'
  const ONE_DAY_MS = 24 * 60 * 60 * 1000

  function shouldCheckArchived(): boolean {
    try {
      const lastCheck = localStorage.getItem(ARCHIVED_CHECK_KEY)
      if (!lastCheck) return true
      return Date.now() - parseInt(lastCheck, 10) > ONE_DAY_MS
    } catch {
      return true // If localStorage fails, check anyway
    }
  }

  function markArchivedChecked(): void {
    try {
      localStorage.setItem(ARCHIVED_CHECK_KEY, String(Date.now()))
    } catch {
      // Silently ignore localStorage errors
    }
  }

  /**
   * Triggers background preview refresh, conversation catch-up, room catch-up,
   * and daily archived conversation check.
   */
  function triggerPreviewRefresh(): void {
    if (previewRefreshDone) return
    previewRefreshDone = true

    if (debug) console.log('[SideEffects] Preview: Starting background preview refresh')

    // Stage 1: Refresh sidebar previews (fast), then catch up full history (slow)
    void client.mam.refreshConversationPreviews()
      .then(() => {
        if (debug) console.log('[SideEffects] Preview: Starting background conversation catch-up')
        return client.mam.catchUpAllConversations({ concurrency: 2 })
      })
      .catch(() => {})

    // Stage 2: Daily check of archived conversations for new activity
    if (shouldCheckArchived()) {
      if (debug) console.log('[SideEffects] Preview: Running daily archived conversation check')
      void client.mam.refreshArchivedConversationPreviews()
        .then(() => markArchivedChecked())
        .catch(() => {})
    }

    // Stage 3: Room catch-up (delayed to let rooms finish joining and discover MAM)
    roomCatchUpTimer = setTimeout(() => {
      roomCatchUpTimer = undefined
      if (debug) console.log('[SideEffects] Preview: Starting background room catch-up')
      void client.mam.catchUpAllRooms({ concurrency: 2 }).catch(() => {})
    }, 10_000)
  }

  // Subscribe to connection status changes
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe((state) => {
    const status = state.status

    // When going offline, cancel any pending room catch-up timer
    if (status !== 'online' && previousStatus === 'online') {
      if (roomCatchUpTimer) {
        clearTimeout(roomCatchUpTimer)
        roomCatchUpTimer = undefined
      }
    }

    // When we come back online after being disconnected
    if (status === 'online' && previousStatus !== 'online') {
      // Reset flag for new connection cycle
      previewRefreshDone = false

      // Check if MAM is already supported (SM resumption with cached serverInfo)
      const supportsMAM = connectionStore.getState().serverInfo?.features?.includes(NS_MAM) ?? false
      if (supportsMAM) {
        triggerPreviewRefresh()
      }
      // If MAM not yet known, the serverInfo subscription below will catch it
    }

    previousStatus = status
  })

  // Subscribe to serverInfo changes (for fresh sessions where MAM discovery is async)
  let hadMAMSupport = connectionStore.getState().serverInfo?.features?.includes(NS_MAM) ?? false
  const unsubscribeServerInfo = connectionStore.subscribe((state) => {
    const hasMAMSupport = state.serverInfo?.features?.includes(NS_MAM) ?? false

    // When MAM support is first discovered
    if (hasMAMSupport && !hadMAMSupport) {
      hadMAMSupport = hasMAMSupport

      if (!previewRefreshDone) {
        if (debug) console.log('[SideEffects] Preview: MAM support discovered, triggering preview refresh')
        triggerPreviewRefresh()
      }
    } else {
      hadMAMSupport = hasMAMSupport
    }
  })

  return () => {
    unsubscribeConnection()
    unsubscribeServerInfo()
    if (roomCatchUpTimer) {
      clearTimeout(roomCatchUpTimer)
      roomCatchUpTimer = undefined
    }
  }
}

/**
 * Sets up all store-based side effects for the SDK.
 *
 * This should be called once when the XMPPClient is created. It sets up
 * subscriptions that respond to state changes and trigger appropriate
 * side effects (loading cache, fetching history, etc.).
 *
 * @param client - The XMPPClient instance
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up all subscriptions
 *
 * @example
 * ```typescript
 * const client = new XMPPClient()
 * const cleanup = setupStoreSideEffects(client)
 *
 * // Later, when client is destroyed:
 * cleanup()
 * ```
 */
export function setupStoreSideEffects(
  client: XMPPClient,
  options: SideEffectsOptions = {}
): () => void {
  const unsubscribeChat = setupChatSideEffects(client, options)
  const unsubscribeRoom = setupRoomSideEffects(client, options)
  const unsubscribePreview = setupPreviewRefreshSideEffects(client, options)

  return () => {
    unsubscribeChat()
    unsubscribeRoom()
    unsubscribePreview()
  }
}
