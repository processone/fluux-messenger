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
 * localStorage remains the durable buffer for read positions: pending in-memory
 * work is DROPPED on disconnect and re-published (ahead-of-node only) on the next
 * fresh session.
 *
 * @module Core/MdsSideEffects
 */

import type { XMPPClient } from './XMPPClient'
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

  /** Is this JID a known room (bookmarked or joined)? Routes accessors per-store. */
  function isRoom(jid: string): boolean {
    return roomStore.getState().rooms.has(jid)
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
      return messages.find((m) => m.id === seenId)?.stanzaId
    }
    const seenId = chatStore.getState().conversationMeta.get(jid)?.lastSeenMessageId
    if (!seenId) return undefined
    const messages = chatStore.getState().messages.get(jid) || []
    return messages.find((m) => m.id === seenId)?.stanzaId
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
      try {
        await client.mds.publishDisplayed(jid, stanzaId)
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

  // Fresh session: seed from the node, then enable publishing. Publishing stays
  // disabled for the whole async seed so the seeded positions aren't republished.
  const unsubscribeOnline = client.on('online', () => {
    syncEnabled = false
    void (async () => {
      let markers: Array<{ conversationJid: string; stanzaId: string }> = []
      try {
        markers = await client.mds.fetchAllDisplayed()
      } catch {
        // Node may not exist yet — proceed with an empty seed.
      }

      for (const { conversationJid, stanzaId } of markers) {
        const bare = getBareJid(conversationJid)
        lastKnownNodeStanzaId.set(bare, stanzaId)
        // Route the seed by membership. If a bookmarked room isn't yet in
        // roomStore.rooms at this point, its marker routes to chat; the position
        // self-heals on a later fresh-session seed once the room is known.
        if (isRoom(bare)) {
          roomStore.getState().applyRemoteDisplayed(bare, stanzaId)
        } else {
          chatStore.getState().applyRemoteDisplayed(bare, stanzaId)
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
  })

  // On disconnect: DROP pending work and cancel the timer. localStorage is the
  // durable buffer; ahead-of-node markers are re-published on the next session.
  let previousStatus = connectionStore.getState().status
  const unsubscribeConnection = connectionStore.subscribe(
    (state) => state.status,
    (status) => {
      if (status !== 'online' && previousStatus === 'online') {
        syncEnabled = false
        dirty.drop()
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
    unsubscribeOnline()
    unsubscribeDisplayedSynced()
    unsubscribeResumed()
    unsubscribeConnection()
    dirty.drop()
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }
}
