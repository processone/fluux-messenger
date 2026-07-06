/**
 * XEP-0490 read-position publisher side effect.
 *
 * Watches local last-read advances (chatStore.conversationMeta.lastSeenMessageId)
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
 * localStorage remains the durable buffer for read positions: pending in-memory
 * work is DROPPED on disconnect and re-published (ahead-of-node only) on the next
 * fresh session.
 *
 * @module Core/MdsSideEffects
 */

import type { XMPPClient } from './XMPPClient'
import type { DisplayedMarker } from './modules/Mds'
import type { SideEffectsOptions } from './chatSideEffects'
import { chatStore, connectionStore, roomStore } from '../stores'
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
  // The lastSeenMessageId we last considered per JID, to detect advances.
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

  /** Resolve the stanza-id of a conversation's/room's current lastSeenMessageId. */
  function resolveSeenStanzaId(jid: string): string | undefined {
    if (isRoom(jid)) {
      const seenId = roomStore.getState().roomMeta.get(jid)?.lastSeenMessageId
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
    const seenId = chatStore.getState().conversationMeta.get(jid)?.lastSeenMessageId
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
   * Best-effort: on failure the marker stays in localStorage and is
   * re-published (if still ahead of the node) on the next fresh session.
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
      const by = stanzaIdBy(jid)
      if (!by) continue // own JID unknown (should not happen while online) — retry next advance
      try {
        await client.mds.publishDisplayed(jid, stanzaId, by)
        lastKnownNodeStanzaId.set(jid, stanzaId)
      } catch {
        // Best-effort — localStorage keeps the read position; reconnect re-publishes.
      }
    }
  }

  /** Consider a conversation/room for publishing if its read position advanced. */
  function consider(jid: string): void {
    if (!syncEnabled) return

    const seenId = isRoom(jid)
      ? roomStore.getState().roomMeta.get(jid)?.lastSeenMessageId
      : chatStore.getState().conversationMeta.get(jid)?.lastSeenMessageId
    if (seenId === lastConsideredSeenId.get(jid)) return
    lastConsideredSeenId.set(jid, seenId)

    const stanzaId = resolveSeenStanzaId(jid)
    if (!stanzaId) return // no resolvable stanza-id yet → skip (retry on next advance/merge)

    // No regressive publish: only publish if strictly ahead (by message index)
    // of what we believe is already on the node for this JID.
    const nodeId = lastKnownNodeStanzaId.get(jid)
    if (nodeId) {
      const candidateIdx = indexOfStanza(jid, stanzaId)
      const nodeIdx = indexOfStanza(jid, nodeId)
      // When nodeIdx === -1 the node's high-water message is outside the loaded
      // window, so we can't prove the candidate is ahead — publish optimistically
      // and rely on (a) the local marker being forward-only and (b) the next
      // fresh-session seed re-reading the node to self-heal a rare backward move.
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
   * the marker after the retract. That is an accepted best-effort limitation
   * (hygiene, not correctness) and self-heals on the next fresh-session seed.
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

  // Watch conversationMeta for read-position changes. On any change, re-consider
  // every conversation; consider() de-dupes via lastConsideredSeenId so only
  // actual advances enqueue a publish.
  const unsubscribeStore = chatStore.subscribe(
    (state) => state.conversationMeta,
    () => {
      if (!syncEnabled) return
      for (const jid of chatStore.getState().conversationMeta.keys()) {
        consider(jid)
      }
    }
  )

  // Mirror the conversationMeta watch for rooms: on any roomMeta change, re-consider
  // every room. consider() de-dupes via lastConsideredSeenId and routes via isRoom().
  const unsubscribeRoomStore = roomStore.subscribe(
    (state) => state.roomMeta,
    () => {
      if (!syncEnabled) return
      for (const jid of roomStore.getState().roomMeta.keys()) {
        consider(jid)
      }
    }
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
        lastConsideredSeenId.set(jid, meta.lastSeenMessageId)
      }
      for (const [jid, meta] of roomStore.getState().roomMeta) {
        lastConsideredSeenId.set(jid, meta.lastSeenMessageId)
      }

      syncEnabled = true
      // Rebuild the delete-detection baseline to the current live set so the
      // fresh-session population is never seen as deletions.
      trackedJids = liveJids()
      logInfo('MDS: seeded read positions and enabled publishing')
    })()
  })

  // Live remote notify: a peer device published a new read position. The
  // storeBindings binding applies it (advancing lastSeenMessageId, which fires
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

  // On disconnect: DROP pending work and cancel the timer. localStorage is the
  // durable buffer; ahead-of-node markers are re-published on the next session.
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
    unsubscribeStore()
    unsubscribeRoomStore()
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
