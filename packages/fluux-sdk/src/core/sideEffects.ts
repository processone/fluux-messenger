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
        // Step 1: Load from IndexedDB cache immediately
        const existingMessages = chatStore.getState().messages.get(activeConversationId)
        if (!existingMessages || existingMessages.length === 0) {
          if (debug) console.log('[SideEffects] Chat: Loading from cache')
          await chatStore.getState().loadMessagesFromCache(activeConversationId, { limit: 100 })
        }

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

  // Subscribe to connection status changes (for reconnection catch-up)
  // Note: connectionStore doesn't use subscribeWithSelector, so we track previous status manually
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe((state) => {
    const status = state.status
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
 *
 * Note: Room history comes from the MUC join process, so no MAM fetch needed here.
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

  // Track which rooms we've loaded cache for
  const cacheLoaded = new Set<string>()

  // Note: We don't need the client for room side effects currently,
  // but keeping it in the signature for consistency and future use
  void client

  const unsubscribe = roomStore.subscribe(
    // Selector: only react to activeRoomJid changes
    (state) => state.activeRoomJid,
    // Handler: runs when activeRoomJid changes
    (activeRoomJid, previousRoomJid) => {
      // Clear tracking for previous room
      if (previousRoomJid) {
        cacheLoaded.delete(previousRoomJid)
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

      // Already loaded for this room
      if (cacheLoaded.has(activeRoomJid)) {
        if (debug) console.log('[SideEffects] Room: Cache already loaded')
        return
      }

      // Run async operations outside the synchronous subscriber
      void (async () => {
        // Load from IndexedDB cache
        const existingMessages = roomStore.getState().rooms.get(activeRoomJid)?.messages
        if (!existingMessages || existingMessages.length === 0) {
          cacheLoaded.add(activeRoomJid)
          if (debug) console.log('[SideEffects] Room: Loading from cache')
          await roomStore.getState().loadMessagesFromCache(activeRoomJid, { limit: 100 })
        } else {
          cacheLoaded.add(activeRoomJid)
          if (debug) console.log('[SideEffects] Room: Already has messages in memory')
        }
      })()
    },
    { fireImmediately: false }
  )

  return unsubscribe
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

  return () => {
    unsubscribeChat()
    unsubscribeRoom()
  }
}
