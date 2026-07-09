/**
 * Session-lifecycle engine.
 *
 * Owns everything that runs after a successful connection: routing to the
 * SM-resumption or fresh-session path, the monotonic session-generation guard
 * that lets a stale async chain bail when a newer connection supersedes it, and
 * the merge of the server-side conversation list. This is orchestration logic,
 * not part of the client facade — it coordinates the domain modules but does
 * not need to *be* the client.
 *
 * Its collaborators (the domain modules, the stores, the current identity, and
 * a few client-level operations) are injected. The modules are captured
 * directly because the engine is rebuilt whenever they are (in
 * `XMPPClient.initializeModules`); the churny pieces — stores, current JID,
 * transport — are getters so the engine always sees the live value.
 */
import { xml, Element, Client } from '@xmpp/client'
import type { Discovery } from './modules/Discovery'
import type { Admin } from './modules/Admin'
import type { Roster } from './modules/Roster'
import type { MUC } from './modules/MUC'
import type { Profile } from './modules/Profile'
import type { WebPush } from './modules/WebPush'
import { type ConversationSync, type SyncedConversation } from './modules/ConversationSync'
import {
  FRESH_SESSION_IQ_TIMEOUT_MS,
  FRESH_SESSION_SETUP_TIMEOUT_MS,
} from './modules/connectionTimeouts'
import { NS_CARBONS, NS_P1_PUSH_WEBPUSH } from './namespaces'
import { getLocalPart } from './jid'
import { logInfo } from './logger'
import { getCachedPlatform } from './platform'
import { SDK_VERSION } from '../version'
import { generateUUID } from '../utils/uuid'
import { bumpAvatarResumeCount } from '../utils/avatarCache'
import type { StoreBindings } from './types'

/**
 * Explicit collaborators for {@link SessionLifecycleEngine}. Module instances
 * are captured directly (the engine is reconstructed alongside them); stores /
 * JID / transport are getters so the engine reads the current value rather than
 * a snapshot. Client-level operations the engine cannot own itself are passed
 * as callbacks.
 */
export interface SessionLifecycleDeps {
  discovery: Discovery
  admin: Admin
  roster: Roster
  muc: MUC
  profile: Profile
  webPush: WebPush
  conversationSync: ConversationSync
  getStores: () => StoreBindings | null
  getCurrentJid: () => string | null
  getXmpp: () => Client | null
  /** Build/rebuild the E2EEManager for the now-known identity. */
  ensureE2EEManager: () => void
  sendStanza: (stanza: Element) => Promise<void>
  /** Emit the SDK `online` event (fresh-session side effects depend on it). */
  emitOnline: () => void
  /** Transition the presence machine to connected (`CONNECT`). */
  connectPresence: () => void
}

export class SessionLifecycleEngine {
  /**
   * Monotonically increasing session generation counter. Incremented each time
   * {@link handleConnectionSuccess} runs. Used by the fresh/SM paths to detect
   * stale runs and abort early when a newer connection supersedes the current
   * one (e.g. system sleep during an async chain).
   */
  private sessionGeneration = 0

  /**
   * Whether the current session was established via SM resumption. Consulted by
   * the client's mucJoined handler to skip the MAM preview fetch that SM replay
   * makes unnecessary.
   */
  private smResumedSession = false

  constructor(private readonly deps: SessionLifecycleDeps) {}

  /** Whether the current session was established via SM resumption. */
  isSmResumed(): boolean {
    return this.smResumedSession
  }

