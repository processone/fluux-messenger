/**
 * Conversation sync side effects for debounced PEP publishing.
 *
 * Replacement and baseline rules live in docs/XEP-CONVERSATION_SYNC.md.
 * Debouncing avoids flooding the server during bulk operations such as MAM
 * background sync.
 *
 * @module Core/ConversationSyncSideEffects
 */

import type { SideEffectHost } from './sideEffectHost'
import type { SyncedConversation } from './modules/ConversationSync'
import type { SideEffectsOptions } from './chatSideEffects'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { logInfo } from './logger'

/** Debounce interval for publishing (ms) */
const PUBLISH_DEBOUNCE_MS = 3_000

/**
 * Sets up conversation sync side effects for debounced PEP publishing.
 *
 * Subscribes to chatStore changes (conversationEntities + archivedConversations)
 * and publishes the updated list to PEP with a 3-second debounce. Publishing is
 * disabled until `conversationListReady` supplies a merged server baseline, or
 * a resumed stream restores the baseline of the session it resumes.
 *
 * @param client - The client driving these side effects
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up all subscriptions
 */
export function setupConversationSyncSideEffects(
  client: SideEffectHost,
  options: SideEffectsOptions = {}
): () => void {
  const { debug: _debug = false } = options

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let baseline: { snapshot: string } | undefined
  // The baseline of a session that lost its connection, kept for its resumption.
  let suspendedBaseline: { snapshot: string } | undefined
  let pendingListRefresh: object | undefined

  function buildSnapshot(conversations: SyncedConversation[]): string {
    return JSON.stringify(conversations
      .map(({ jid, archived }) => ({ jid, archived }))
      .sort((a, b) => a.jid.localeCompare(b.jid)))
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
    const publishingBaseline = baseline
    if (!publishingBaseline || connectionStore.getState().status !== 'online') return

    const { conversationEntities, archivedConversations } = chatStore.getState()
    const conversations = Array.from(conversationEntities.keys()).map(jid => ({
      jid,
      archived: archivedConversations.has(jid),
    }))
    const snapshot = buildSnapshot(conversations)
    if (snapshot === publishingBaseline.snapshot) return

    try {
      await client.internal.conversationSync.publishConversations(conversations)
      if (baseline === publishingBaseline) publishingBaseline.snapshot = snapshot
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
      if (!baseline) return
      schedulePublish()
    }
  )

  const unsubscribeOnline = client.internal.on('online', () => {
    baseline = undefined
    suspendedBaseline = undefined
    pendingListRefresh = undefined
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  })

  const unsubscribeListReady = client.internal.on('conversationListReady', (conversations) => {
    baseline = { snapshot: buildSnapshot(conversations) }
    schedulePublish()
  })

  // A resumed stream replays the list notifications sent while it was
  // disconnected (XEP-0198), so the session's baseline still holds and the
  // changes made meanwhile are published against it. A resumption without one
  // (the process restarted) fetches the list instead, unless the session
  // lifecycle turns it into a fresh session ('online') in the same turn, as it
  // does when the local cache was cleared: that session fetches the list itself.
  const unsubscribeResumed = client.internal.on('resumed', () => {
    baseline = suspendedBaseline
    suspendedBaseline = undefined
    if (baseline) {
      schedulePublish()
      return
    }
    const refresh = {}
    pendingListRefresh = refresh
    queueMicrotask(() => {
      if (pendingListRefresh !== refresh) return
      pendingListRefresh = undefined
      client.internal.refreshConversationList().catch(() => {
        // Best-effort — the next live list or fresh session sets a baseline
      })
    })
  })

  // On disconnect: disable sync and cancel pending timer
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
        suspendedBaseline = baseline
        baseline = undefined
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = undefined
        }
      }
      previousStatus = status
    }
  )

  return () => {
    baseline = undefined
    suspendedBaseline = undefined
    pendingListRefresh = undefined
    unsubscribeStore()
    unsubscribeOnline()
    unsubscribeListReady()
    unsubscribeResumed()
    unsubscribeConnection()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }
}
