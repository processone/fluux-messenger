/**
 * XEP-0490 read-position publisher side effect.
 *
 * Watches local last-read advances (chatStore.conversationMeta.readPointer)
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
 * in-memory work is DROPPED on disconnect. A later genuine read advance can
 * publish; fresh-session seeding intentionally snapshots the current pointer
 * and is not a general retry queue.
 *
 * @module Core/MdsSideEffects
 */

import type { XMPPClient } from './XMPPClient'
import type { DisplayedMarker } from './modules/Mds'
import type { SideEffectsOptions } from './chatSideEffects'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { roomStore } from '../stores/roomStore'
import { createKeyedCoalescer } from '../utils/keyedCoalescer'
import { getBareJid } from './jid'
import { logInfo } from './logger'

/** Debounce window for read-position publishes (ms). */
const PUBLISH_DEBOUNCE_MS = 1_500

/**
 * Sets up the MDS read-position publisher side effect.
 *
 * @param client - The XMPPClient instance
 * @param options - Configuration options
 * @returns Unsubscribe function to clean up all subscriptions
 */
export function setupMdsSideEffects(
  client: XMPPClient,
  options: SideEffectsOptions = {}
): () => void {
  const { debug: _debug = false } = options

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  // Publishing is disabled until the fresh-session seed completes, so the seed
  // itself is never re-published.
  let syncEnabled = false
  // Dirty per-JID buffer (jid → stanzaId), latest-wins.
  const dirty = createKeyedCoalescer<string, string>()
  // Highest stanza-id we believe is on the node per JID (seed + our publishes).
  const lastKnownNodeStanzaId = new Map<string, string>()
  // The read-pointer message id we last HANDLED per JID, to detect advances.
  // "Handled" means the position was resolved to a stanza-id and then either
  // enqueued or judged not ahead of the node — never merely "seen". A position
  // that could not be resolved stays out of this map so a later merge retries
  // it (#1142); recording it would silence the position for good.
  const lastConsideredSeenId = new Map<string, string | undefined>()
  // Seed markers (jid → marker) whose JID was NOT a known room at seed time.
  // The fresh-session seed runs before bookmarks load (roomStore.rooms is empty),
  // so a room's marker would otherwise route to chat and be dropped. We stash it
  // here and re-apply it when roomStore.rooms gains the JID (self-heal). A stashed
  // marker also remembers whether it still needs a legacy-format migration.
  const unroutedSeedMarkers = new Map<string, { stanzaId: string; legacy: boolean }>()
  // Live conversation/room JIDs, to detect user deletes (retraction). Maintained
  // while disarmed; the removed delta is retracted only while armed (syncEnabled).
  let trackedJids = new Set<string>()

  /** Is this JID a known room (bookmarked or joined)? Routes accessors per-store. */
  function isRoom(jid: string): boolean {
    return roomStore.getState().rooms.has(jid)
  }

  /** Our own bare JID, or '' before the connection JID is known. */
  function ownBareJid(): string {
    const jid = connectionStore.getState().jid
    return jid ? getBareJid(jid) : ''
  }

  /**
   * XEP-0359 `by` for a conversation's stanza-ids: the archive that assigned
   * them — the room itself for MUC, our own server (bare JID) for 1:1.
   */
  function stanzaIdBy(jid: string): string {
    return isRoom(jid) ? jid : ownBareJid()
  }

  /**
   * Republish a legacy-format marker (pre-0.18 payload) in XEP-0490 format so
   * other clients can read it. Best-effort; the value is already correct
   * locally and on the node, only its shape is wrong.
   */
  function migrateLegacyMarker(jid: string, stanzaId: string): void {
    const by = stanzaIdBy(jid)
    if (!by) return
    client.mds.publishDisplayed(jid, stanzaId, by).catch(() => {
      // Best-effort — an unconverted marker is republished on the next advance.
    })
  }

  /** Index of a stanza-id in a conversation's/room's loaded messages, or -1. */
  function indexOfStanza(jid: string, stanzaId: string | undefined): number {
    if (!stanzaId) return -1
    const messages = isRoom(jid)
      ? roomStore.getState().roomRuntime.get(jid)?.messages ?? []
      : chatStore.getState().messages.get(jid) || []
    return messages.findIndex((m) => m.stanzaId === stanzaId)
  }

  /** Resolve the stanza-id of the message a conversation's/room's read pointer names. */
  function resolveSeenStanzaId(jid: string): string | undefined {
    if (isRoom(jid)) {
      const seenId = roomStore.getState().roomMeta.get(jid)?.readPointer?.messageId
      if (!seenId) return undefined
      const messages = roomStore.getState().roomRuntime.get(jid)?.messages ?? []
      const fromSlice = messages.find((m) => m.id === seenId)?.stanzaId
      if (fromSlice) return fromSlice
      // Non-active rooms keep no resident array (memory windowing); mark-all-read
      // points at the newest known message, whose stanza-id survives on the
      // lastMessage preview.
      const last = roomStore.getState().roomMeta.get(jid)?.lastMessage
        ?? roomStore.getState().rooms.get(jid)?.lastMessage
      return last?.id === seenId ? last.stanzaId : undefined
    }
    const seenId = chatStore.getState().conversationMeta.get(jid)?.readPointer?.messageId
    if (!seenId) return undefined
    const messages = chatStore.getState().messages.get(jid) || []
    const fromSlice = messages.find((m) => m.id === seenId)?.stanzaId
    if (fromSlice) return fromSlice
    // Same eviction fallback for backgrounded 1:1 conversations.
    const last = chatStore.getState().conversationMeta.get(jid)?.lastMessage
      ?? chatStore.getState().conversations.get(jid)?.lastMessage
    return last?.id === seenId ? last.stanzaId : undefined
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

    for (const { key: jid, value: stanzaId } of entries) {
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
        lastConsideredSeenId.delete(jid)
        continue
      }
      const by = stanzaIdBy(jid)
      if (!by) {
        // Own JID unknown (should not happen while online) — same re-arm.
        lastConsideredSeenId.delete(jid)
        continue
      }
      try {
        await client.mds.publishDisplayed(jid, stanzaId, by)
        lastKnownNodeStanzaId.set(jid, stanzaId)
      } catch {
        // Best-effort; keep the position handled as documented above.
      }
    }
  }

  /**
   * Is this entity's archive complete enough to speak for the user?
   *
   * Mirrors Gajim's `if not MAM.is_catch_up_finished(contact): return` guard.
   *
   * The original reason — "a read position derived mid-catch-up is computed
   * against a partial window" — no longer applies: catch-up stopped being a
   * pointer writer in read-state PR C, so no position originates here any more.
   *
   * The gate stays as a PUBLISH-SIDE backstop, which is a different and still
   * valid job. Every local writer that remains (viewport, remote marker,
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
    const mam = isRoom(jid)
      ? roomStore.getState().getRoomMAMQueryState(jid)
      : chatStore.getState().getMAMQueryState(jid)
    if (mam.error !== null) return false
    if (!mam.hasQueried && !mam.isLoading) return true // never queried — nothing partial
    return !mam.isLoading && mam.isCaughtUpToLive
  }

  /** Consider a conversation/room for publishing if its read position advanced. */
  function consider(jid: string): void {
    if (!syncEnabled) return
    // Catch-up gate: never publish a position derived from a partial archive.
    // Skipping leaves the de-dup key unchanged; MAM-state changes re-consider
    // the current pointer once catch-up becomes trustworthy.
    if (!archiveIsTrustworthy(jid)) return

    const seenId = isRoom(jid)
      ? roomStore.getState().roomMeta.get(jid)?.readPointer?.messageId
      : chatStore.getState().conversationMeta.get(jid)?.readPointer?.messageId
    if (seenId === lastConsideredSeenId.get(jid)) return

    const stanzaId = resolveSeenStanzaId(jid)
    // No resolvable stanza-id yet: the entity's resident array is evicted and
    // the pointer doesn't name the lastMessage preview. Leave the de-dup key
    // UNCOMMITTED so the next meta change re-runs this resolve — committing it
    // here would make every later call short-circuit on the equality check
    // above, and the position would never be enqueued nor reach the node
    // (#1142). The key means "this position is handled", not "we have seen it".
    if (!stanzaId) return

    // Resolved → handled from here on, whether we enqueue below or decide the
    // node is already at/ahead of it (a verdict that cannot flip: message order
    // within a slice is stable).
    lastConsideredSeenId.set(jid, seenId)

    // No regressive publish: only publish if strictly ahead (by message index)
    // of what we believe is already on the node for this JID.
    const nodeId = lastKnownNodeStanzaId.get(jid)
    if (nodeId) {
      const candidateIdx = indexOfStanza(jid, stanzaId)
      const nodeIdx = indexOfStanza(jid, nodeId)
      // When nodeIdx === -1 the node's high-water message is outside the loaded
      // window, so we can't prove the candidate is ahead — publish optimistically
      // and rely on the local marker being forward-only. A later genuine read
      // advance supersedes any rare backward node move.
      if (candidateIdx !== -1 && nodeIdx !== -1 && candidateIdx <= nodeIdx) return
    }

    dirty.add(jid, stanzaId)
    schedulePublish()
  }

  /** Current live set: 1:1 conversation entities ∪ known rooms. */
  function liveJids(): Set<string> {
    const s = new Set<string>()
    for (const jid of chatStore.getState().conversationEntities.keys()) s.add(jid)
    for (const jid of roomStore.getState().rooms.keys()) s.add(jid)
    return s
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
    lastConsideredSeenId.delete(jid)
    unroutedSeedMarkers.delete(jid)
    dirty.delete(jid)
  }

  /**
   * Detect user deletes and retract their MDS markers. Armed only while online
   * and synced; a wholesale clear (logout/reset) is treated as teardown and
   * retracts nothing.
   */
  function reconcileDeletions(): void {
    const current = liveJids()

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
        void client.mds.retractDisplayed(jid) // best-effort
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
    considerConversations
  )
  const unsubscribeMessages = chatStore.subscribe(
    (state) => state.messages,
    considerConversations
  )
  const unsubscribeConversationMam = chatStore.subscribe(
    (state) => state.mamQueryStates,
    considerConversations
  )
  const unsubscribeRoomMeta = roomStore.subscribe(
    (state) => state.roomMeta,
    considerRooms
  )
  const unsubscribeRoomRuntime = roomStore.subscribe(
    (state) => state.roomRuntime,
    considerRooms
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
  const unsubscribeOnline = client.on('online', () => {
    syncEnabled = false
    void (async () => {
      let markers: DisplayedMarker[] = []
      try {
        markers = await client.mds.fetchAllDisplayed()
      } catch {
        // Node may not exist yet — proceed with an empty seed.
      }

      // Reset the unrouted-marker stash for this seed (mirrors dirty.drop below).
      unroutedSeedMarkers.clear()

      for (const { conversationJid, stanzaId, legacy } of markers) {
        const bare = getBareJid(conversationJid)
        lastKnownNodeStanzaId.set(bare, stanzaId)
        // Route the seed by membership. The fresh-session seed runs BEFORE
        // bookmarks load (online fires before fetchBookmarks populates
        // roomStore.rooms), so a bookmarked room is typically NOT yet known
        // here. Its marker routes to chat (a harmless no-op on a non-existent
        // entity) AND is stashed so the rooms subscription below re-applies it
        // once the bookmark lands. A genuine 1:1 JID also lands in the else
        // branch and simply never drains — cleared on the next seed.
        //
        // Legacy-format items (pre-0.18 payload) are additionally republished
        // in spec format once the JID can be classified (`by` differs for
        // rooms vs 1:1): known rooms and known 1:1 entities migrate here;
        // stashed room markers migrate when their bookmark drains below. A
        // JID we can never classify keeps its legacy item until the next
        // local read advance overwrites it.
        if (isRoom(bare)) {
          roomStore.getState().applyRemoteDisplayed(bare, stanzaId)
          if (legacy) migrateLegacyMarker(bare, stanzaId)
        } else {
          chatStore.getState().applyRemoteDisplayed(bare, stanzaId)
          const migrateNow = !!legacy && chatStore.getState().conversationEntities.has(bare)
          if (migrateNow) migrateLegacyMarker(bare, stanzaId)
          unroutedSeedMarkers.set(bare, { stanzaId, legacy: !!legacy && !migrateNow })
        }
      }

      // Open the coalescer window for the publishing phase.
      dirty.drop()
      dirty.open()

      // Snapshot the current per-JID read positions (both stores) so the seed
      // isn't republished; only later advances past these will enqueue.
      lastConsideredSeenId.clear()
      for (const [jid, meta] of chatStore.getState().conversationMeta) {
        lastConsideredSeenId.set(jid, meta.readPointer?.messageId)
      }
      for (const [jid, meta] of roomStore.getState().roomMeta) {
        lastConsideredSeenId.set(jid, meta.readPointer?.messageId)
      }

      syncEnabled = true
      // Rebuild the delete-detection baseline to the current live set so the
      // fresh-session population is never seen as deletions.
      trackedJids = liveJids()
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
  const unsubscribeDisplayedSynced = client.subscribe(
    'read:displayed-synced',
    ({ conversationId, stanzaId }) => {
      lastKnownNodeStanzaId.set(getBareJid(conversationId), stanzaId)
    }
  )

  // SM resumption: server replays notifications; keep publishing enabled, no reseed.
  const unsubscribeResumed = client.on('resumed', () => {
    dirty.open()
    syncEnabled = true
    // Rebuild the delete-detection baseline to the current live set (mirrors the
    // fresh-session handler) so a resume's known entities aren't seen as deletes.
    trackedJids = liveJids()
  })

  // On disconnect: DROP pending work and cancel the timer. The canonical pointer
  // remains in localStorage; see the module contract for retry semantics.
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
        syncEnabled = false
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
    unsubscribeConversationMeta()
    unsubscribeMessages()
    unsubscribeConversationMam()
    unsubscribeRoomMeta()
    unsubscribeRoomRuntime()
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
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }
}
