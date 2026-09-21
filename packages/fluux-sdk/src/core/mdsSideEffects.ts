/**
 * XEP-0490 read-position publisher side effect.
 *
 * Watches local readPointer advances in chat and room metadata
 * and publishes the resolved stanza-id per conversation to the MDS PEP node,
 * debounced and coalesced per-JID (latest-wins). Never publishes a regressive
 * marker. On a fresh session it first seeds from the node (applying each marker
 * locally and recording the node high-water mark) before enabling publishing, so
 * the seed isn't re-published. On SM resumption the server replays notifications,
 * so no reseed is needed.
 *
 * The fresh-session seed runs on the client `online` event, which fires BEFORE
 * bookmarks load (roomStore.rooms is still empty). A room marker would therefore
 * route to chat and be dropped. To self-heal, room markers seen at seed time for
 * a JID that isn't yet a known room are stashed and re-applied once
 * roomStore.rooms gains that JID (bookmark loaded later in the same session).
 *
 * localStorage remains the durable source for read positions, but pending
 * in-memory work is DROPPED on disconnect. The fresh-session seed therefore
 * re-considers every entity once publishing is armed, so a position the previous
 * session never managed to publish is retried without waiting for a further
 * local read advance (#1145).
 *
 * Pointer resolution follows docs/MESSAGE_IDENTIFIERS.md, section 4. Async
 * resolution runs through `consider()` as a LATEST-WINS SERIAL DRAIN per JID
 * and revalidates every input after the await; see `consider`/`considerOnce`.
 *
 * @module Core/MdsSideEffects
 */

