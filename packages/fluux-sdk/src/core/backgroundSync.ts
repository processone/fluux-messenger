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
import { logInfo } from './logger'
import { buildScopedStorageKey } from '../utils/storageScope'
import { MAM_ROOM_CATCHUP_DELAY_MS, selectRoomsNeedingResumeSeed } from '../utils/mamCatchUpUtils'

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
  const { debug: _debug = false } = options

  // Track whether background sync has been triggered this connection cycle
  let backgroundSyncDone = false
  // Whether the current session is fresh (set by 'online' event, cleared on disconnect)
  let isFreshSession = false
  // Timer for delayed room catch-up (cleared on cleanup or disconnect)
  let roomCatchUpTimer: ReturnType<typeof setTimeout> | undefined
  // Epoch ms of the current fresh session's connection. Used as the forward
  // catch-up cursor boundary so live messages arriving during the 10s room
  // catch-up window can't poison the cursor and silently skip the offline gap.
  let sessionStartTime: number | undefined

  // --- Late-MAM room retry (issue D) ---
  // A room whose disco resolves supportsMAM AFTER the single 10s catch-up pass
  // was previously dropped with no retry (only the ACTIVE room has a supportsMAM
  // watcher in roomSideEffects). We track rooms already handled this session and,
  // once the initial pass has run, catch up any non-active room that becomes
  // MAM-ready afterwards.
  const mamHandledRooms = new Set<string>()
  let initialRoomPassDone = false

  function resetRoomRetryState(): void {
    mamHandledRooms.clear()
    initialRoomPassDone = false
  }

  // --- E2EE capability warm-up ---

  /**
   * Probes E2EE capability for all known 1:1 conversations in the background.
   * Called on every fresh session so the plugin's peer-key cache is warm before
   * the user opens any chat. Runs concurrently with MAM sync (no serialization
   * needed — these are independent PEP queries).
   *
   * Batched at 2 concurrent probes to avoid overwhelming the server. Aborts
   * immediately if the connection drops. Probe errors are silently swallowed —
   * the probe will be retried when the conversation is next opened.
   */
  function triggerE2EEWarmup(): void {
    const manager = client.e2ee
    if (!manager) return

    const jids = [...chatStore.getState().conversationEntities.values()]
      .filter(e => e.type === 'chat')
      .map(e => e.id)

    if (jids.length === 0) return

    logInfo(`Background sync: warming E2EE cache for ${jids.length} conversations`)

    const BATCH = 2
    void (async () => {
      for (let i = 0; i < jids.length; i += BATCH) {
        if (!client.isConnected()) break
        await Promise.all(
          jids.slice(i, i + BATCH).map(jid =>
            manager.canEncryptTo({ kind: 'direct', peer: jid }).catch(() => {}),
          ),
        )
      }
    })()
  }

  // --- Daily archived check helpers ---
  const ARCHIVED_CHECK_KEY_BASE = 'fluux:lastArchivedPreviewCheck'
  const ONE_DAY_MS = 24 * 60 * 60 * 1000

  function getArchivedCheckKey(): string {
    return buildScopedStorageKey(ARCHIVED_CHECK_KEY_BASE)
  }

  function shouldCheckArchived(): boolean {
    try {
      const lastCheck = localStorage.getItem(getArchivedCheckKey())
      if (!lastCheck) return true
      return Date.now() - parseInt(lastCheck, 10) > ONE_DAY_MS
    } catch {
      return true // If localStorage fails, check anyway
    }
  }

  function markArchivedChecked(): void {
    try {
      localStorage.setItem(getArchivedCheckKey(), String(Date.now()))
    } catch {
      // Silently ignore localStorage errors
    }
  }

  // --- Hourly roster discovery helpers ---
  const ROSTER_DISCOVERY_KEY_BASE = 'fluux:lastRosterDiscovery'
  const ONE_HOUR_MS = 60 * 60 * 1000

  function getRosterDiscoveryKey(): string {
    return buildScopedStorageKey(ROSTER_DISCOVERY_KEY_BASE)
  }

  function shouldDiscoverRoster(): boolean {
    try {
      const lastCheck = localStorage.getItem(getRosterDiscoveryKey())
      if (!lastCheck) return true
      return Date.now() - parseInt(lastCheck, 10) > ONE_HOUR_MS
    } catch {
      return true // If localStorage fails, check anyway
    }
  }

  function markRosterDiscovered(): void {
    try {
      localStorage.setItem(getRosterDiscoveryKey(), String(Date.now()))
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

    logInfo('Background sync: starting')

    // Read active entities — side effects already handle MAM for these
    const activeConversationId = chatStore.getState().activeConversationId
    const activeRoomJid = roomStore.getState().activeRoomJid

    // Serialized pipeline: catch-up → roster discovery → archived check
    void (async () => {
      try {
        // Stage 1: Conversation catch-up (skip active — handled by chatSideEffects)
        logInfo('Background sync: conversation catch-up')
        await client.mam.catchUpAllConversations({ concurrency: 2, exclude: activeConversationId, sessionStartTime })

        // Stage 2: Roster discovery (hourly cooldown)
        if (shouldDiscoverRoster()) {
          logInfo('Background sync: roster discovery')
          await client.mam.discoverNewConversationsFromRoster({ concurrency: 2 })
          markRosterDiscovered()
        }

        // Stage 3: Daily archived conversation check
        if (shouldCheckArchived()) {
          logInfo('Background sync: checking archived conversations')
          await client.mam.refreshArchivedConversationPreviews()
          markArchivedChecked()
        }
      } catch {
        // Silently ignore — best-effort sync
      }
      // Re-decrypt anything stashed during this catch-up. retryPendingDecrypts is
      // a one-shot snapshot driven by KEY-availability events (key-unlock / plugin
      // registration). When the key is restored WHILE catch-up is still streaming,
      // its single pass only covers what was stashed at that instant; messages
      // fetched in the catch-up TAIL stay "could not be decrypted" until the next
      // launch. Firing a (coalesced) retry once catch-up settles closes that window
      // in-session. Cheap when nothing is pending (sparse encryptedPayload index)
      // and a no-op without a registered plugin. Runs even if a stage above threw.
      void client.retryPendingDecrypts()
    })()

    // Stage 4: Room catch-up + member discovery (delayed to let rooms finish joining and discover MAM)
    roomCatchUpTimer = setTimeout(() => {
      roomCatchUpTimer = undefined
      void (async () => {
        try {
          logInfo('Background sync: room catch-up (delayed 10s)')
          await client.mam.catchUpAllRooms({ concurrency: 2, exclude: activeRoomJid, sessionStartTime })
        } catch {
          // Silently ignore MAM catch-up errors
        }
        // Same rationale as the 1:1 catch-up retry above: room messages stashed
        // during this delayed pass (encrypted MUC history fetched after a mid-sync
        // key unlock) would otherwise wait until the next launch. Re-run once room
        // catch-up settles. Coalesced with any in-flight pass.
        void client.retryPendingDecrypts()
        // Record every room covered by this pass (MAM-ready now, plus the active
        // room handled by roomSideEffects) so the late-MAM watcher only retries
        // rooms whose support resolves AFTER this point (issue D).
        for (const room of roomStore.getState().joinedRooms()) {
          if (room.supportsMAM || room.jid === activeRoomJid) mamHandledRooms.add(room.jid)
        }
        initialRoomPassDone = true
        // Stage 5: Room member discovery (sequential, gentle on server)
        try {
          const joinedRooms = roomStore.getState().joinedRooms()
          const nonQuickChatRooms = joinedRooms.filter(r => !r.isQuickChat)
          if (nonQuickChatRooms.length > 0) {
            logInfo(`Background sync: member discovery for ${nonQuickChatRooms.length} rooms`)
            for (const room of nonQuickChatRooms) {
              if (!client.isConnected()) {
                logInfo('Background sync: aborting member discovery — disconnected')
                break
              }
              await client.muc.queryRoomMembers(room.jid)
            }
          }
        } catch {
          // Silently ignore member discovery errors
        }
      })()
    }, MAM_ROOM_CATCHUP_DELAY_MS)
  }

  // Fresh session: 'online' fires only on fresh sessions (not SM resumption).
  // This is the entry point for all MAM background sync.
  const unsubscribeOnline = client.on('online', () => {
    backgroundSyncDone = false
    isFreshSession = true
    sessionStartTime = Date.now()
    resetRoomRetryState()

    logInfo('Background sync: fresh session — checking MAM support')

    // Discover MAM fulltext search capability (non-blocking, doesn't affect sync)
    void client.discovery.discoverMAMSearchCapability()

    // Warm the E2EE plugin cache for all known conversations. Independent of
    // MAM — these are PEP queries that don't require server-side MAM support.
    triggerE2EEWarmup()

    // Check if MAM is already supported (cached serverInfo from previous session)
    const supportsMAM = connectionStore.getState().serverInfo?.features?.includes(NS_MAM) ?? false
    if (supportsMAM) {
      triggerBackgroundSync()
    }
    // If MAM not yet known, the serverInfo subscription below will catch it
  })

  // SM resumption: the server replays undelivered stanzas, so no bulk MAM sync is
  // needed for rooms already caught up to live. But the fresh-session room catch-up
  // (`catchUpAllRooms`) never runs here, so a room NOT caught up to live this
  // session — an autojoined room the user never opened, or one whose forward
  // catch-up left an open gap (e.g. a flaky connection dropped before the 10s
  // fresh-session pass fired) — keeps an empty or stale sidebar preview until opened
  // manually. Catch up exactly those rooms, reusing catchUpRoom (its no-cursor path
  // is a `{ before: '' }` fetch-latest that populates the archive and sets the
  // preview; a gap-open room forward-fills from its recorded gap). Caught-up rooms
  // are skipped, so this stays out of SM's "server replays, no MAM" path.
  const unsubscribeResumed = client.on('resumed', () => {
    isFreshSession = false

    const state = roomStore.getState()
    const eligible = selectRoomsNeedingResumeSeed(
      state.joinedRooms(),
      (jid) => state.getRoomMAMQueryState(jid).isCaughtUpToLive,
      state.activeRoomJid,
    )
    if (eligible.length === 0) {
      logInfo('Background sync: SM resumption — all rooms caught up')
      return
    }

    logInfo(`Background sync: SM resumption — catching up ${eligible.length} not-caught-up room(s)`)
    void (async () => {
      for (const room of eligible) {
        if (!client.isConnected()) break
        try {
          await client.mam.catchUpRoom(room.jid, sessionStartTime)
        } catch {
          // Best-effort — a per-room failure shouldn't block the others.
        }
      }
    })()
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
        resetRoomRetryState()
        if (roomCatchUpTimer) {
          clearTimeout(roomCatchUpTimer)
          roomCatchUpTimer = undefined
        }
      }
      previousStatus = status
    }
  )

  // Late-MAM room retry (issue D): catch up a non-active room whose disco resolves
  // supportsMAM AFTER the initial 10s pass. Keyed on the set of MAM-ready, joined,
  // non-Quick-Chat room JIDs so it only fires when that set actually changes.
  const unsubscribeRoomMAM = roomStore.subscribe(
    (state) =>
      [...state.rooms.values()]
        .filter((r) => r.supportsMAM && r.joined && !r.isQuickChat)
        .map((r) => r.jid)
        .sort()
        .join(','),
    () => {
      // Only retry after the initial pass; before it, the pass will cover them.
      if (!initialRoomPassDone || !isFreshSession) return
      if (!client.isConnected()) return

      const activeRoomJid = roomStore.getState().activeRoomJid
      for (const room of roomStore.getState().joinedRooms()) {
        if (!room.supportsMAM || room.isQuickChat) continue
        if (mamHandledRooms.has(room.jid)) continue
        mamHandledRooms.add(room.jid)
        // The active room is handled by roomSideEffects' own supportsMAM watcher.
        if (room.jid === activeRoomJid) continue
        logInfo(`Background sync: late MAM-ready room — catching up ${room.jid}`)
        void client.mam.catchUpRoom(room.jid, sessionStartTime)
      }
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
          logInfo('Background sync: MAM support discovered, triggering sync')
          triggerBackgroundSync()
        }
      } else {
        hadMAMSupport = hasMAMSupport
      }
    }
  )

  // --- Deferred E2EE decryption triggers ---
  // When an E2EE plugin registers (e.g. OpenPGP plugin loaded after
  // background sync already fetched MAM messages), re-decrypt any messages
  // that have a stashed encrypted payload.
  const unsubscribePluginRegistered = client.subscribe('e2ee:plugin-registered', ({ pluginId }) => {
    logInfo(`Background sync: E2EE plugin "${pluginId}" registered — retrying pending decrypts`)
    void client.retryPendingDecrypts()
  })

  // When the user unlocks the E2EE private key (e.g. web passphrase entered
  // after initial connect), re-decrypt messages that failed because the key
  // was locked at receive time.
  const unsubscribeKeyUnlocked = client.subscribe('e2ee:key-unlocked', () => {
    logInfo('Background sync: E2EE key unlocked — retrying pending decrypts')
    void client.retryPendingDecrypts()
  })

  return () => {
    unsubscribeOnline()
    unsubscribeResumed()
    unsubscribeConnection()
    unsubscribeServerInfo()
    unsubscribeRoomMAM()
    unsubscribePluginRegistered()
    unsubscribeKeyUnlocked()
    if (roomCatchUpTimer) {
      clearTimeout(roomCatchUpTimer)
      roomCatchUpTimer = undefined
    }
  }
}
