/**
 * Background sync side effects for post-connect MAM operations.
 *
 * After a fresh session (not SM resumption), runs a multi-stage background
 * process to populate message history so conversations and rooms are ready
 * when opened.
 *
 * Stages are serialized to avoid overwhelming the server with concurrent queries.
 * The active conversation/room is excluded since side effects handle those.
 *
 * Uses client events (`'online'` for fresh sessions) instead of store-based
 * guards, so SM resumptions are simply never triggered — no guard needed.
 *
 * @module Core/BackgroundSync
 */

import type { XMPPClient } from './XMPPClient'
import type { SideEffectsOptions } from './chatSideEffects'
import { connectionStore, chatStore, roomStore } from '../stores'
import { NS_MAM } from './namespaces'

/**
 * Sets up background sync side effects that run after a fresh session.
 *
 * On fresh connect (not SM resumption), this runs a serialized multi-stage process:
 *
 * 1. **Conversation catch-up**: Populate full message history for all non-archived
 *    conversations (excluding the active one handled by chatSideEffects) (concurrency=2).
 * 2. **Roster discovery** (hourly): Query MAM for roster contacts that don't have an
 *    existing conversation, discovering messages received while offline (concurrency=2).
 * 3. **Archived check** (daily): Refresh previews for archived conversations and
 *    auto-unarchive those with new incoming messages.
 * 4. **Room catch-up** (delayed): After a delay to let rooms finish joining,
 *    populate full message history for all MAM-enabled rooms (concurrency=2).
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

  // --- Hourly roster discovery helpers ---
  const ROSTER_DISCOVERY_KEY = 'fluux:lastRosterDiscovery'
  const ONE_HOUR_MS = 60 * 60 * 1000

  function shouldDiscoverRoster(): boolean {
    try {
      const lastCheck = localStorage.getItem(ROSTER_DISCOVERY_KEY)
      if (!lastCheck) return true
      return Date.now() - parseInt(lastCheck, 10) > ONE_HOUR_MS
    } catch {
      return true // If localStorage fails, check anyway
    }
  }

  function markRosterDiscovered(): void {
    try {
      localStorage.setItem(ROSTER_DISCOVERY_KEY, String(Date.now()))
    } catch {
      // Silently ignore localStorage errors
    }
  }

  /**
   * Triggers background sync: conversation catch-up, roster discovery,
   * archived conversation check, and room catch-up.
   *
   * Stages are serialized to cap server load at ~2 concurrent MAM queries
   * (plus the active entity query from side effects = ~3 total).
   */
  function triggerBackgroundSync(): void {
    if (backgroundSyncDone) return
    backgroundSyncDone = true

    if (debug) console.log('[SideEffects] Sync: Starting background sync')

    // Read active entities — side effects already handle MAM for these
    const activeConversationId = chatStore.getState().activeConversationId
    const activeRoomJid = roomStore.getState().activeRoomJid

    // Serialized pipeline: catch-up → roster discovery → archived check
    void (async () => {
      try {
        // Stage 1: Conversation catch-up (skip active — handled by chatSideEffects)
        if (debug) console.log('[SideEffects] Sync: Starting conversation catch-up')
        await client.mam.catchUpAllConversations({ concurrency: 2, exclude: activeConversationId })

        // Stage 2: Roster discovery (hourly cooldown)
        if (shouldDiscoverRoster()) {
          if (debug) console.log('[SideEffects] Sync: Running roster discovery')
          await client.mam.discoverNewConversationsFromRoster({ concurrency: 2 })
          markRosterDiscovered()
        }

        // Stage 3: Daily archived conversation check
        if (shouldCheckArchived()) {
          if (debug) console.log('[SideEffects] Sync: Running daily archived conversation check')
          await client.mam.refreshArchivedConversationPreviews()
          markArchivedChecked()
        }
      } catch {
        // Silently ignore — best-effort sync
      }
    })()

    // Stage 4: Room catch-up (delayed to let rooms finish joining and discover MAM)
    roomCatchUpTimer = setTimeout(() => {
      roomCatchUpTimer = undefined
      if (debug) console.log('[SideEffects] Sync: Starting background room catch-up')
      void client.mam.catchUpAllRooms({ concurrency: 2, exclude: activeRoomJid }).catch(() => {})
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
