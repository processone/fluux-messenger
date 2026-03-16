/**
 * Conversation sync side effects for debounced PEP publishing.
 *
 * After a fresh session, the conversation list is fetched and merged in
 * `handleFreshSession()`. This side effect then watches for local changes
 * (new conversations, archive/unarchive, delete) and publishes the updated
 * list to the server with debouncing to avoid flooding during bulk operations
 * like MAM background sync.
 *
 * On SM resumption, no sync is needed — the server replays undelivered stanzas.
 *
 * @module Core/ConversationSyncSideEffects
 */

import type { XMPPClient } from './XMPPClient'
import type { SideEffectsOptions } from './chatSideEffects'
import { chatStore, connectionStore } from '../stores'
import { logInfo } from './logger'

/** Debounce interval for publishing (ms) */
const PUBLISH_DEBOUNCE_MS = 3_000

/**
 * Sets up conversation sync side effects for debounced PEP publishing.
 *
 * Subscribes to chatStore changes (conversationEntities + archivedConversations)
 * and publishes the updated list to PEP with a 3-second debounce. Publishing is
 * disabled until the fresh session fetch+merge completes, preventing premature
 * publishes during initialization.
 *
 * @param client - The XMPPClient instance
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up all subscriptions
 */
export function setupConversationSyncSideEffects(
  client: XMPPClient,
  options: SideEffectsOptions = {}
): () => void {
  const { debug: _debug = false } = options

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  // Publishing is disabled until the fresh session fetch+merge completes.
  // handleFreshSession runs synchronously before 'online' is emitted,
  // so enabling after a short delay on 'online' ensures the merge is done.
  let syncEnabled = false
  // Snapshot of last published state to avoid redundant publishes
  let lastPublishedSnapshot: string | undefined

  /**
   * Build a snapshot string from current store state for comparison.
   */
  function buildSnapshot(): { snapshot: string; conversations: Array<{ jid: string; archived: boolean }> } {
    const { conversationEntities, archivedConversations } = chatStore.getState()
    const conversations = Array.from(conversationEntities.keys()).map(jid => ({
      jid,
      archived: archivedConversations.has(jid),
    }))
    // Sort for stable comparison
    conversations.sort((a, b) => a.jid.localeCompare(b.jid))
    return {
      snapshot: JSON.stringify(conversations),
      conversations,
    }
  }

  /**
   * Schedule a debounced publish. Resets timer on each call.
   */
  function schedulePublish(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void doPublish()
    }, PUBLISH_DEBOUNCE_MS)
  }

  /**
   * Publish the current conversation list to PEP if it changed.
   */
  async function doPublish(): Promise<void> {
    if (connectionStore.getState().status !== 'online') return

    const { snapshot, conversations } = buildSnapshot()
    if (snapshot === lastPublishedSnapshot) return

    try {
      await client.conversationSync.publishConversations(conversations)
      lastPublishedSnapshot = snapshot
      logInfo('ConversationSync: published conversation list')
    } catch {
      // Best-effort — will retry on next change
    }
  }

  // Subscribe to conversation list changes.
  // Uses a combined selector over conversationEntities size + archivedConversations size
  // to detect additions, removals, and archive state changes.
  const unsubscribeStore = chatStore.subscribe(
    (state) => ({
      entityCount: state.conversationEntities.size,
      archivedCount: state.archivedConversations.size,
      // Include the identity of the maps so changes are detected
      entities: state.conversationEntities,
      archived: state.archivedConversations,
    }),
    () => {
      if (!syncEnabled) return
      schedulePublish()
    }
  )

  // On fresh session: enable publishing after a short delay to let
  // handleFreshSession's merge complete. The 'online' event fires
  // at the end of handleFreshSession, and background sync starts
  // creating conversations after that.
  const unsubscribeOnline = client.on('online', () => {
    syncEnabled = false
    lastPublishedSnapshot = undefined

    // Take the initial snapshot after merge so we don't re-publish
    // the state that was just fetched from the server.
    const { snapshot } = buildSnapshot()
    lastPublishedSnapshot = snapshot
    syncEnabled = true
  })

  // SM resumption: no sync needed
  const unsubscribeResumed = client.on('resumed', () => {
    syncEnabled = false
  })

  // On disconnect: disable sync and cancel pending timer
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
        syncEnabled = false
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = undefined
        }
      }
      previousStatus = status
    }
  )

  return () => {
    unsubscribeStore()
    unsubscribeOnline()
    unsubscribeResumed()
    unsubscribeConnection()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }
}