  /**
   * Handle successful connection — dispatches to SM resume or fresh session path.
   */
  async handleConnectionSuccess(
    isResumption: boolean,
    previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>,
    disconnectDurationMs?: number
  ): Promise<void> {
    // Increment session generation to invalidate any in-progress handleFreshSession/handleSmResumption.
    // If the system sleeps during an await below and a reconnect fires, the new call increments
    // this counter again, causing the stale run to bail out at its next checkpoint.
    const generation = ++this.sessionGeneration

    // Session-scoped discovery caches (e.g. the account PEP probe) must not
    // leak across sessions — server capabilities can change between logins.
    this.deps.discovery.resetSessionCache()

    const platform = getCachedPlatform() ?? 'unknown'
    logInfo(`SDK v${SDK_VERSION}, platform: ${platform}, session #${generation}`)

    // Transition presence machine to connected state
    this.deps.connectPresence()

    // Track session type for guards (e.g., skip MAM preview on mucJoined during SM replay)
    this.smResumedSession = isResumption

    // The E2EEManager is tied to a logged-in identity. Construct it the
    // first time we reach `online` (account JID now known), or rebuild it
    // if the previous manager was for a different identity. On a plain
    // SM-resume/reconnect with the same JID we reuse the existing manager
    // so registered plugins stay registered.
    this.deps.ensureE2EEManager()

    if (isResumption) {
      await this.handleSmResumption(generation, previouslyJoinedRooms, disconnectDurationMs)
    } else {
      await this.handleFreshSession(previouslyJoinedRooms, generation)
    }

    // Only run post-session tasks if this generation is still current
    if (this.isSessionStale(generation)) return

    // Write cache integrity marker (used to detect cache clear during SM resumption).
    // Written on both fresh and resumed sessions so the marker is always refreshed.
    try {
      const jid = this.deps.getCurrentJid()
      if (jid) {
        localStorage.setItem(`fluux:cache-marker:${jid}`, Date.now().toString())
      }
    } catch { /* ignore storage errors */ }

    // Always re-discover admin commands (lightweight, no MAM)
    this.deps.admin.discoverAdminCommands().catch(() => {})
  }

  /**
   * Check if the current session generation is still active.
   * Returns true if a newer connection was established, meaning
   * the current async chain should abort.
   */
  private isSessionStale(generation: number): boolean {
    return this.sessionGeneration !== generation
  }

  /**
   * Guard: check if session generation is still current and log + return true if stale.
   * Centralizes the repeated pattern of checking + logging at async checkpoints.
   */
  private isSessionSuperseded(gen: number, checkpoint: string): boolean {
    if (this.sessionGeneration === gen) return false
    logInfo(`${checkpoint} (session superseded)`)
    return true
  }

  /**
   * SM Resumption path (XEP-0198).
   *
   * When SM resumes successfully, the server replays all undelivered stanzas.
   * No MAM queries, no roster fetch, no carbons enable needed.
   *
   * Send sequence:
   * 1) Send initial presence
   * 2) Send presence probes to refresh contact status
   */
  private async handleSmResumption(
    generation?: number,
    previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>,
    disconnectDurationMs?: number
  ): Promise<void> {
    const gen = generation ?? this.sessionGeneration
    const stores = this.deps.getStores()

    // Check if local cache was cleared (e.g., Ctrl-Shift+R on Linux clears WebKit cache).
    // If the sentinel marker is missing, localStorage was wiped — upgrade to full sync
    // while keeping the SM connection alive.
    const jid = this.deps.getCurrentJid()
    try {
      const cacheMarker = jid ? localStorage.getItem(`fluux:cache-marker:${jid}`) : null
      if (!cacheMarker) {
        logInfo('SM resumption: cache marker missing — local storage was cleared, upgrading to full sync')
        stores?.console.addEvent('Cache cleared during SM session — performing full sync', 'sm')
        this.smResumedSession = false
        await this.handleFreshSession(previouslyJoinedRooms, gen)
        // Emit 'online' so side effects (MAM sync, background sync) run their fresh session path.
        // Connection.ts already emitted 'resumed', but side effects need 'online' to trigger.
        if (!this.isSessionStale(gen)) {
          this.deps.emitOnline()
        }
        return
      }
    } catch { /* ignore storage errors (e.g., SSR environments) */ }

    // Repopulate sidebar ordering from the durable cache. On a reload that resumes
    // via SM, the room list is rebuilt from persisted state where every non-active
    // room's messages were evicted before save, so it carries no lastMessage and
    // would sort at epoch-0 until opened. This mirrors the fresh-session hydration;
    // it is network-free, batched, and never downgrades a fresher preview, so it is
    // a cheap no-op for in-process resumes whose store is still intact.
    stores?.room.hydratePreviewsFromCache().catch(() => {})

    const SM_SHORT_DISCONNECT_MS = 120_000
    const isShortDisconnect = disconnectDurationMs != null
      && disconnectDurationMs < SM_SHORT_DISCONNECT_MS

    // Refresh avatar blob URLs — WebKit can reclaim them across an OS sleep, which
    // surfaces as a long/unknown-duration resumption. Skip on short network blips:
    // the URLs are still live there, so refreshing would re-read every avatar from
    // IndexedDB and re-create its blob URL on every reconnection for no benefit.
    if (!isShortDisconnect) {
      bumpAvatarResumeCount() // diagnostic: count refresh-triggering resumes (memory probe)
      this.deps.profile.refreshAllAvatarBlobUrls().catch(() => {})
    }

    await this.deps.roster.sendInitialPresence()
    if (this.isSessionSuperseded(gen, 'SM resumption aborted after sendInitialPresence')) return

    stores?.console.addEvent('Sending presence probes to refresh contact status', 'sm')
    this.deps.roster.sendPresenceProbes().catch(() => {})

    // SM resumption preserves MUC membership on the server side, so we do NOT
    // rejoin rooms or refresh presence here. The store's room list (whether
    // in-memory from the previous session or hydrated from storage on page
    // reload) is authoritative; any diff the server accumulated during the
    // disconnect — occupant leaves/joins, messages, presence changes — is
    // delivered via the SM replay queue and patched onto that state.
    //
    // Bookmarks are PEP items, not SM-queued stanzas, so they may have
    // changed on another client while disconnected. For long/unknown-duration
    // disconnects, refresh them and pick up any newly-autojoined rooms.
    if (isShortDisconnect) {
      const sec = Math.round(disconnectDurationMs / 1000)
      logInfo(`SM resumption: short disconnect (${sec}s) — skipping bookmark fetch`)
      stores?.console.addEvent(
        `SM resumption: short disconnect (${sec}s) — skipping bookmark fetch`,
        'sm'
      )
    } else {
      const sec = disconnectDurationMs != null ? Math.round(disconnectDurationMs / 1000) : 'unknown'
      logInfo(`SM resumption: disconnect ${sec}s — fetching bookmarks`)
      stores?.console.addEvent(
        `SM resumption: disconnect ${sec}s — fetching bookmarks`,
        'sm'
      )

      this.deps.muc.fetchBookmarks(FRESH_SESSION_IQ_TIMEOUT_MS).then(({ roomsToAutojoin }) => {
        if (this.isSessionStale(gen)) return
        for (const room of roomsToAutojoin) {
          if (!this.deps.getStores()?.room.getRoom(room.jid)?.joined) {
            this.deps.muc.joinRoom(room.jid, room.nick, { password: room.password }).catch(() => {})
          }
        }
      }).catch(() => {})
    }
  }

