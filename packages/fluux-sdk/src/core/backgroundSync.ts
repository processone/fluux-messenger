/**
 * Background sync side effects for post-connect MAM operations.
 *
 * After a fresh session (not SM resumption), runs a multi-stage background
 * process to populate message history so conversations and rooms are ready
 * when opened.
 *
 * Conversation stages are serialized, while the delayed room pass has its own
 * concurrency cap. Active entities are excluded while foreground side effects
 * own them; released room work can be handed back after the room becomes inactive.
 *
 * Uses client events to distinguish fresh-session bulk sync from SM resumption.
 * Resume only seeds rooms whose archives are not caught up to live — including
 * rooms that join after the resume event, which the one-shot predicate cannot
 * see. A synthetic post-resume `online` can then upgrade the same transport to
 * fresh setup.
 *
 * @module Core/BackgroundSync
 */

import type { SideEffectHost } from './sideEffectHost'
import type { SideEffectsOptions } from './chatSideEffects'
import { connectionStore } from '../stores/connectionStore'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { NS_MAM } from './namespaces'
import { logInfo } from './logger'
import { buildScopedStorageKey } from '../utils/storageScope'
import {
  MAM_CACHE_LOAD_LIMIT,
  MAM_ROOM_CATCHUP_DELAY_MS,
  selectRoomsNeedingResumeSeed,
} from '../utils/mamCatchUpUtils'
import { executeWithConcurrency } from '../utils/concurrencyUtils'
import {
  getRoomMembershipEpoch,
  invalidateRoomMemberships,
  recordRoomMembership,
} from './roomMembershipEpoch'
import {
  hasRoomMamForegroundCoverage,
  subscribeRoomMamHandoff,
} from './roomMamHandoff'

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
 * On SM resumption (`'resumed'` event), rooms already caught up to live rely on
 * replayed stanzas. Only joined, inactive rooms that still need archive coverage
 * receive a resume seed query.
 *
 * @param client - The client driving these side effects
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up the subscriptions
 */
