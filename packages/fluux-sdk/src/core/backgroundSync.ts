/**
 * Background sync side effects for post-connect MAM operations.
 *
 * After a fresh session (not SM resumption), runs a multi-stage background
 * process to populate message history so conversations and rooms are ready
 * when opened.
 *
 * Uses client events (`'online'` for fresh sessions) instead of store-based
 * guards, so SM resumptions are simply never triggered — no guard needed.
 *
 * @module Core/BackgroundSync
 */

import type { XMPPClient } from './XMPPClient'
import type { SideEffectsOptions } from './chatSideEffects'
import { connectionStore } from '../stores'
import { NS_MAM } from './namespaces'

/**
 * Sets up background sync side effects that run after a fresh session.
 *
 * On fresh connect (not SM resumption), this runs a multi-stage background process:
 *
 * 1. **Preview refresh** (fast): Fetch latest message for each non-archived
 *    conversation to update sidebar previews (max=5, concurrency=3).
 * 2. **Conversation catch-up** (slow): Populate full message history for all
 *    non-archived conversations so messages are ready when opened (concurrency=2).
 * 3. **Roster discovery**: Query MAM for roster contacts that don't have an
 *    existing conversation, discovering messages received while offline (concurrency=2).
 * 4. **Room catch-up** (delayed): After a delay to let rooms finish joining,
 *    populate full message history for all MAM-enabled rooms (concurrency=2).
 *
 * Additionally, once per day, checks archived conversations for new activity
 * and auto-unarchives those with new incoming messages.
 *
 * On SM resumption (`'resumed'` event), no MAM queries are needed because the
 * server replays all undelivered stanzas automatically.
 *
 * @param client - The XMPPClient instance
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up the subscriptions
 */
export function setupBackgroundSyncSideEffects(
  client: XMPPClient,
  options: SideEffectsOptions = {}
): () => void {
  const { debug = false } = options

  // Track whether background sync has been triggered this connection cycle
  let backgroundSyncDone = false
  // Whether the current session is fresh (set by 'online' event, cleared on disconnect)
  let isFreshSession = false
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
   * Triggers background sync: preview refresh, conversation catch-up,
   * roster discovery, room catch-up, and daily archived conversation check.
   */
  function triggerBackgroundSync(): void {
    if (backgroundSyncDone) return
    backgroundSyncDone = true

    if (debug) console.log('[SideEffects] Sync: Starting background sync')

    // Stage 1: Refresh sidebar previews (fast), then catch up full history (slow)
    void client.mam.refreshConversationPreviews()
      .then(() => {
        if (debug) console.log('[SideEffects] Sync: Starting background conversation catch-up')
        return client.mam.catchUpAllConversations({ concurrency: 2 })
      })
      .catch(() => {})

    // Stage 2: Daily check of archived conversations for new activity
    if (shouldCheckArchived()) {
      if (debug) console.log('[SideEffects] Sync: Running daily archived conversation check')
      void client.mam.refreshArchivedConversationPreviews()
        .then(() => markArchivedChecked())
        .catch(() => {})
    }

    // Stage 3: Discover conversations from roster contacts with no existing conversation
    void client.mam.discoverNewConversationsFromRoster({ concurrency: 2 }).catch(() => {})

    // Stage 4: Room catch-up (delayed to let rooms finish joining and discover MAM)
    roomCatchUpTimer = setTimeout(() => {
      roomCatchUpTimer = undefined
      if (debug) console.log('[SideEffects] Sync: Starting background room catch-up')
      void client.mam.catchUpAllRooms({ concurrency: 2 }).catch(() => {})
    }, 10_000)
  }

  // Fresh session: 'online' fires only on fresh sessions (not SM resumption).
  // This is the entry point for all MAM background sync.
  const unsubscribeOnline = client.on('online', () => {
    backgroundSyncDone = false
    isFreshSession = true

    if (debug) console.log('[SideEffects] Sync: Fresh session — checking MAM support')

    // Check if MAM is already supported (cached serverInfo from previous session)
    const supportsMAM = connectionStore.getState().serverInfo?.features?.includes(NS_MAM) ?? false
    if (supportsMAM) {
      triggerBackgroundSync()
    }
    // If MAM not yet known, the serverInfo subscription below will catch it
  })

  // SM resumption: no MAM queries needed, just log
  const unsubscribeResumed = client.on('resumed', () => {
    isFreshSession = false
    if (debug) console.log('[SideEffects] Sync: SM resumption — skipping background sync')
  })

  // When going offline, cancel any pending room catch-up timer.
  // Uses selective subscription to avoid firing on unrelated connectionStore
  // changes (serverInfo, ownAvatar, etc.) during post-connection initialization.
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
        isFreshSession = false
        if (roomCatchUpTimer) {
          clearTimeout(roomCatchUpTimer)
          roomCatchUpTimer = undefined
        }
      }
      previousStatus = status
    }
  )

  // Subscribe to serverInfo changes (for fresh sessions where MAM discovery is async)
  let hadMAMSupport = connectionStore.getState().serverInfo?.features?.includes(NS_MAM) ?? false
  const unsubscribeServerInfo = connectionStore.subscribe(
    (state) => state.serverInfo,
    (serverInfo) => {
      const hasMAMSupport = serverInfo?.features?.includes(NS_MAM) ?? false

      // When MAM support is first discovered
      if (hasMAMSupport && !hadMAMSupport) {
        hadMAMSupport = hasMAMSupport

        // Only trigger on fresh sessions (isFreshSession is false on SM resumption)
        if (isFreshSession && !backgroundSyncDone) {
          if (debug) console.log('[SideEffects] Sync: MAM support discovered, triggering background sync')
          triggerBackgroundSync()
        }
      } else {
        hadMAMSupport = hasMAMSupport
      }
    }
  )

  return () => {
    unsubscribeOnline()
    unsubscribeResumed()
    unsubscribeConnection()
    unsubscribeServerInfo()
    if (roomCatchUpTimer) {
      clearTimeout(roomCatchUpTimer)
      roomCatchUpTimer = undefined
    }
  }
}