import type { SideEffectHost } from './sideEffectHost'
import type { DisplayedMarker, DisplayedMarkerFetchResult } from './modules/Mds'
import type { SideEffectsOptions } from './chatSideEffects'
import type { RoomMessage } from './types/room'
import { chatReadTracker, chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { roomReadTracker, roomStore } from '../stores/roomStore'
import {
  conversationKind,
  conversationMessages,
  conversationMetadata,
  conversationHistoryState,
  conversationIds,
} from '../stores/conversationLens'
import { createKeyedCoalescer } from '../utils/keyedCoalescer'
import { type ReadPointer } from '../stores/shared/readPointer'
import type { PublishPosition } from '../stores/readTracker'
import { getRoomModerationId } from '../utils/roomStanzaId'
import { getBareJid } from './jid'
import { beginLocallyPublishedDisplayed } from './localMdsPublishes'
import { logInfo } from './logger'
import { getStorageScopeJid } from '../utils/storageScope'

/** Debounce window for read-position publishes (ms). */
const PUBLISH_DEBOUNCE_MS = 1_500


function isDefinitivePublishRejection(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === 'StanzaError'
}

/**
 * Sets up the MDS read-position publisher side effect.
 *
 * @param client - The client driving these side effects
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up all subscriptions
 */
export function setupMdsSideEffects(
  client: SideEffectHost,
  options: SideEffectsOptions = {}
): () => void {
  const { debug: _debug = false } = options

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  // Publishing is disabled until the fresh-session seed completes, so the seed
  // itself is never re-published.
  let syncEnabled = false
  // Dirty per-JID buffer (jid → exact publish position), latest-wins.
  type ResolvedPublish = PublishPosition

  /** The read position to publish, resolved by the entity's read tracker. */
  const resolveSeenPosition = (jid: string): Promise<ResolvedPublish | undefined> =>
    (isRoom(jid) ? roomReadTracker : chatReadTracker).resolvePublishPosition(jid)
  const dirty = createKeyedCoalescer<string, ResolvedPublish>()
  // Highest stanza-id we believe is on the node per JID (seed + our publishes).
  const lastKnownNodeStanzaId = new Map<string, string>()
  const lastKnownNodeRevision = new Map<string, number>()
  let nodeRevision = 0
  let nodeSnapshotAuthoritative = false
  const currentSessionConfirmedNodeJids = new Set<string>()
  // The full read-pointer identity we last HANDLED per JID, to detect advances.
  // "Handled" means the position was resolved to a stanza-id and then either
  // enqueued or judged not ahead of the node — never merely "seen". A position
  // that could not be resolved stays out of this map so a later merge retries
  // it (#1142); recording it would silence the position for good.
  const lastConsideredPointerIdentity = new Map<string, string>()
  // Seed markers (jid → marker) whose JID was NOT a known room at seed time.
  // The fresh-session seed runs before bookmarks load (roomStore.rooms is empty),
  // so a room's marker would otherwise route to chat and be dropped. We stash it
  // here and re-apply it when roomStore.rooms gains the JID (self-heal). A stashed
  // marker also remembers whether it still needs a legacy-format migration.
  const unroutedSeedMarkers = new Map<string, { stanzaId: string; legacy: boolean }>()
  // Live conversation/room JIDs, to detect user deletes (retraction). Maintained
  // while disarmed; the removed delta is retracted only while armed (syncEnabled).
  let trackedJids = new Set<string>()
  // Latest-wins serial drain state: the JIDs whose resolution is in flight, and
  // the JIDs owed another pass because they changed during one. See consider().
  const resolutionInFlight = new Set<string>()
  const resolutionOwed = new Set<string>()
  const pendingLegacyMigrations = new Map<string, string>()
  // Bumped whenever the session boundary moves (fresh seed, disconnect). A
  // resolution that spans a bump was ordered against node state the new session
  // has re-derived, so it is discarded rather than published.
  let sessionEpoch = 0
  // Set by the returned teardown, so a resolution still in flight cannot publish
  // after the side effect has been unsubscribed.
  let disposed = false

  function recordKnownNodeStanzaId(jid: string, stanzaId: string): void {
    lastKnownNodeStanzaId.set(jid, stanzaId)
    lastKnownNodeRevision.set(jid, ++nodeRevision)
    currentSessionConfirmedNodeJids.add(jid)
  }

  /** Is this JID a known room (bookmarked or joined)? */
  function isRoom(jid: string): boolean {
    return conversationKind(jid) === 'room'
  }

  /** Our own bare JID, or '' before the connection JID is known. */
  function ownBareJid(): string {
    const jid = connectionStore.getState().jid
    return jid ? getBareJid(jid) : ''
  }


  function stanzaIdBy(jid: string): string {
    return isRoom(jid) ? jid : ownBareJid()
  }

  /**
   * Republish a legacy-format marker (pre-0.17.1 payload) in XEP-0490 format so
   * other clients can read it. Best-effort; the value is already correct
   * locally and on the node, only its shape is wrong.
   */
  function migrateLegacyMarker(jid: string, stanzaId: string): void {
    const by = stanzaIdBy(jid)
    if (!by) return
    pendingLegacyMigrations.delete(jid)
    // No publish claim here. Migration rewrites the PAYLOAD of a marker another client wrote; the
    // position it carries is that client's reading, not ours. Claiming it would make this client
    // suppress the very marker it just republished, and the divider would ignore a position it
    // should follow.
    void client.internal.mds.publishDisplayed(jid, stanzaId, by).catch(() => {
      // Best-effort — an unconverted marker is republished on the next advance.
    })
  }

  function retryLegacyMigrations(): void {
    if (disposed || !syncEnabled || connectionStore.getState().status !== 'online') return
    for (const [jid, stanzaId] of pendingLegacyMigrations) {
      migrateLegacyMarker(jid, stanzaId)
    }
  }

  /** The message as a row of room `jid`, or undefined when it is not one. */
  function asRoomRow(message: unknown, jid: string): RoomMessage | undefined {
    const row = message as RoomMessage
    return row.roomJid === jid ? row : undefined
  }

  /** Index of a stanza-id in a conversation's/room's loaded messages, or -1. */
  function indexOfStanza(jid: string, stanzaId: string | undefined): number {
    if (!stanzaId) return -1
    return conversationMessages(jid).findIndex(m => {
      if (m.stanzaId !== stanzaId) return false
      if (!isRoom(jid)) return true
      const row = asRoomRow(m, jid)
      return !!row && getRoomModerationId(row, ownBareJid()) === stanzaId
    })
  }

  /**
   * The remote marker this entity has STASHED, if any.
   *
   * `readMarkerSync` records `pendingRemoteDisplayedStanzaId` exactly when the
   * loaded slice could not order an incoming XEP-0490 marker against the local
   * read pointer, so a value here means "the node may be ahead of us and we
   * cannot tell".
   */
  function pendingRemoteDisplayed(jid: string): string | undefined {
    return conversationMetadata(jid)?.pendingRemoteDisplayedStanzaId
  }

  /**
   * What to do with a resolved local position for `jid`:
   *
   * - `publish` — strictly ahead of what we believe the node holds, or an
   *   authoritative snapshot proves the node holds nothing for this JID.
   * - `skip` — at or behind the node; handled, nothing to send.
   * - `retry` — we cannot PROVE the position is not regressive. The caller must
   *   leave it unhandled so a later merge or activation fold re-considers it.
   *
   * The last case is the whole point of this helper. When either side is off the
   * loaded slice, index order proves nothing, and MDS positions are forward-only:
   * publishing a position that happens to be BEHIND the node moves every other
   * device backward, unrecoverably. What still makes an off-slice node value safe
   * to overwrite is that we have ORDERED it against our pointer at some point:
   * `applyRemoteDisplayed` is forward-only, so a marker it RESOLVED left our
   * pointer at or past it, and the local pointer only ever advances from there —
   * the same forward-only local marker the exact-equal skip in `doPublish` relies
   * on. A marker it could NOT order is still stashed on the entity, and that is
   * the one value we must never publish over.
   */
  function publishDecision(jid: string, stanzaId: string): 'publish' | 'skip' | 'retry' {
    // A failed fresh-session read makes every prior-session entry unproven.
    // Until an authoritative reconnect or a current-session live update confirms
    // a JID, its position stays unpublished: delay is recoverable, overwriting a
    // newer forward-only MDS marker is not.
    if (!nodeSnapshotAuthoritative && !currentSessionConfirmedNodeJids.has(jid)) return 'retry'

    const nodeId = lastKnownNodeStanzaId.get(jid)
    if (!nodeId) return nodeSnapshotAuthoritative ? 'publish' : 'retry'

    const candidateIdx = indexOfStanza(jid, stanzaId)
    const nodeIdx = indexOfStanza(jid, nodeId)
    if (candidateIdx !== -1 && nodeIdx !== -1) {
      return candidateIdx > nodeIdx ? 'publish' : 'skip'
    }
    return pendingRemoteDisplayed(jid) === nodeId ? 'retry' : 'publish'
  }

  function readPointer(jid: string): ReadPointer | undefined {
    return conversationMetadata(jid)?.readPointer
  }

  /**
   * The de-dup key for "we have already handled THIS position".
   *
   * Covers the identity as well as the order, deliberately: a `local` pointer
   * that converges to `addressable` is the SAME position with a better name, and
   * that is exactly the change that makes it publishable. Keying on the order
   * alone would short-circuit the pass that should finally send it.
   */
  function pointerIdentity(pointer: ReadPointer | undefined): string | undefined {
    if (!pointer) return undefined
    return JSON.stringify([pointer.identity, pointer.order])
  }

  /**
   * Schedule a debounced publish. Resets the timer on each call so a burst of
   * advances coalesces into a single flush.
   */
  function schedulePublish(): void {
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined
      void doPublish()
    }, PUBLISH_DEBOUNCE_MS)
  }

  /**
   * Flush the dirty buffer and publish each entry to the MDS node.
   * A failed publish stays handled; a later genuine read advance supersedes it
   * instead of retrying the same failing IQ on every metadata change.
   */
  async function doPublish(): Promise<void> {
    if (!syncEnabled) return
    if (connectionStore.getState().status !== 'online') return

    const entries = dirty.flush()
    // Reopen the window immediately so advances during the awaits below buffer.
    dirty.open()

    for (const { key: jid, value: publish } of entries) {
      const { stanzaId, readPointer } = publish
      // Skip when the node already holds exactly this stanza-id: it is the echo
      // of a remote notify (recorded by the read:displayed-synced subscription
      // below) or a redundant re-enqueue. The local marker is forward-only, so
      // re-asserting a value the node already has is always pointless.
      if (lastKnownNodeStanzaId.get(jid) === stanzaId) continue
      // Re-check the catch-up gate at FLUSH time, not just at enqueue: the
      // debounce window is long enough for a catch-up to start after the
      // position was buffered, and it is the publish itself that must never
      // speak from a partial archive.
      //
      // Re-arm rather than discard (#1143). The entry has already left the
      // coalescer via flush() and consider() marked this position handled when
      // it enqueued, so nothing would ever put it back. Dropping the de-dup key
      // instead of re-adding to `dirty` avoids clobbering a newer position
      // buffered during the awaits above: the next meta change re-considers the
      // CURRENT pointer and re-checks this gate then.
      if (!archiveIsTrustworthy(jid)) {
        lastConsideredPointerIdentity.delete(jid)
        continue
      }
      const by = stanzaIdBy(jid)
      if (!by) {
        // Own JID unknown (should not happen while online) — same re-arm.
        lastConsideredPointerIdentity.delete(jid)
        continue
      }
      const decision = publishDecision(jid, stanzaId)
      if (decision === 'retry') {
        lastConsideredPointerIdentity.delete(jid)
        continue
      }
      if (decision === 'skip') continue
      const accountJid = ownBareJid()
      const claim = beginLocallyPublishedDisplayed(accountJid, jid, readPointer)
      try {
        await client.internal.mds.publishDisplayed(jid, stanzaId, by)
        claim.settle('published')
        recordKnownNodeStanzaId(jid, stanzaId)
      } catch (error) {
        claim.settle(isDefinitivePublishRejection(error) ? 'rejected' : 'ambiguous')
      }
    }
  }

  /**
   * Is this entity's archive complete enough to speak for the user?
   *
   * Mirrors Gajim's `if not MAM.is_catch_up_finished(contact): return` guard.
   *
   * The gate is not about where a read position comes from: catch-up writes no
   * pointer, so no position originates here.
   *
   * It is a PUBLISH-SIDE backstop instead. Every local writer that remains (viewport, remote marker,
   * mark-read) can fire while the archive is incomplete. A publish here reaches
   * this account's other devices too: `publishDisplayed` writes the XEP-0490 PEP
   * node, which pushes to every subscribed resource, and a peer's marker (or our
   * own echoed back) arrives locally as `read:displayed-synced` below. What a
   * receiving client DOES with that marker is its own decision, not a protocol
   * guarantee — but THIS client applies an inbound marker forward-only
   * (`resolveAdvance` in `readMarkerSync.ts`), so a too-far-ahead position we
   * publish from a partial archive cannot be walked back here once it returns to
   * us as a remote notify. Speaking for the user from an archive we know is
   * partial is the one thing this gate prevents, independently of where the
   * position came from.
   *
   * A failed query is not trustworthy even when it is no longer loading and
   * has not completed before. A later successful merge clears the error and
   * re-enters the normal completion rules.
   *
   * An entity that has NEVER been queried is allowed through: a conversation or
   * room created live during the session has no half-downloaded archive to
   * misreport, and gating it would silence read sync for new conversations
   * entirely.
   */
  function archiveIsTrustworthy(jid: string): boolean {
    const mam = conversationHistoryState(jid)
    if (mam.error !== null) return false
    if (!mam.hasQueried && !mam.isLoading) return true // never queried — nothing partial
    return !mam.isLoading && mam.isCaughtUpToLive
  }

  /**
   * One consideration pass for a conversation/room: resolve its read position
   * and enqueue it if it advanced.
   *
   * Resolution can touch IndexedDB, so this is async and every input it was
   * computed against is revalidated after the await. A change to any of them
   * invalidates the in-flight result INSTEAD of publishing it: the de-dup key
   * stays uncommitted, so the position is re-considered rather than silenced.
   * The account checks are not hypothetical — a cross-account pointer write of
   * this shape was found during #1155.
   */
  async function considerOnce(jid: string): Promise<void> {
    if (!syncEnabled) return
    // Catch-up gate: never publish a position derived from a partial archive.
    // Skipping leaves the de-dup key unchanged; MAM-state changes re-consider
    // the current pointer once catch-up becomes trustworthy.
    if (!archiveIsTrustworthy(jid)) return

    const pointer = readPointer(jid)
    const identity = pointerIdentity(pointer)
    if (!identity || identity === lastConsideredPointerIdentity.get(jid)) return

    // Captured BEFORE the await, compared after it.
    const epoch = sessionEpoch
    const scope = getStorageScopeJid()
    const owner = ownBareJid()
    const wasRoom = isRoom(jid)

    const publish = await resolveSeenPosition(jid)

    // Teardown, or a session that ended or restarted (a new seed re-derives the
    // node state this result was ordered against).
    if (disposed) return
    if (!syncEnabled || sessionEpoch !== epoch) return
    if (connectionStore.getState().status !== 'online') return
    // Account: the storage scope the cache was read under, and the JID we would
    // publish as. Either changing means this value belongs to another account.
    if (getStorageScopeJid() !== scope || ownBareJid() !== owner) return
    // Classification: a bookmark landing mid-flight moves the entity to the room
    // stores and changes the XEP-0359 `by` we would publish under.
    if (isRoom(jid) !== wasRoom) return
    // The position itself: a newer pointer supersedes this one. The store
    // subscription that moved it has already asked for another pass.
    if (pointerIdentity(readPointer(jid)) !== identity) return
    if (!archiveIsTrustworthy(jid)) return

    // No resolvable stanza-id: neither the resident slice nor the cache can
    // address the pointer — in 1:1 the permanent state when the whole tail is
    // our own unarchived sends. Leave the de-dup key UNCOMMITTED so the next
    // meta change re-runs this resolve — committing it here would make every
    // later call short-circuit on the equality check above, and the position
    // would never be enqueued nor reach the node (#1142). The key means "this
    // position is handled", not "we have seen it".
    if (!publish) return
    const { stanzaId } = publish

    // No regressive publish: only publish when we can show the position is not
    // behind what we believe is already on the node for this JID.
    const decision = publishDecision(jid, stanzaId)
    // Unprovable → leave the de-dup key UNCOMMITTED (same contract as the
    // unresolved case above), so the merge or activation fold that resolves the
    // stashed marker re-considers this position instead of silencing it.
    if (decision === 'retry') return

    // Resolved AND ordered → handled from here on, whether we enqueue below or
    // decide the node is already at/ahead of it. Enqueued positions are checked
    // again at flush time because live node state can change during the debounce.
    lastConsideredPointerIdentity.set(jid, identity)
    if (decision === 'skip') return

    dirty.add(jid, publish)
    schedulePublish()
  }

  /**
   * Consider a conversation/room, serialised per JID with LATEST-WINS semantics.
   *
   * At most one resolution is in flight per JID; a call arriving during it marks
   * another pass as owed and the drain re-runs when the current one finishes.
   *
   * A bare in-flight guard — suppressing the second call — would be WRONG: A is
   * in flight, B arrives and is dropped, A completes, and nothing ever retries
   * B. The position B named would then never be published, which is exactly the
   * failure #1142 fixed. Re-running is what keeps it latest-wins: the rerun
   * re-reads the CURRENT pointer, so the newest position is the one considered,
   * however many were coalesced into the one owed pass.
   */
  function consider(jid: string): void {
    if (!syncEnabled) return
    if (resolutionInFlight.has(jid)) {
      resolutionOwed.add(jid)
      return
    }
    resolutionInFlight.add(jid)
    void (async () => {
      try {
        do {
          // Cleared BEFORE the pass so a request arriving DURING it is kept.
          resolutionOwed.delete(jid)
          await considerOnce(jid)
        } while (resolutionOwed.has(jid) && !disposed)
      } finally {
        resolutionInFlight.delete(jid)
        resolutionOwed.delete(jid)
      }
    })()
  }

  /**
   * Forget a JID's in-memory publisher state so a retract/recreate is clean.
   * `dirty.delete` drops a still-buffered (debounced) publish; a publish that
   * already flushed and is awaiting its IQ can still win the race and re-assert
   * the marker after the retract. That is an accepted best-effort limitation of
   * retract ordering.
   */
  function evictJid(jid: string): void {
    lastKnownNodeStanzaId.delete(jid)
    lastKnownNodeRevision.delete(jid)
    currentSessionConfirmedNodeJids.delete(jid)
    lastConsideredPointerIdentity.delete(jid)
    unroutedSeedMarkers.delete(jid)
    resolutionOwed.delete(jid)
    dirty.delete(jid)
  }

  /**
   * Detect user deletes and retract their MDS markers. Armed only while online
   * and synced; a wholesale clear (logout/reset) is treated as teardown and
   * retracts nothing.
   */
  function reconcileDeletions(): void {
    const current = conversationIds()

    if (!syncEnabled || connectionStore.getState().status !== 'online') {
      trackedJids = current // keep baseline synced while disarmed; never retract
      return
    }
    // Wholesale clear (logout/reset/account switch): MANY entities vanish in one
    // tick while still online+synced (e.g. chatStore.reset()). Never mass-retract.
    // A single entity going to empty is a genuine delete of the last conversation
    // (the size-1 baseline), so the guard requires the baseline to have held >1 —
    // sequential one-at-a-time deletes each still retract.
    if (current.size === 0 && trackedJids.size > 1) {
      trackedJids = current
      return
    }
    for (const jid of trackedJids) {
      if (!current.has(jid)) {
        evictJid(jid)
        void client.internal.mds.retractDisplayed(jid) // best-effort
      }
    }
    trackedJids = current
  }

  function considerConversations(): void {
    if (!syncEnabled) return
    for (const jid of chatStore.getState().conversationMeta.keys()) {
      consider(jid)
    }
  }

  function considerRooms(): void {
    if (!syncEnabled) return
    for (const jid of roomStore.getState().roomMeta.keys()) {
      consider(jid)
    }
  }

  const unsubscribeConversationMeta = chatStore.subscribe(
    (state) => state.conversationMeta,
    () => {
      considerConversations()
      retryLegacyMigrations()
    }
  )
  const unsubscribeMessages = chatStore.subscribe(
    (state) => state.messages,
    () => {
      considerConversations()
      retryLegacyMigrations()
    }
  )
  const unsubscribeConversationMam = chatStore.subscribe(
    (state) => state.mamQueryStates,
    considerConversations
  )
  const unsubscribeRoomMeta = roomStore.subscribe(
    (state) => state.roomMeta,
    () => {
      considerRooms()
      retryLegacyMigrations()
    }
  )
  // The window, not the runtime blob: occupancy churn has no bearing on where
  // the read marker sits, and this now mirrors the chat subscription above.
  const unsubscribeRoomMessages = roomStore.subscribe(
    (state) => state.messages,
    () => {
      considerRooms()
      retryLegacyMigrations()
    }
  )
  const unsubscribeRoomMam = roomStore.subscribe(
    (state) => state.mamQueryStates,
    considerRooms
  )

  // Self-heal for the seed-before-bookmarks ordering. The fresh-session seed
  // runs before bookmarks populate roomStore.rooms, so room markers stash in
  // unroutedSeedMarkers. When rooms gains a stashed JID (bookmark loaded later
  // in the same session), re-apply its seed marker to the room and drop it.
  // applyRemoteDisplayed is forward-only/idempotent, and lastKnownNodeStanzaId[jid]
  // was already recorded during the seed, so the resulting roomMeta change is
  // echo-suppressed by consider()/doPublish — no republish, no loop.
  const unsubscribeRoomsSeedDrain = roomStore.subscribe(
    (state) => state.rooms,
    () => {
      if (unroutedSeedMarkers.size === 0) return
      const rooms = roomStore.getState().rooms
      // Collect-then-apply: applyRemoteDisplayed writes the combined `rooms` map,
      // which re-fires this subscription synchronously. Delete each entry from the
      // stash BEFORE applying so a re-entrant pass finds nothing to redo.
      const drainable: Array<[string, { stanzaId: string; legacy: boolean }]> = []
      for (const [jid, marker] of unroutedSeedMarkers) {
        if (rooms.has(jid)) drainable.push([jid, marker])
      }
      for (const [jid] of drainable) unroutedSeedMarkers.delete(jid)
      for (const [jid, { stanzaId, legacy }] of drainable) {
        roomStore.getState().applyRemoteDisplayed(jid, stanzaId)
        // The JID is now classified as a room → a legacy item can be migrated.
        if (legacy) migrateLegacyMarker(jid, stanzaId)
      }
    }
  )

  // Detect user deletes (a JID leaving the live set) and retract its marker.
  // Separate from the seed-drain rooms subscription above: distinct concern,
  // both firing on a `rooms` change is fine. reconcileDeletions self-guards
  // (disarmed → only re-syncs the baseline; wholesale clear → retracts nothing).
  const unsubscribeChatEntities = chatStore.subscribe(
    (state) => state.conversationEntities,
    () => reconcileDeletions()
  )
  const unsubscribeRoomEntities = roomStore.subscribe(
    (state) => state.rooms,
    () => reconcileDeletions()
  )

  // Fresh session: seed from the node, then enable publishing. Publishing stays
  // disabled for the whole async seed so the seeded positions aren't republished.
  const unsubscribeOnline = client.internal.on('online', () => {
    syncEnabled = false
    sessionEpoch++
    nodeSnapshotAuthoritative = false
    currentSessionConfirmedNodeJids.clear()
    pendingLegacyMigrations.clear()
    void (async () => {
      const seedStartedAtRevision = nodeRevision
      let result: DisplayedMarkerFetchResult
      try {
        result = await client.internal.mds.fetchAllDisplayedResult()
      } catch {
        result = { status: 'unknown' }
      }

      dirty.drop()
      dirty.open()
      lastConsideredPointerIdentity.clear()

      if (result.status === 'unknown') {
        syncEnabled = true
        trackedJids = conversationIds()
        logInfo('MDS: node state unavailable; publishing remains guarded')
        return
      }

      // Keyed by the verbatim item id, as the live notify binding routes it. XEP-0490 names a
      // private conversation with a room occupant by the occupant's full JID and fills it with a
      // stanza-id from the account's own archive: folded onto the bare room JID it would stand in
      // for the room's marker, one the room can never order, on every fresh session.
      const effectiveMarkers = new Map<string, DisplayedMarker>()
      for (const marker of result.markers) {
        effectiveMarkers.set(marker.conversationJid, marker)
      }
      for (const [jid, revision] of lastKnownNodeRevision) {
        if (revision <= seedStartedAtRevision) continue
        const stanzaId = lastKnownNodeStanzaId.get(jid)
        if (stanzaId) effectiveMarkers.set(jid, { conversationJid: jid, stanzaId })
      }

      lastKnownNodeStanzaId.clear()
      lastKnownNodeRevision.clear()
      for (const [jid, { stanzaId }] of effectiveMarkers) {
        recordKnownNodeStanzaId(jid, stanzaId)
      }
      nodeSnapshotAuthoritative = true
      unroutedSeedMarkers.clear()

      for (const [jid, { stanzaId, legacy }] of effectiveMarkers) {
        // Route the seed by membership. The fresh-session seed runs BEFORE
        // bookmarks load (online fires before fetchBookmarks populates
        // roomStore.rooms), so a bookmarked room is typically NOT yet known
        // here. Its marker routes to chat (a harmless no-op on a non-existent
        // entity) AND is stashed so the rooms subscription below re-applies it
        // once the bookmark lands. A genuine 1:1 JID also lands in the else
        // branch and simply never drains — cleared on the next seed.
        //
        // Legacy-format items (pre-0.17.1 payload) are additionally republished
        // in spec format once the JID can be classified (`by` differs for
        // rooms vs 1:1): known rooms and known 1:1 entities migrate here;
        // stashed room markers migrate when their bookmark drains below. A
        // JID we can never classify keeps its legacy item until the next
        // local read advance overwrites it.
        if (isRoom(jid)) {
          roomStore.getState().applyRemoteDisplayed(jid, stanzaId)
          if (legacy) migrateLegacyMarker(jid, stanzaId)
        } else {
          chatStore.getState().applyRemoteDisplayed(jid, stanzaId)
          const migrateNow = !!legacy && chatStore.getState().conversationEntities.has(jid)
          if (migrateNow) migrateLegacyMarker(jid, stanzaId)
          if (getBareJid(jid) === jid) {
            unroutedSeedMarkers.set(jid, { stanzaId, legacy: !!legacy && !migrateNow })
          }
        }
      }

      // A fresh session starts with NOTHING recorded as handled.
      //
      // Deliberately not a re-snapshot of the current pointers from both
      // stores: that would re-record an UNPUBLISHED position as handled,
      // consider() would short-circuit on it for the whole session, and only a
      // further local read advance could recover it (#1145). The seed does not
      // need that snapshot to avoid republishing itself — `lastKnownNodeStanzaId` was just
      // set for every node marker, so publishDecision() answers `skip` for a
      // position the node already holds and `retry` for one it holds a marker we
      // could not order against.
      syncEnabled = true
      // Rebuild the delete-detection baseline to the current live set so the
      // fresh-session population is never seen as deletions.
      trackedJids = conversationIds()
      // Sweep once now that publishing is armed. Every entity is re-considered
      // against the freshly seeded node state, so a position the previous session
      // never managed to publish goes out now instead of waiting for incidental
      // store churn to happen to re-consider it. Positions the node already holds
      // cost nothing here — publishDecision() skips them without an IQ.
      considerConversations()
      considerRooms()
      retryLegacyMigrations()
      logInfo('MDS: seeded read positions and enabled publishing')
    })()
  })

  // Live remote notify: a peer device published a new read position. The
  // storeBindings binding applies it (advancing the read pointer, which fires
  // our conversationMeta subscription → consider()). Record the node high-water
  // mark here so the no-regressive guard / exact-equal skip recognises the echo
  // and we don't re-publish the exact marker we just received. Handler order
  // within a single emit isn't guaranteed, but doPublish runs ~1500ms later by
  // which time this value is recorded, so the exact-equal skip drops the echo.
  // Keyed by the verbatim item id, like the seed: a private-message item under a
  // room's JID must not overwrite what the room's own item is known to hold.
  const unsubscribeDisplayedSynced = client.subscribe(
    'read:displayed-synced',
    ({ conversationId, stanzaId }) => {
      recordKnownNodeStanzaId(conversationId, stanzaId)
      consider(conversationId)
    }
  )

  // SM resumption: server replays notifications; keep publishing enabled, no reseed.
  const unsubscribeResumed = client.internal.on('resumed', () => {
    dirty.open()
    lastConsideredPointerIdentity.clear()
    syncEnabled = true
    // Rebuild the delete-detection baseline to the current live set (mirrors the
    // fresh-session handler) so a resume's known entities aren't seen as deletes.
    trackedJids = conversationIds()
    considerConversations()
    considerRooms()
    retryLegacyMigrations()
  })

  // On disconnect: DROP pending work and cancel the timer. The canonical pointer
  // remains in localStorage; see the module contract for retry semantics.
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
        syncEnabled = false
        sessionEpoch++
        // Clear the delete-detection baseline: a teardown is not a delete.
        trackedJids = new Set()
        dirty.drop()
        unroutedSeedMarkers.clear()
        if (debounceTimer) {
          clearTimeout(debounceTimer)
          debounceTimer = undefined
        }
      }
      previousStatus = status
    }
  )

  return () => {
    disposed = true
    resolutionOwed.clear()
    unsubscribeConversationMeta()
    unsubscribeMessages()
    unsubscribeConversationMam()
    unsubscribeRoomMeta()
    unsubscribeRoomMessages()
    unsubscribeRoomMam()
    unsubscribeRoomsSeedDrain()
    unsubscribeChatEntities()
    unsubscribeRoomEntities()
    unsubscribeOnline()
    unsubscribeDisplayedSynced()
    unsubscribeResumed()
    unsubscribeConnection()
    dirty.drop()
    unroutedSeedMarkers.clear()
    pendingLegacyMigrations.clear()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }
}
