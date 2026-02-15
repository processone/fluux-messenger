/**
 * Chat-related side effects for lazy MAM loading.
 *
 * Subscribes to active conversation changes and triggers:
 * 1. IndexedDB cache loading (immediate)
 * 2. Background MAM fetch for catch-up (when connected)
 *
 * Uses client events (`'online'` for fresh sessions) so SM resumptions
 * skip MAM queries entirely — no guard needed.
 *
 * @module Core/ChatSideEffects
 */

import type { XMPPClient } from './XMPPClient'
import { chatStore, connectionStore } from '../stores'
import { NS_MAM } from './namespaces'
import { logInfo } from './logger'
import { getDomain } from './jid'

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

    logInfo(`Chat side effect: MAM fetch start for ${getDomain(conversationId) || '*'}@...`)

    try {
      const cachedMessages = chatStore.getState().messages.get(conversationId)
      const newestCachedMessage = cachedMessages?.[cachedMessages.length - 1]

      const queryOptions: { with: string; start?: string } = { with: conversation.id }
      if (newestCachedMessage?.timestamp) {
        const startTime = new Date(newestCachedMessage.timestamp.getTime() + 1)
        queryOptions.start = startTime.toISOString()
      }

      await client.chat.queryMAM(queryOptions)
      logInfo('Chat side effect: MAM fetch complete')
    } catch (error) {
      // Only log if it's not a disconnection error (those are expected during reconnect)
      const errorMsg = error instanceof Error ? error.message : String(error)
      if (errorMsg.includes('disconnected') || errorMsg.includes('Not connected') || errorMsg.includes('Socket not available')) {
        if (debug) console.log('[SideEffects] Chat: MAM skipped - client disconnected')
      } else {
        console.error('[SideEffects] Chat: MAM fetch failed:', error)
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

      logInfo(`Chat side effect: active conversation changed to ${getDomain(activeConversationId) || '*'}@...`)

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

  // Whether the current session is fresh (set by 'online' event, cleared on disconnect)
  let isFreshSession = false

  // Fresh session: catch up MAM for the active conversation.
  // 'online' fires only on fresh sessions (not SM resumption).
  const unsubscribeOnline = client.on('online', () => {
    isFreshSession = true

    const activeConversationId = chatStore.getState().activeConversationId
    if (activeConversationId) {
      if (debug) console.log('[SideEffects] Chat: Fresh session, catching up active conversation', activeConversationId)

      // Clear the fetch tracking so we can re-fetch after reconnect
      fetchInitiated.delete(activeConversationId)

      // Trigger MAM catch-up for the active conversation
      void fetchMAMForConversation(activeConversationId)
    }
  })

  // SM resumption: no MAM catchup needed — server replays undelivered stanzas
  const unsubscribeResumed = client.on('resumed', () => {
    isFreshSession = false
    if (debug) console.log('[SideEffects] Chat: SM resumption — skipping MAM catchup')

    // Mark active conversation as already fetched so switching away and back
    // doesn't trigger a redundant MAM query (SM already caught us up)
    const activeConversationId = chatStore.getState().activeConversationId
    if (activeConversationId) {
      fetchInitiated.add(activeConversationId)
    }
  })

  // Subscribe to connection status changes for typing cleanup only.
  // This fires on both fresh sessions and SM resumption — typing states
  // should always be cleared when going offline.
  // Uses selective subscription to avoid firing on unrelated connectionStore
  // changes (serverInfo, ownAvatar, etc.) during post-connection initialization.
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      // When going offline, clear typing states to prevent stale indicators
      // and orphaned typing timeout timers
      if (status !== 'online' && previousStatus === 'online') {
        if (debug) console.log('[SideEffects] Chat: Going offline, clearing typing states')
        chatStore.getState().clearAllTyping()
        isFreshSession = false
      }

      previousStatus = status
    }
  )

  // Subscribe to serverInfo changes (for initial MAM support discovery)
  // When the app auto-selects a conversation during login, serverInfo may not be
  // populated yet. This subscription triggers MAM fetch when MAM becomes available.
  let hadMAMSupport = connectionStore.getState().serverInfo?.features?.includes(NS_MAM) ?? false
  const unsubscribeServerInfo = connectionStore.subscribe(
    (state) => state.serverInfo,
    (serverInfo) => {
      const hasMAMSupport = serverInfo?.features?.includes(NS_MAM) ?? false

      // When MAM support is first discovered (wasn't available before, now it is)
      if (hasMAMSupport && !hadMAMSupport) {
        hadMAMSupport = hasMAMSupport

        // Only trigger on fresh sessions (isFreshSession is false on SM resumption)
        if (!isFreshSession) return

        const activeConversationId = chatStore.getState().activeConversationId
        if (activeConversationId && !fetchInitiated.has(activeConversationId)) {
          if (debug) console.log('[SideEffects] Chat: MAM support discovered, fetching for active conversation', activeConversationId)
          void fetchMAMForConversation(activeConversationId)
        }
      } else {
        hadMAMSupport = hasMAMSupport
      }
    }
  )

  return () => {
    unsubscribeConversation()
    unsubscribeOnline()
    unsubscribeResumed()
    unsubscribeConnection()
    unsubscribeServerInfo()
  }
}
