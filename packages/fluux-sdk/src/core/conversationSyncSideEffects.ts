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
import { shallow } from 'zustand/shallow'
import { logInfo, logWarn } from './logger'

/** Debounce interval for publishing (ms) */
const PUBLISH_DEBOUNCE_MS = 3_000
/** Delay before retrying a failed publish (ms) */
const PUBLISH_RETRY_MS = 30_000
/** Consecutive failed publishes retried before waiting for the next change */
const MAX_PUBLISH_RETRIES = 3

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
  let failedPublishes = 0

  function buildSnapshot(conversations: SyncedConversation[]): string {
    return JSON.stringify(conversations
      .map(({ jid, archived }) => ({ jid, archived }))
      .sort((a, b) => a.jid.localeCompare(b.jid)))
  }

  /**
   * Schedule a debounced publish. Resets timer on each call.
   */
  function schedulePublish(delayMs: number = PUBLISH_DEBOUNCE_MS): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void doPublish()
    }, delayMs)
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
      failedPublishes = 0
      logInfo('ConversationSync: published conversation list')
    } catch (err) {
      failedPublishes++
      logWarn(`ConversationSync: publish failed (${failedPublishes}): ${err instanceof Error ? err.message : String(err)}`)
      // A later list change schedules its own publish; the retry covers a
      // list that stays unchanged after the failure.
      if (baseline === publishingBaseline && !debounceTimer && failedPublishes <= MAX_PUBLISH_RETRIES) {
        schedulePublish(PUBLISH_RETRY_MS)
      }
    }
  }

  // Subscribe to conversation list changes. The selector builds a new object
  // on every call, so it needs `shallow`: with the default identity check it
  // fires on every chatStore change and each unrelated update (typing, unread)
  // restarts the debounce.
  const unsubscribeStore = chatStore.subscribe(
    (state) => ({
      entities: state.conversationEntities,
      archived: state.archivedConversations,
    }),
    () => {
      if (!baseline) return
      failedPublishes = 0
      schedulePublish()
    },
    { equalityFn: shallow }
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