  /**
   * Fresh session path (new session or SM resume failed).
   *
   * Full initialization with explicit send sequence:
   * 1) Fetch roster
   * 2) Enable carbons
   * 3) Send initial presence
   * 4) Fetch bookmarks
   * 5) Discover MUC service (async)
   * 6) Rejoin previously active rooms and autojoin bookmarked rooms
   * 7) Run server/upload/profile discovery (async)
   *
   * Background sync side effects trigger MAM queries once server info is available.
   */
  private async handleFreshSession(
    previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>,
    generation?: number
  ): Promise<void> {
    const gen = generation ?? this.sessionGeneration
    const iqTimeout = FRESH_SESSION_IQ_TIMEOUT_MS

    // Race the entire setup against a safety timeout to prevent hanging
    // after sleep/wake when the connection is unstable.
    const setupWork = this.runFreshSessionSetup(previouslyJoinedRooms, gen, iqTimeout)
    const setupStart = Date.now()
    const timeoutPromise = new Promise<'timeout'>((resolve) =>
      setTimeout(() => resolve('timeout'), FRESH_SESSION_SETUP_TIMEOUT_MS)
    )

    const result = await Promise.race([setupWork.then(() => 'done' as const), timeoutPromise])
    if (result === 'timeout') {
      const elapsed = Date.now() - setupStart
      // If elapsed time far exceeds the requested delay, the system slept
      // through it.  Ignore this stale timeout — the wake handler will
      // trigger a fresh reconnect attempt.
      if (elapsed > FRESH_SESSION_SETUP_TIMEOUT_MS * 1.5) {
        logInfo(`Fresh session setup timeout fired stale (${Math.round(elapsed / 1000)}s elapsed) — ignoring`)
        return
      }
      logInfo(`Fresh session setup timed out after ${FRESH_SESSION_SETUP_TIMEOUT_MS / 1000}s`)
      this.deps.getStores()?.console.addEvent(
        `Fresh session setup timed out after ${FRESH_SESSION_SETUP_TIMEOUT_MS / 1000}s — will retry on next reconnect`,
        'error'
      )
      throw new Error(`Fresh session setup timed out after ${FRESH_SESSION_SETUP_TIMEOUT_MS / 1000}s`)
    }
  }