export function setupBackgroundSyncSideEffects(
  client: SideEffectHost,
  options: SideEffectsOptions = {}
): () => void {
  const { debug: _debug = false } = options

  // Track whether background sync has been triggered this connection cycle
  let backgroundSyncDone = false
  // Whether the current session is fresh (set by 'online' event, cleared on disconnect)
  let isFreshSession = false
  // Whether the current session came up via SM resumption (set by 'resumed',
  // cleared on 'online' and on disconnect). Distinct from `!isFreshSession`,
  // which is also true while the transport is down.
  let isResumedSession = false
  // Rooms already given a resume seed this session, so a room that joins,
  // leaves, and rejoins can't re-query the archive repeatedly.
  const resumeSeededRooms = new Set<string>()
  // Timer for delayed room catch-up (cleared on cleanup or disconnect)
  let roomCatchUpTimer: ReturnType<typeof setTimeout> | undefined
  // Epoch ms of the current fresh session's connection. Used as the forward
  // catch-up cursor boundary so live messages arriving during the 10s room
  // catch-up window can't poison the cursor and silently skip the offline gap.
  let sessionStartTime: number | undefined
  let sessionGeneration = 0
  let uninterruptedResumeMayEmitSyntheticOnline = false
  const freshSessionJoinedRooms = new Set<string>()

  // --- Late-MAM room retry (issue D) ---
  // A room whose disco resolves supportsMAM AFTER the single 10s catch-up pass
  // was previously dropped with no retry (only the ACTIVE room has a supportsMAM
  // watcher in roomSideEffects). We track rooms already handled this session and,
  // once the initial pass has run, catch up any non-active room that becomes
  // MAM-ready afterwards.
  const mamHandledRooms = new Set<string>()
  interface RoomCatchUpReservation {
    generation: number
    membershipEpoch: number
  }
  const mamInFlightRooms = new Map<string, RoomCatchUpReservation>()
  const pendingRoomHandoffs = new Map<string, RoomCatchUpReservation>()
  let initialRoomPassDone = false

  function resetRoomRetryState(): void {
    mamHandledRooms.clear()
    mamInFlightRooms.clear()
    pendingRoomHandoffs.clear()
    initialRoomPassDone = false
  }

  function isFreshRoomCatchUpEligible(
    roomJid: string,
    generation: number,
    membershipEpoch: number,
  ): boolean {
    const state = roomStore.getState()
    const room = state.rooms.get(roomJid)
    return !!(
      generation === sessionGeneration &&
      getRoomMembershipEpoch(client, roomJid) === membershipEpoch &&
      !hasRoomMamForegroundCoverage(client, roomJid, membershipEpoch) &&
      isFreshSession &&
      freshSessionJoinedRooms.has(roomJid) &&
      state.activeRoomJid !== roomJid &&
      room?.joined &&
      room.supportsMAM &&
      !room.isQuickChat &&
      connectionStore.getState().status === 'online' &&
      client.isConnected()
    )
  }

  async function catchUpFreshSessionRoom(
    roomJid: string,
    generation: number,
    membershipEpoch: number,
  ): Promise<boolean> {
    if (!isFreshRoomCatchUpEligible(roomJid, generation, membershipEpoch)) {
      return false
    }
    const messages = await roomStore.getState().loadMessagesFromCache(
      roomJid,
      { limit: MAM_CACHE_LOAD_LIMIT, peek: true },
    )
    if (!isFreshRoomCatchUpEligible(roomJid, generation, membershipEpoch)) {
      return false
    }
    await client.internal.mam.catchUpRoomHistory(
      roomJid,
      messages,
      { sessionStartTime, stitchReadPointer: true },
    )
    return true
  }

  async function catchUpFreshSessionRoomOnce(
    roomJid: string,
    generation: number,
  ): Promise<boolean> {
    if (mamHandledRooms.has(roomJid) || mamInFlightRooms.has(roomJid)) {
      return false
    }
    const membershipEpoch = getRoomMembershipEpoch(client, roomJid)
    if (
      hasRoomMamForegroundCoverage(client, roomJid, membershipEpoch)
    ) {
      return false
    }
    const reservation: RoomCatchUpReservation = {
      generation,
      membershipEpoch,
    }
    mamInFlightRooms.set(roomJid, reservation)
    try {
      const caughtUp = await catchUpFreshSessionRoom(
        roomJid,
        generation,
        reservation.membershipEpoch,
      )
      if (
        !caughtUp ||
        generation !== sessionGeneration ||
        getRoomMembershipEpoch(client, roomJid) !== reservation.membershipEpoch
      ) {
        return false
      }
      mamHandledRooms.add(roomJid)
      const pendingHandoff = pendingRoomHandoffs.get(roomJid)
      if (
        pendingHandoff?.generation === generation &&
        pendingHandoff.membershipEpoch === reservation.membershipEpoch
      ) {
        pendingRoomHandoffs.delete(roomJid)
      }
      return true
    } catch {
      return false
    } finally {
      if (mamInFlightRooms.get(roomJid) === reservation) {
        mamInFlightRooms.delete(roomJid)
      }
    }
  }

  async function drainPendingRoomHandoff(roomJid: string): Promise<void> {
    const pendingHandoff = pendingRoomHandoffs.get(roomJid)
    if (!pendingHandoff) return
    if (
      pendingHandoff.generation !== sessionGeneration ||
      pendingHandoff.membershipEpoch !==
        getRoomMembershipEpoch(client, roomJid)
    ) {
      if (pendingRoomHandoffs.get(roomJid) === pendingHandoff) {
        pendingRoomHandoffs.delete(roomJid)
      }
      return
    }
    if (
      !initialRoomPassDone ||
      roomStore.getState().activeRoomJid === roomJid
    ) {
      return
    }
    await catchUpFreshSessionRoomOnce(
      roomJid,
      pendingHandoff.generation,
    )
  }

  async function reconcileFreshSessionRooms(
    generation: number,
  ): Promise<void> {
    const roomJids = new Set<string>()
    for (const [roomJid, pendingHandoff] of pendingRoomHandoffs) {
      if (pendingHandoff.generation !== generation) continue
      roomJids.add(roomJid)
    }
    const state = roomStore.getState()
    for (const room of state.joinedRooms()) {
      if (
        room.supportsMAM &&
        !room.isQuickChat &&
        room.jid !== state.activeRoomJid &&
        freshSessionJoinedRooms.has(room.jid) &&
        !mamHandledRooms.has(room.jid)
      ) {
        roomJids.add(room.jid)
      }
    }
    await executeWithConcurrency(
      [...roomJids],
      async (roomJid) => {
        if (pendingRoomHandoffs.has(roomJid)) {
          await drainPendingRoomHandoff(roomJid)
        } else {
          await catchUpFreshSessionRoomOnce(roomJid, generation)
        }
      },
      2,
    )
  }

  /**
   * Give one room its single resume seed, re-checking the resume predicate at
   * call time.
   *
   * The `'resumed'` handler evaluates `selectRoomsNeedingResumeSeed` once,
   * synchronously, against the rooms joined at that instant. Rooms that join
   * later in the same session — `handleSmResumption` re-fetches bookmarks after
   * a long disconnect and joins everything not currently joined — were never
   * offered to that predicate, and no other trigger covers them: the
   * `room:joined` catch-up and the late-MAM retry both require a FRESH session,
   * and the `mucJoined` preview fetch is skipped outright while SM-resumed. This
   * closes that hole by running the same predicate per room, as each one becomes
   * eligible.
   *
   * Deliberately still gated on `isCaughtUpToLive`: a room SM genuinely replayed
   * for is skipped, so this adds queries only for rooms whose archive coverage
   * was never established this session — never a blanket re-query on resume.
   */
  async function seedResumeRoomOnce(
    roomJid: string,
    generation: number,
  ): Promise<void> {
    if (!isResumedSession || generation !== sessionGeneration) return
    if (resumeSeededRooms.has(roomJid)) return
    if (connectionStore.getState().status !== 'online' || !client.isConnected()) {
      return
    }
    const state = roomStore.getState()
    const room = state.rooms.get(roomJid)
    if (!room) return
    const [eligible] = selectRoomsNeedingResumeSeed(
      [room],
      (jid) => state.getRoomMAMQueryState(jid).isCaughtUpToLive,
      state.activeRoomJid,
    )
    if (!eligible) return

    resumeSeededRooms.add(roomJid)
    logInfo(`Background sync: SM resumption — catching up late-joined room ${roomJid}`)
    try {
      await client.internal.mam.catchUpRoom(roomJid, sessionStartTime)
    } catch {
      // Best-effort, exactly like the resume pass this mirrors. The seed stays
      // recorded so a failing room can't be retried on every presence change;
      // the next session re-evaluates it from scratch.
    }
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
   * Conversation stages are serialized to cap their server load at ~2 concurrent
   * MAM queries. The delayed room pass is separately capped at concurrency 2.
   */
  function triggerBackgroundSync(): void {
    if (backgroundSyncDone) return
    backgroundSyncDone = true

    logInfo('Background sync: starting')

    // Read active entities — side effects already handle MAM for these
    const activeConversationId = chatStore.getState().activeConversationId

    // Serialized pipeline: catch-up → roster discovery → archived check
    void (async () => {
      try {
        // Stage 1: Conversation catch-up (skip active — handled by chatSideEffects)
        logInfo('Background sync: conversation catch-up')
        await client.internal.mam.catchUpAllConversations({ concurrency: 2, exclude: activeConversationId, sessionStartTime })

        // Stage 2: Roster discovery (hourly cooldown)
        if (shouldDiscoverRoster()) {
          logInfo('Background sync: roster discovery')
          await client.internal.mam.discoverNewConversationsFromRoster({ concurrency: 2 })
          markRosterDiscovered()
        }

        // Stage 3: Daily archived conversation check
        if (shouldCheckArchived()) {
          logInfo('Background sync: checking archived conversations')
          await client.internal.mam.refreshArchivedConversationPreviews()
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
    const syncGeneration = sessionGeneration
    roomCatchUpTimer = setTimeout(() => {
      roomCatchUpTimer = undefined
      void (async () => {
        try {
          logInfo('Background sync: room catch-up (delayed 10s)')
          // Only rooms that confirmed a join during THIS fresh session are
          // eligible: a `joined` flag rehydrated from persisted state is not
          // proof of current membership (#1149). The active room is owned by
          // roomSideEffects and read here, at pass time, so a room released
          // during the 10s window still gets covered.
          const activeRoomJid = roomStore.getState().activeRoomJid
          const candidates = roomStore.getState().joinedRooms()
            .filter((room) => (
              room.supportsMAM &&
              !room.isQuickChat &&
              room.jid !== activeRoomJid &&
              freshSessionJoinedRooms.has(room.jid)
            ))
          await executeWithConcurrency(
            candidates,
            async (room) => {
              await catchUpFreshSessionRoomOnce(room.jid, syncGeneration)
            },
            2,
          )
        } catch {
          // Silently ignore MAM catch-up errors
        }
        if (syncGeneration !== sessionGeneration) return
        initialRoomPassDone = true
        await reconcileFreshSessionRooms(syncGeneration)
        if (syncGeneration !== sessionGeneration) return
        // Same rationale as the 1:1 catch-up retry above: room messages stashed
        // during this delayed pass (encrypted MUC history fetched after a mid-sync
        // key unlock) would otherwise wait until the next launch. Re-run once room
        // catch-up settles. Coalesced with any in-flight pass.
        void client.retryPendingDecrypts()
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
              await client.rooms.queryRoomMembers(room.jid)
            }
          }
        } catch {
          // Silently ignore member discovery errors
        }
      })()
    }, MAM_ROOM_CATCHUP_DELAY_MS)
  }

  // A transport 'online' starts fresh-session sync. An uninterrupted resume can
  // also be followed by a synthetic 'online' when cache integrity forces full
  // setup; preserve the resume boundary and confirmed joins on that upgrade.
  const unsubscribeOnline = client.on('online', () => {
    const followsUninterruptedResume = uninterruptedResumeMayEmitSyntheticOnline
    uninterruptedResumeMayEmitSyntheticOnline = false
    sessionGeneration += 1
    backgroundSyncDone = false
    isFreshSession = true
    isResumedSession = false
    resumeSeededRooms.clear()
    if (!followsUninterruptedResume) {
      sessionStartTime = Date.now()
      invalidateRoomMemberships(client)
      freshSessionJoinedRooms.clear()
    }
    resetRoomRetryState()

    logInfo('Background sync: fresh session — checking MAM support')

    // Discover MAM fulltext search capability (non-blocking, doesn't affect sync)
    void client.server.discoverMAMSearchCapability()

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
  // needed for rooms already caught up to live. But the delayed fresh-session room
  // pass (Stage 4) never runs here, so a room NOT caught up to live this
  // session — an autojoined room the user never opened, or one whose forward
  // catch-up left an open gap (e.g. a flaky connection dropped before the 10s
  // fresh-session pass fired) — keeps an empty or stale sidebar preview until opened
  // manually. Catch up exactly those rooms, reusing catchUpRoom (its no-cursor path
  // is a `{ before: '' }` fetch-latest that populates the archive and sets the
  // preview; a gap-open room forward-fills from its recorded gap). Caught-up rooms
  // are skipped, so this stays out of SM's "server replays, no MAM" path.
  const unsubscribeResumed = client.on('resumed', () => {
    sessionGeneration += 1
    uninterruptedResumeMayEmitSyntheticOnline = true
    isFreshSession = false
    isResumedSession = true
    sessionStartTime = Date.now()
    freshSessionJoinedRooms.clear()
    resumeSeededRooms.clear()
    resetRoomRetryState()

    const resumeGeneration = sessionGeneration
    const state = roomStore.getState()
    const eligible = selectRoomsNeedingResumeSeed(
      state.joinedRooms(),
      (jid) => state.getRoomMAMQueryState(jid).isCaughtUpToLive,
      state.activeRoomJid,
    )
    if (eligible.length === 0) {
      // Says nothing about rooms not yet joined — the bookmark re-join runs
      // later in handleSmResumption and is covered by seedResumeRoomOnce.
      logInfo('Background sync: SM resumption — no already-joined room needs catch-up')
      return
    }

    logInfo(`Background sync: SM resumption — catching up ${eligible.length} not-caught-up room(s)`)
    void (async () => {
      for (const room of eligible) {
        if (!client.isConnected()) break
        await seedResumeRoomOnce(room.jid, resumeGeneration)
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
        sessionGeneration += 1
        uninterruptedResumeMayEmitSyntheticOnline = false
        isFreshSession = false
        isResumedSession = false
        freshSessionJoinedRooms.clear()
        resumeSeededRooms.clear()
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
      if (!client.isConnected()) return

      // A resumed session has no initial pass to wait for; its seed is per-room
      // and the same disco race applies, so cover it here too.
      if (isResumedSession) {
        for (const room of roomStore.getState().joinedRooms()) {
          if (!room.supportsMAM || room.isQuickChat) continue
          void seedResumeRoomOnce(room.jid, sessionGeneration)
        }
        return
      }

      // Only retry after the initial pass; before it, the pass will cover them.
      if (!initialRoomPassDone || !isFreshSession) return

      const activeRoomJid = roomStore.getState().activeRoomJid
      for (const room of roomStore.getState().joinedRooms()) {
        if (!room.supportsMAM || room.isQuickChat) continue
        if (!freshSessionJoinedRooms.has(room.jid)) continue
        if (mamHandledRooms.has(room.jid)) continue
        // The active room is handled by roomSideEffects' own supportsMAM watcher.
        if (room.jid === activeRoomJid) continue
        logInfo(`Background sync: late MAM-ready room — catching up ${room.jid}`)
        void catchUpFreshSessionRoomOnce(room.jid, sessionGeneration)
      }
    }
  )

  const unsubscribeRoomJoined = client.subscribe(
    'room:joined',
    ({ roomJid, joined }) => {
      if (!joined) {
        recordRoomMembership(client, roomJid, false)
        freshSessionJoinedRooms.delete(roomJid)
        mamHandledRooms.delete(roomJid)
        mamInFlightRooms.delete(roomJid)
        pendingRoomHandoffs.delete(roomJid)
        return
      }
      recordRoomMembership(client, roomJid, true)
      freshSessionJoinedRooms.add(roomJid)
      if (isResumedSession) {
        // Joined after the one-shot resume seed already ran — SM never replayed
        // this room's history, so it needs the seed the predicate couldn't offer.
        void seedResumeRoomOnce(roomJid, sessionGeneration)
        return
      }
      if (!initialRoomPassDone || !isFreshSession) return
      if (mamHandledRooms.has(roomJid)) return
      const room = roomStore.getState().rooms.get(roomJid)
      if (!room?.supportsMAM || room.isQuickChat) return
      if (roomStore.getState().activeRoomJid === roomJid) return
      void catchUpFreshSessionRoomOnce(roomJid, sessionGeneration)
    },
  )

  const unsubscribeRoomMamHandoff = subscribeRoomMamHandoff(
    client,
    (event) => {
      const { roomJid, membershipEpoch } = event
      if (event.state === 'completed') {
        const pendingHandoff = pendingRoomHandoffs.get(roomJid)
        if (pendingHandoff?.membershipEpoch === membershipEpoch) {
          pendingRoomHandoffs.delete(roomJid)
        }
        return
      }
      if (!isFreshSession) return
      if (membershipEpoch !== getRoomMembershipEpoch(client, roomJid)) {
        return
      }
      pendingRoomHandoffs.set(roomJid, {
        generation: sessionGeneration,
        membershipEpoch,
      })
      if (!initialRoomPassDone) {
        return
      }
      void drainPendingRoomHandoff(roomJid)
    },
  )

  const unsubscribeActiveRoom = roomStore.subscribe(
    (state) => state.activeRoomJid,
    (activeRoomJid, previousActiveRoomJid) => {
      if (
        !previousActiveRoomJid ||
        previousActiveRoomJid === activeRoomJid ||
        !pendingRoomHandoffs.has(previousActiveRoomJid)
      ) {
        return
      }
      void drainPendingRoomHandoff(previousActiveRoomJid)
    },
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
    sessionGeneration += 1
    mamInFlightRooms.clear()
    pendingRoomHandoffs.clear()
    unsubscribeOnline()
    unsubscribeResumed()
    unsubscribeConnection()
    unsubscribeServerInfo()
    unsubscribeRoomMAM()
    unsubscribeRoomJoined()
    unsubscribeRoomMamHandoff()
    unsubscribeActiveRoom()
    unsubscribePluginRegistered()
    unsubscribeKeyUnlocked()
    if (roomCatchUpTimer) {
      clearTimeout(roomCatchUpTimer)
      roomCatchUpTimer = undefined
    }
  }
}