  /**
   * Core fresh session setup logic, extracted so handleFreshSession can race it
   * against a safety timeout.
   */
  private async runFreshSessionSetup(
    previouslyJoinedRooms: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }> | undefined,
    gen: number,
    iqTimeout: number
  ): Promise<void> {
    const stores = this.deps.getStores()

    // Reset MAM states so background sync will re-fetch message history
    stores?.chat.resetMAMStates()
    stores?.room.resetRoomMAMStates()

    // Reset presence and resources for fresh session
    stores?.roster.resetAllPresence()
    stores?.connection.clearOwnResources()

    // NOTE: markAllRoomsNotJoined() is intentionally deferred to just before
    // rejoinActiveRooms() below. Clearing it here would leave the room store in
    // a "nothing joined" state for the duration of roster/bookmark fetches — if
    // the session is aborted in that window (slow server, socket death), a
    // subsequent SM-resumed reconnect lands on corrupted state with no way to
    // recover. Keeping the flags until the actual rejoin preserves the live
    // view; joinRoom()'s skip-guard gets lifted atomically with the rejoin.

    // Fire-and-forget discovery calls — start immediately, independent of the serial
    // session setup chain. These must not be blocked by slow IQ responses (roster,
    // bookmarks, conversation sync) or the overall session setup timeout.
    this.deps.discovery.fetchServerInfo().then(() => {
      const serverInfo = this.deps.getStores()?.connection.getServerInfo?.()
      const hasWebPush = serverInfo?.features.includes(NS_P1_PUSH_WEBPUSH)
      const pushEnabled = this.deps.getStores()?.connection.getWebPushEnabled?.() ?? true
      console.log('[WebPush] Server disco: p1:push:webpush feature =', hasWebPush,
        '| pushEnabled =', pushEnabled, '| All features:', serverInfo?.features)
      if (hasWebPush && pushEnabled) {
        this.deps.webPush.queryServices().catch((err) => {
          console.warn('[WebPush] queryServices failed:', err)
        })
      }
    }).catch(() => {})
    this.deps.discovery.discoverHttpUploadService().catch(() => {})
    this.deps.profile.fetchOwnProfile().catch(() => {})

    // Fetch roster before sending presence
    await this.deps.roster.fetchRoster(iqTimeout)
    if (this.isSessionSuperseded(gen, 'Fresh session aborted after fetchRoster')) return
    this.enableCarbons()
    logInfo('Fresh session: roster fetched, enabling carbons')

    // Send initial presence
    await this.deps.roster.sendInitialPresence()
    if (this.isSessionSuperseded(gen, 'Fresh session aborted after sendInitialPresence')) return

    // Bookmarks and room joins
    const { roomsToAutojoin } = await this.deps.muc.fetchBookmarks(iqTimeout)
    if (this.isSessionSuperseded(gen, 'Fresh session aborted after fetchBookmarks')) return

    // Order the sidebar from the durable cache immediately (network-free, single
    // batched write). Without this, freshly-added bookmarked rooms all sort at
    // epoch-0 until each room's preview lands on join / the delayed catch-up, so
    // the active room visibly "jumps" to the top once opened.
    this.deps.getStores()?.room.hydratePreviewsFromCache().catch(() => {})

    // Fetch and merge server-side conversation list (XEP-0223)
    try {
      const serverConversations = await this.deps.conversationSync.fetchConversations(iqTimeout)
      if (this.isSessionSuperseded(gen, 'Fresh session aborted after fetchConversations')) return
      if (serverConversations.length > 0) {
        this.mergeServerConversations(serverConversations)
      }
    } catch {
      // Best-effort: conversation list sync is not critical
    }

    // Discover MUC service and check service-level MAM support BEFORE joining rooms
    // This allows queryRoomFeatures() to fall back to service-level MAM detection
    // when room-level disco fails (e.g., XSF rooms that don't respond to disco)
    this.deps.muc.discoverMucService().catch(() => {})

    // Restore cached room avatars for bookmarked rooms
    this.deps.profile.restoreAllRoomAvatarHashes().catch(() => {})

    // Rejoin rooms BEFORE server info fetch - server info can block on slow/unresponsive servers
    // Two scenarios: reconnect (previouslyJoinedRooms provided) vs fresh connect
    //
    // On reconnect: rejoin non-autojoin rooms that were active, PLUS autojoin bookmarks
    // On fresh connect: just join autojoin bookmarks
    //
    // Filter previouslyJoinedRooms to exclude any rooms that are in roomsToAutojoin
    // (the autojoin state might have changed on another client since we captured it)
    const autojoinJids = new Set(roomsToAutojoin.map(r => r.jid))

    // Rejoin non-autojoin rooms that were previously joined (reconnect only)
    const rejoinCount = previouslyJoinedRooms?.filter(r => !autojoinJids.has(r.jid)).length ?? 0
    if (roomsToAutojoin.length > 0 || rejoinCount > 0) {
      logInfo(`Fresh session: ${roomsToAutojoin.length} rooms to autojoin, ${rejoinCount} to rejoin`)
    }

    const hasRoomsToRejoin =
      (previouslyJoinedRooms && previouslyJoinedRooms.length > 0) ||
      roomsToAutojoin.length > 0

    if (hasRoomsToRejoin) {
      // Lift joinRoom()'s skip-guard just before actually rejoining. Doing this
      // here (vs at the top of runFreshSessionSetup) means the previous session's
      // room state stays visible through roster/bookmark fetches, so a socket
      // death in that window doesn't strand the store in "nothing joined".
      this.deps.getStores()?.room.markAllRoomsNotJoined()
    }

    if (previouslyJoinedRooms && previouslyJoinedRooms.length > 0) {
      const nonAutojoinRooms = previouslyJoinedRooms.filter(r => !autojoinJids.has(r.jid))
      if (nonAutojoinRooms.length > 0) {
        await this.deps.muc.rejoinActiveRooms(nonAutojoinRooms)
        if (this.isSessionSuperseded(gen, 'Fresh session aborted after rejoinActiveRooms')) return
      }
    }

    // Always join autojoin bookmarks (both fresh connect and reconnect)
    if (roomsToAutojoin.length > 0) {
      for (const room of roomsToAutojoin) {
        // Issue #37: don't silently autojoin a room that exposes the user's real JID
        // (non-anonymous, non-private) unless they've already acknowledged it. Inspect
        // via disco#info first; if it exposes the JID and isn't acknowledged, leave it
        // bookmarked-but-not-joined so the user joins it deliberately from the UI (where
        // the exposure warning is shown). Otherwise pass the features straight to
        // joinRoom() so it doesn't re-run disco.
        void (async () => {
          const features = await this.deps.muc.queryRoomFeatures(room.jid).catch(() => null)
          if (this.isSessionSuperseded(gen, 'Fresh session aborted before autojoin')) return
          const exposesRealJid = features ? (features.isNonAnonymous && !features.isPrivate) : false
          if (exposesRealJid && !this.deps.getStores()?.room.isNonAnonymousRoomAcknowledged(room.jid)) {
            logInfo(`Skipping autojoin of non-anonymous room ${room.jid} (real-JID exposure not acknowledged)`)
            return
          }
          this.deps.muc.joinRoom(room.jid, room.nick, { password: room.password, knownFeatures: features }).catch((err) => {
            console.error(`[XMPPClient] Failed to autojoin room ${room.jid}:`, err)
          })
        })()
      }
    }
  }

  /**
   * Merge server-side conversation list into the local chatStore.
   *
   * - Server conversations not in local store → create locally
   * - Shared conversations → apply server's archived status
   * - Local-only conversations → keep as-is (synced back via debounced publish)
   */
  mergeServerConversations(serverConvs: SyncedConversation[]): void {
    const stores = this.deps.getStores()
    const chat = stores?.chat
    const roster = stores?.roster
    if (!chat) return

    // Build batch: resolve names upfront, then apply all in a single store update
    const batch = serverConvs.map((serverConv) => {
      const contact = roster?.getContact(serverConv.jid)
      const name = contact?.name || getLocalPart(serverConv.jid)
      return {
        id: serverConv.jid,
        name,
        type: 'chat' as const,
        archived: serverConv.archived,
      }
    })

    chat.mergeServerConversations(batch)
    logInfo(`Conversation sync: merged ${serverConvs.length} conversations from server`)
  }

  private enableCarbons(): void {
    const xmpp = this.deps.getXmpp()
    if (!xmpp) return

    const enableCarbons = xml(
      'iq',
      { type: 'set', id: `carbons_${generateUUID()}` },
      xml('enable', { xmlns: NS_CARBONS })
    )

    void this.deps.sendStanza(enableCarbons)
    this.deps.getStores()?.console.addEvent('Message Carbons enabled', 'connection')
  }
}
