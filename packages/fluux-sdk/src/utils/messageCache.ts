/**
 * Message cache using IndexedDB for unlimited message storage.
 *
 * Provides persistent storage for chat and room messages with efficient
 * querying by conversation/room and timestamp for pagination.
 *
 * Uses the 'idb' library for clean async/await API.
 */

import { openDB, type IDBPDatabase, type DBSchema } from 'idb'
import type { Message, RoomMessage } from '../core/types'
import { getStorageScopeJid } from './storageScope'
import { isRenderableStoredMessage } from './messageRenderability'
import { roomCanonicalKey, roomIdentityKeys } from './roomMessageIdentity'

const DB_NAME = 'fluux-message-cache'
// v3: add a SPARSE index on `encryptedPayload` so deferred decryption can list
// only the messages still awaiting a key — without scanning the whole archive.
const DB_VERSION = 3
const MESSAGES_STORE = 'messages'
const ROOM_MESSAGES_STORE = 'room-messages'

/**
 * Stored message format with timestamps as numbers for efficient indexing.
 */
interface StoredMessage extends Omit<Message, 'timestamp' | 'retractedAt' | 'replyTo'> {
  /** Timestamp as milliseconds since epoch for indexing */
  timestamp: number
  /** Retracted timestamp as milliseconds if message was retracted */
  retractedAt?: number
  /** Reply info with nested dates serialized */
  replyTo?: Message['replyTo']
}

/**
 * Stored room message format with timestamps as numbers for efficient indexing.
 */
export interface StoredRoomMessage
  extends Omit<RoomMessage, 'timestamp' | 'retractedAt' | 'pollClosedAt' | 'replyTo'> {
  /** Cache key used as the primary key in IndexedDB — the canonical (highest-tier) identity key. */
  cacheKey: string
  /** Every room-scoped identity tier this row is known under (see {@link roomIdentityKeys}). */
  identityKeys: string[]
  /** Every client-generated `id` this row has absorbed (a merged row may carry more than one). */
  ids: string[]
  /** Timestamp as milliseconds since epoch for indexing */
  timestamp: number
  /** Retracted timestamp as milliseconds if message was retracted */
  retractedAt?: number
  /** Poll closed timestamp as milliseconds */
  pollClosedAt?: number
  /** Reply info with nested dates serialized */
  replyTo?: RoomMessage['replyTo']
}

/**
 * IndexedDB schema definition using idb's typed schema support.
 */
interface MessageCacheSchema extends DBSchema {
  [MESSAGES_STORE]: {
    key: string // message id
    value: StoredMessage
    indexes: {
      conversationId: string
      stanzaId: string
      timestamp: number
      conv_timestamp: [string, number]
      // Sparse: only messages awaiting deferred decryption are indexed here.
      encryptedPayload: string
    }
  }
  [ROOM_MESSAGES_STORE]: {
    key: string // cacheKey (stanzaId or roomJid:from:id)
    value: StoredRoomMessage
    indexes: {
      roomJid: string
      stanzaId: string
      timestamp: number
      room_timestamp: [string, number]
      id: string // Index on client ID for lookup
    }
  }
}

let dbPromise: Promise<IDBPDatabase<MessageCacheSchema>> | null = null
let dbNameForPromise: string | null = null

/**
 * Check if IndexedDB is available in the current environment.
 */
function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

function getScopedDbName(scopeJid: string | null): string {
  return scopeJid ? `${DB_NAME}:${scopeJid}` : DB_NAME
}

/**
 * Get or initialize the IndexedDB database for the current account scope.
 */
function getDB(scopeJid: string | null = getStorageScopeJid()): Promise<IDBPDatabase<MessageCacheSchema>> {
  if (!isIndexedDBAvailable()) {
    return Promise.reject(new Error('IndexedDB not available'))
  }

  const targetDbName = getScopedDbName(scopeJid)

  if (dbPromise && dbNameForPromise === targetDbName) {
    return dbPromise
  }

  if (dbPromise && dbNameForPromise && dbNameForPromise !== targetDbName) {
    const previousPromise = dbPromise
    dbPromise = null
    dbNameForPromise = null
    void previousPromise.then((db) => db.close()).catch(() => {})
  }

  dbNameForPromise = targetDbName
  dbPromise = openDB<MessageCacheSchema>(targetDbName, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, transaction) {
      // Chat messages store
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const msgStore = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' })
        msgStore.createIndex('conversationId', 'conversationId', { unique: false })
        msgStore.createIndex('stanzaId', 'stanzaId', { unique: false })
        msgStore.createIndex('timestamp', 'timestamp', { unique: false })
        msgStore.createIndex('conv_timestamp', ['conversationId', 'timestamp'], {
          unique: false,
        })
        // Sparse index — records without `encryptedPayload` are excluded.
        msgStore.createIndex('encryptedPayload', 'encryptedPayload', { unique: false })
      } else if (oldVersion < 3) {
        // v3 migration for existing DBs: add the sparse encryptedPayload index.
        const msgStore = transaction.objectStore(MESSAGES_STORE)
        if (!msgStore.indexNames.contains('encryptedPayload')) {
          msgStore.createIndex('encryptedPayload', 'encryptedPayload', { unique: false })
        }
      }

      // Room messages store
      // Version 2: Changed keyPath from 'id' to 'cacheKey' to fix duplicate messages
      // issue where different senders could have the same message ID.
      if (oldVersion < 2 && db.objectStoreNames.contains(ROOM_MESSAGES_STORE)) {
        // Delete old store - data will be re-fetched from MAM
        db.deleteObjectStore(ROOM_MESSAGES_STORE)
      }

      if (!db.objectStoreNames.contains(ROOM_MESSAGES_STORE)) {
        const roomStore = db.createObjectStore(ROOM_MESSAGES_STORE, { keyPath: 'cacheKey' })
        roomStore.createIndex('roomJid', 'roomJid', { unique: false })
        roomStore.createIndex('stanzaId', 'stanzaId', { unique: false })
        roomStore.createIndex('timestamp', 'timestamp', { unique: false })
        roomStore.createIndex('room_timestamp', ['roomJid', 'timestamp'], {
          unique: false,
        })
        roomStore.createIndex('id', 'id', { unique: false })
      }
    },
  })

  return dbPromise
}

// =============================================================================
// Serialization helpers
// =============================================================================

/**
 * Convert a Message to storage format (Date -> number).
 */
function serializeMessage(message: Message): StoredMessage {
  return {
    ...message,
    timestamp: message.timestamp.getTime(),
    retractedAt: message.retractedAt?.getTime(),
  }
}

/**
 * Convert a stored message back to Message format (number -> Date).
 */
function deserializeMessage(stored: StoredMessage): Message {
  return {
    ...stored,
    timestamp: new Date(stored.timestamp),
    retractedAt: stored.retractedAt ? new Date(stored.retractedAt) : undefined,
  }
}

/**
 * Convert a RoomMessage to storage format (Date -> number).
 */
function serializeRoomMessage(message: RoomMessage): StoredRoomMessage {
  return {
    ...message,
    cacheKey: roomCanonicalKey(message),
    identityKeys: roomIdentityKeys(message),
    ids: [message.id],
    timestamp: message.timestamp.getTime(),
    retractedAt: message.retractedAt?.getTime(),
    pollClosedAt: message.pollClosedAt?.getTime(),
  }
}

/**
 * Convert a stored room message back to RoomMessage format (number -> Date).
 */
function deserializeRoomMessage(stored: StoredRoomMessage): RoomMessage {
  return {
    ...stored,
    timestamp: new Date(stored.timestamp),
    retractedAt: stored.retractedAt ? new Date(stored.retractedAt) : undefined,
    pollClosedAt: stored.pollClosedAt ? new Date(stored.pollClosedAt) : undefined,
  }
}

// =============================================================================
// Chat Message Operations
// =============================================================================

/** Minimal structural view of the idb chat-message object store. */
type ChatMessageStore = {
  get(key: string): Promise<StoredMessage | undefined>
  put(value: StoredMessage): Promise<unknown>
}

/**
 * Recoverability rank of a stored or incoming chat message:
 *   2 = fully decrypted (real plaintext body)
 *   1 = ciphertext stashed (`encryptedPayload`) — still retriable after unlock
 *   0 = unsupported-encryption fallback — no ciphertext, cannot be recovered
 */
function decryptionRank(msg: {
  encryptedPayload?: string
  unsupportedEncryption?: unknown
}): number {
  if (msg.encryptedPayload) return 1
  if (msg.unsupportedEncryption) return 0
  return 2
}

function unionSorted(a: string[] = [], b: string[] = []): string[] { return [...new Set([...a, ...b])].sort() }
function minStr(a?: string, b?: string): string | undefined { if (a == null) return b; if (b == null) return a; return a <= b ? a : b }
function minNum(a?: number, b?: number): number | undefined { if (a == null) return b; if (b == null) return a; return Math.min(a, b) }
function mergeReactions(a?: Record<string, string[]>, b?: Record<string, string[]>): Record<string, string[]> | undefined {
  if (!a) return b; if (!b) return a
  const out: Record<string, string[]> = {}
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out[k] = unionSorted(a[k], b[k])
  return out
}

/** Deterministic, key-sorted serialization — a stable total order over any row. */
function stableStringify(v: unknown): string {
  // JSON.stringify(undefined) is `undefined`, not a string — return a token so the
  // declared `string` return holds (undefined-valued fields do occur in the projection).
  if (v === undefined) return '␀undefined'
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

/**
 * Choose the CONTENT-owner row by a strict TOTAL order, so the choice is the same
 * regardless of argument order AND a tie happens only when the rows are identical.
 * Higher decryption rank, then edited, then non-empty body, then — the fix — a
 * full stable serialization, so two rows differing in attachment / poll / reply /
 * encryption metadata still resolve deterministically instead of picking `a`.
 */
/**
 * The IMMUTABLE content projection — everything EXCEPT the fields merged
 * separately (aliases, timestamp, reactions, retraction, moderation, poll
 * closure, delivery error, cacheKey). The tiebreak must serialize only this,
 * because those excluded fields CHANGE during a merge: an intermediate merged
 * row acquires unioned aliases/reactions and a min timestamp, so serializing the
 * whole row would make contentOwner(merge(a,b), c) differ from
 * contentOwner(a, merge(b,c)) — destroying associativity. The content projection
 * is identical between a merged row and its content-winner, so max over it is
 * genuinely associative.
 */
function contentProjection(m: StoredRoomMessage): unknown {
  const {
    stanzaId: _s, originId: _o, timestamp: _t, reactions: _r, identityKeys: _ik, ids: _ids,
    isRetracted: _rt, retractedAt: _ra, isModerated: _m, moderatedBy: _mb, moderationReason: _mr,
    pollClosed: _pc, pollClosedAt: _pca, deliveryError: _de, cacheKey: _ck, ...content
  } = m
  return content
}

function contentOwner(a: StoredRoomMessage, b: StoredRoomMessage): StoredRoomMessage {
  const ra: number[] = [decryptionRank(a), a.isEdited ? 1 : 0, a.body ? 1 : 0]
  const rb: number[] = [decryptionRank(b), b.isEdited ? 1 : 0, b.body ? 1 : 0]
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i] ? a : b
  // Tiebreak over the IMMUTABLE content only, so max is associative (see contentProjection).
  return stableStringify(contentProjection(a)) <= stableStringify(contentProjection(b)) ? a : b
}

/**
 * Merge two stored rows that are the same logical room message into one.
 * COMMUTATIVE and ASSOCIATIVE. The correlated content block comes from
 * {@link contentOwner} (total order); every other field uses a symmetric operator,
 * so no edit, poll closure, retraction, reaction, moderation, or alias is lost.
 */
export function mergeRoomRows(a: StoredRoomMessage, b: StoredRoomMessage): StoredRoomMessage {
  const owner = contentOwner(a, b)
  const aSid = a.stanzaId != null, bSid = b.stanzaId != null
  const timestamp = aSid !== bSid ? (aSid ? a.timestamp : b.timestamp) : Math.min(a.timestamp, b.timestamp)
  const retracted = !!(a.isRetracted || b.isRetracted)
  const moderated = !!(a.isModerated || b.isModerated)
  // Poll closure: symmetric even when both closed with different records.
  const pollClosed = a.pollClosed && b.pollClosed
    ? (stableStringify(a.pollClosed) <= stableStringify(b.pollClosed) ? a.pollClosed : b.pollClosed)
    : (a.pollClosed ?? b.pollClosed)

  const merged: StoredRoomMessage = {
    ...owner,
    stanzaId: minStr(a.stanzaId, b.stanzaId),
    originId: minStr(a.originId, b.originId),
    timestamp,
    reactions: mergeReactions(a.reactions, b.reactions),
    identityKeys: unionSorted(a.identityKeys, b.identityKeys),
    ids: unionSorted(a.ids, b.ids),
    deliveryError: a.deliveryError && b.deliveryError ? (stableStringify(a.deliveryError) <= stableStringify(b.deliveryError) ? a.deliveryError : b.deliveryError) : undefined,
    ...(retracted ? { isRetracted: true, retractedAt: minNum(a.retractedAt, b.retractedAt) } : {}),
    ...(moderated ? { isModerated: true, moderatedBy: minStr(a.moderatedBy, b.moderatedBy), moderationReason: minStr(a.moderationReason, b.moderationReason) } : {}),
    ...(pollClosed ? { pollClosed, pollClosedAt: minNum(a.pollClosedAt, b.pollClosedAt) } : {}),
  }
  merged.cacheKey = roomCanonicalKey(merged)
  merged.identityKeys = unionSorted(merged.identityKeys, roomIdentityKeys(merged))
  return merged
}

/**
 * Put a chat message without ever DEGRADING a higher-quality cache entry.
 *
 * E2EE re-ingestion hazards: a web page reload that yields a *fresh* session
 * runs the background MAM catch-up while the OpenPGP key may still be locked,
 * and a peer toggling their encryption makes history re-arrive as an
 * unsupported fallback. Either way the re-fetched copy is less recoverable
 * than what we already stored, and a blind `put` would overwrite our decrypted
 * plaintext (or our retriable ciphertext) with a placeholder — leaving the
 * message permanently showing "could not be decrypted" / "not supported".
 *
 * Guard: skip the write when the incoming message is strictly less recoverable
 * than the stored one (see {@link decryptionRank}). Equal-or-better writes
 * upsert normally — decrypted updates, ciphertext refreshes, and the upgrade
 * of a fallback once the real ciphertext arrives.
 */
async function putChatMessageGuarded(
  store: ChatMessageStore,
  message: Message
): Promise<void> {
  const incomingRank = decryptionRank(message)
  if (incomingRank < 2) {
    const existing = await store.get(message.id)
    if (existing && decryptionRank(existing) > incomingRank) {
      // Existing entry is more recoverable — don't degrade it.
      return
    }
  }
  await store.put(serializeMessage(message))
}

/**
 * Save a chat message to IndexedDB.
 * Upserts - will overwrite if message with same ID exists, EXCEPT it never
 * degrades an already-decrypted entry (see {@link putChatMessageGuarded}).
 */
export async function saveMessage(message: Message): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(MESSAGES_STORE, 'readwrite')
    await putChatMessageGuarded(tx.store, message)
    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to save message:', error)
    }
  }
}

/**
 * Save multiple chat messages to IndexedDB in a single transaction.
 * Never degrades an already-decrypted entry (see {@link putChatMessageGuarded}).
 *
 * Resolves `true` iff the transaction committed — errors are absorbed (warn)
 * and reported as `false`. Callers advancing durable cursors (gap/coverage
 * transitions) must gate on the result: a cursor persisted past a page whose
 * write silently failed would skip that page forever.
 */
export async function saveMessages(messages: Message[]): Promise<boolean> {
  if (messages.length === 0) return true

  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(MESSAGES_STORE)

    for (const msg of messages) {
      await putChatMessageGuarded(store, msg)
    }
    await tx.done
    return true
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to save messages:', error)
    }
    return false
  }
}

/**
 * Return every cached chat message that still carries an `encryptedPayload` —
 * i.e. that was ingested while no plugin could decrypt it (typically a locked
 * E2EE key after a fresh-session page reload).
 *
 * Deferred decryption uses this to repair the DURABLE cache after the key is
 * unlocked, not just the messages currently loaded in the in-memory store:
 * conversations the user has not opened are otherwise left permanently showing
 * "could not be decrypted". Scoped to the active account.
 */
export async function getMessagesWithEncryptedPayload(): Promise<Message[]> {
  try {
    const db = await getDB(getStorageScopeJid())
    // Sparse index: this reads ONLY the messages still carrying an
    // encryptedPayload — not the whole archive — so it stays cheap to call on
    // every plugin-register / key-unlock, and is near-free when none are
    // pending (the steady state).
    const pending = await db.getAllFromIndex(MESSAGES_STORE, 'encryptedPayload')
    return pending.map(deserializeMessage)
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to read pending-decrypt messages:', error)
    }
    return []
  }
}

/**
 * Get a message by its client-generated ID.
 */
export async function getMessage(id: string): Promise<Message | null> {
  try {
    const db = await getDB(getStorageScopeJid())
    const stored = await db.get(MESSAGES_STORE, id)
    return stored ? deserializeMessage(stored) : null
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get message:', error)
    }
    return null
  }
}

/**
 * Get a message by its server-assigned stanzaId (for MAM deduplication).
 */
export async function getMessageByStanzaId(stanzaId: string): Promise<Message | null> {
  try {
    const db = await getDB(getStorageScopeJid())
    const stored = await db.getFromIndex(MESSAGES_STORE, 'stanzaId', stanzaId)
    return stored ? deserializeMessage(stored) : null
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get message by stanzaId:', error)
    }
    return null
  }
}

/**
 * Options for querying messages.
 */
export interface GetMessagesOptions {
  /** Maximum number of messages to return */
  limit?: number
  /** Only return messages before this timestamp */
  before?: Date
  /** Only return messages after this timestamp */
  after?: Date
  /** If true, return the latest N messages (most recent first, then reversed to chronological).
   * Useful for initial conversation load to show most recent messages.
   * Only applies when neither 'before' nor 'after' is specified. */
  latest?: boolean
}

/**
 * Get messages for a conversation with optional pagination.
 * Messages are returned in chronological order (oldest first).
 */
export async function getMessages(
  conversationId: string,
  options: GetMessagesOptions = {}
): Promise<Message[]> {
  try {
    const db = await getDB(getStorageScopeJid())
    const { limit, before, after, latest } = options

    // Use compound index for efficient range queries
    const tx = db.transaction(MESSAGES_STORE, 'readonly')
    const index = tx.store.index('conv_timestamp')

    // Build key range based on options
    let range: IDBKeyRange | undefined
    if (before && after) {
      range = IDBKeyRange.bound(
        [conversationId, after.getTime()],
        [conversationId, before.getTime()],
        true, // exclude lower bound
        true // exclude upper bound
      )
    } else if (before) {
      range = IDBKeyRange.upperBound([conversationId, before.getTime()], true)
    } else if (after) {
      range = IDBKeyRange.lowerBound([conversationId, after.getTime()], true)
    } else {
      // All messages for this conversation
      range = IDBKeyRange.bound(
        [conversationId, 0],
        [conversationId, Number.MAX_SAFE_INTEGER]
      )
    }

    const results: Message[] = []

    // Determine cursor direction:
    // - 'latest' option: go backwards from newest to get most recent messages
    // - 'before' option: go backwards to get messages before timestamp
    // - Default: go forwards (oldest to newest)
    const goBackwards = before || (latest && !after)
    let cursor = await index.openCursor(range, goBackwards ? 'prev' : 'next')

    while (cursor && (!limit || results.length < limit)) {
      const stored = cursor.value
      // Double-check conversationId matches (IDB compound index quirk)
      if (stored.conversationId === conversationId) {
        const message = deserializeMessage(stored)
        // Skip legacy blank rows (empty body, no attachment/poll/encryption/
        // retraction) that older builds persisted before the parse-time guard.
        // They have nothing to render and must not fill the limit or anchor a
        // catch-up cursor as the newest message. See isRenderableStoredMessage.
        if (isRenderableStoredMessage(message)) {
          results.push(message)
        }
      }
      cursor = await cursor.continue()
    }

    // If we queried backwards, reverse to chronological order
    if (goBackwards) {
      results.reverse()
    }

    return results
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get messages:', error)
    }
    return []
  }
}

/**
 * Options for loading a contiguous window of cached messages centered on an anchor.
 */
export interface GetMessagesAroundOptions {
  /** Messages of context to include immediately BEFORE (older than) the anchor. Default 50. */
  before?: number
  /**
   * Optional cap on how many messages to include AFTER (newer than) the anchor. Omit to include
   * EVERY newer message through the latest, so the rehydrated window stays contiguous to the
   * present (required for scroll-position restore: the resident array must reach the tail so
   * bottom-stick and "new message arrives" keep working). A finite value yields a bounded window
   * on both sides (used for search/target navigation to an arbitrary point in history).
   */
  after?: number
}

/**
 * Load a contiguous window of cached chat messages centered on a specific message.
 *
 * Returns the anchor message, up to `before` messages of older context above it, and the messages
 * after it (capped by `after`, or all the way through the latest when `after` is omitted), in
 * chronological order. Returns `[]` when the anchor id is not in the cache so the caller can fall
 * back to a latest-slice load.
 *
 * This is what makes scroll restore independent of the latest-N rehydration: after deep scroll-back
 * the saved anchor points at an OLD message absent from the newest-100 slice, so the restore can't
 * resolve it. Loading the slice that CONTAINS the anchor (plus the tail to the present) lets the
 * existing content-anchor restore land correctly. The same primitive serves search/activity jumps
 * to a message that isn't in the recent slice.
 *
 * @param anchorMessageId - The anchor's client id (`message.id`, as carried by `data-message-id`).
 *   Falls back to the stanza-id index so a server stanza id (e.g. a navigation target) also resolves.
 */
export async function getMessagesAround(
  conversationId: string,
  anchorMessageId: string,
  options: GetMessagesAroundOptions = {}
): Promise<Message[]> {
  const { before = 50, after } = options

  let anchor = await getMessage(anchorMessageId)
  if (!anchor) anchor = await getMessageByStanzaId(anchorMessageId)
  if (!anchor) return []

  const t = anchor.timestamp.getTime()
  // Context above + the anchor itself: the `before + 1` newest messages with timestamp <= t.
  // (upperBound is exclusive, so `t + 1` includes the anchor sitting at exactly t.)
  const olderAndAnchor = await getMessages(conversationId, {
    before: new Date(t + 1),
    limit: before + 1,
  })
  // Tail: messages strictly newer than the anchor. Capped by `after` (oldest-first from the
  // anchor) for a bounded window, or uncapped to reach the latest message.
  const newer = await getMessages(conversationId, {
    after: new Date(t),
    ...(after !== undefined ? { limit: after } : {}),
  })

  // Merge + dedupe by id, preserving chronological order (the two reads cannot overlap by
  // timestamp, but a defensive id-dedupe keeps it robust against same-ms siblings).
  const seen = new Set<string>()
  const merged: Message[] = []
  for (const m of [...olderAndAnchor, ...newer]) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    merged.push(m)
  }
  return merged
}

/**
 * Get the count of messages for a conversation.
 */
export async function getMessageCount(conversationId: string): Promise<number> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(MESSAGES_STORE, 'readonly')
    const index = tx.store.index('conv_timestamp')
    const range = IDBKeyRange.bound(
      [conversationId, 0],
      [conversationId, Number.MAX_SAFE_INTEGER]
    )
    return await index.count(range)
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to count messages:', error)
    }
    return 0
  }
}

/**
 * Count all chat messages across all conversations.
 */
export async function getTotalMessageCount(): Promise<number> {
  try {
    const db = await getDB(getStorageScopeJid())
    return await db.count(MESSAGES_STORE)
  } catch {
    return 0
  }
}

/**
 * Count all room messages across all rooms.
 */
export async function getTotalRoomMessageCount(): Promise<number> {
  try {
    const db = await getDB(getStorageScopeJid())
    return await db.count(ROOM_MESSAGES_STORE)
  } catch {
    return 0
  }
}

/**
 * Update specific fields of a message.
 */
export async function updateMessage(
  id: string,
  updates: Partial<Message>
): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    const existing = await db.get(MESSAGES_STORE, id)
    if (!existing) return

    const updated = {
      ...existing,
      ...updates,
      // Handle Date fields
      timestamp:
        updates.timestamp instanceof Date
          ? updates.timestamp.getTime()
          : existing.timestamp,
      retractedAt:
        updates.retractedAt instanceof Date
          ? updates.retractedAt.getTime()
          : updates.retractedAt ?? existing.retractedAt,
    }

    await db.put(MESSAGES_STORE, updated)
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to update message:', error)
    }
  }
}

/**
 * Update reactions for a chat message in IndexedDB.
 * Used as a fallback when the message is not currently loaded in memory
 * (e.g. a reaction arrives for a conversation that isn't the active one).
 * Looks up by client ID or stanza-id (reactions may reference either).
 *
 * @returns true if the message was found and updated, false otherwise.
 */
export async function updateMessageReactions(
  messageId: string,
  reactorJid: string,
  emojis: string[],
): Promise<boolean> {
  try {
    const db = await getDB(getStorageScopeJid())

    let existing = await db.get(MESSAGES_STORE, messageId)
    if (!existing) {
      existing = await db.getFromIndex(MESSAGES_STORE, 'stanzaId', messageId)
    }
    if (!existing) return false

    // Build new reactions map: remove reactor from all, then add to new emojis
    const newReactions: Record<string, string[]> = {}
    if (existing.reactions) {
      for (const [emoji, reactors] of Object.entries(existing.reactions)) {
        const filtered = (reactors as string[]).filter((jid: string) => jid !== reactorJid)
        if (filtered.length > 0) {
          newReactions[emoji] = filtered
        }
      }
    }
    for (const emoji of emojis) {
      if (!newReactions[emoji]) {
        newReactions[emoji] = []
      }
      newReactions[emoji].push(reactorJid)
    }

    const updated = {
      ...existing,
      reactions: Object.keys(newReactions).length > 0 ? newReactions : undefined,
    }

    await db.put(MESSAGES_STORE, updated)
    return true
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to update message reactions in cache:', error)
    }
    return false
  }
}

/**
 * Delete a message by ID.
 */
export async function deleteMessage(id: string): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    await db.delete(MESSAGES_STORE, id)
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to delete message:', error)
    }
  }
}

/**
 * Delete all messages for a conversation.
 */
export async function deleteConversationMessages(conversationId: string): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(MESSAGES_STORE, 'readwrite')
    const index = tx.store.index('conversationId')

    let cursor = await index.openCursor(conversationId)
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }

    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to delete conversation messages:', error)
    }
  }
}

// =============================================================================
// Room Message Operations
// =============================================================================

/**
 * Save a room message to IndexedDB.
 *
 * Writes directly to the store — no batching. A live message must reach IDB
 * before the next `window.location.reload()` (e.g. long-sleep detection),
 * otherwise the message is lost from the cache and the subsequent MAM
 * catch-up cursor may skip past it. Batched writes for history replay
 * should use {@link saveRoomMessages} instead.
 */
export async function saveRoomMessage(message: RoomMessage): Promise<void> {
  await saveRoomMessages([message])
}

/**
 * Save multiple room messages to IndexedDB in a single transaction.
 *
 * Resolves `true` iff the transaction committed — errors are absorbed (warn)
 * and reported as `false`. Callers advancing durable cursors (gap/coverage
 * transitions) must gate on the result: a cursor persisted past a page whose
 * write silently failed would skip that page forever.
 */
export async function saveRoomMessages(messages: RoomMessage[]): Promise<boolean> {
  if (messages.length === 0) return true

  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(ROOM_MESSAGES_STORE)

    await Promise.all(messages.map((msg) => store.put(serializeRoomMessage(msg))))
    await tx.done
    return true
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to save room messages:', error)
    }
    return false
  }
}

/**
 * Get a room message by its client-generated ID.
 * Note: IDs may not be unique across senders. Uses the id index to find the first match.
 */
export async function getRoomMessage(id: string): Promise<RoomMessage | null> {
  try {
    const db = await getDB(getStorageScopeJid())
    // Use the id index since the primary key is now cacheKey
    const stored = await db.getFromIndex(ROOM_MESSAGES_STORE, 'id', id)
    return stored ? deserializeRoomMessage(stored) : null
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get room message:', error)
    }
    return null
  }
}

/**
 * Get a room message by its stanzaId.
 */
export async function getRoomMessageByStanzaId(
  stanzaId: string
): Promise<RoomMessage | null> {
  try {
    const db = await getDB(getStorageScopeJid())
    const stored = await db.getFromIndex(ROOM_MESSAGES_STORE, 'stanzaId', stanzaId)
    return stored ? deserializeRoomMessage(stored) : null
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get room message by stanzaId:', error)
    }
    return null
  }
}

/**
 * Get messages for a room with optional pagination.
 * Messages are returned in chronological order (oldest first).
 */
export async function getRoomMessages(
  roomJid: string,
  options: GetMessagesOptions = {}
): Promise<RoomMessage[]> {
  try {
    const db = await getDB(getStorageScopeJid())
    const { limit, before, after, latest } = options

    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readonly')
    const index = tx.store.index('room_timestamp')

    // Build key range
    let range: IDBKeyRange | undefined
    if (before && after) {
      range = IDBKeyRange.bound(
        [roomJid, after.getTime()],
        [roomJid, before.getTime()],
        true,
        true
      )
    } else if (before) {
      range = IDBKeyRange.upperBound([roomJid, before.getTime()], true)
    } else if (after) {
      range = IDBKeyRange.lowerBound([roomJid, after.getTime()], true)
    } else {
      range = IDBKeyRange.bound([roomJid, 0], [roomJid, Number.MAX_SAFE_INTEGER])
    }

    const results: RoomMessage[] = []

    // Determine cursor direction (same logic as getMessages)
    const goBackwards = before || (latest && !after)
    let cursor = await index.openCursor(range, goBackwards ? 'prev' : 'next')

    while (cursor && (!limit || results.length < limit)) {
      const stored = cursor.value
      if (stored.roomJid === roomJid) {
        const message = deserializeRoomMessage(stored)
        // Skip legacy blank rows (see getMessages / isRenderableStoredMessage):
        // the "empty Cynthia row" lived in a room archive exactly like this.
        if (isRenderableStoredMessage(message)) {
          results.push(message)
        }
      }
      cursor = await cursor.continue()
    }

    if (goBackwards) {
      results.reverse()
    }

    return results
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get room messages:', error)
    }
    return []
  }
}

/**
 * Load a contiguous window of cached room messages centered on a specific message.
 * Room counterpart of {@link getMessagesAround} — see it for semantics.
 */
export async function getRoomMessagesAround(
  roomJid: string,
  anchorMessageId: string,
  options: GetMessagesAroundOptions = {}
): Promise<RoomMessage[]> {
  const { before = 50, after } = options

  let anchor = await getRoomMessage(anchorMessageId)
  if (!anchor) anchor = await getRoomMessageByStanzaId(anchorMessageId)
  if (!anchor) return []

  const t = anchor.timestamp.getTime()
  const olderAndAnchor = await getRoomMessages(roomJid, {
    before: new Date(t + 1),
    limit: before + 1,
  })
  const newer = await getRoomMessages(roomJid, {
    after: new Date(t),
    ...(after !== undefined ? { limit: after } : {}),
  })

  // Dedupe by the same canonical identity key the cache uses (room ids are not unique across senders).
  const seen = new Set<string>()
  const merged: RoomMessage[] = []
  for (const m of [...olderAndAnchor, ...newer]) {
    const key = roomCanonicalKey(m)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(m)
  }
  return merged
}

/**
 * Get the count of messages for a room.
 */
export async function getRoomMessageCount(roomJid: string): Promise<number> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readonly')
    const index = tx.store.index('room_timestamp')
    const range = IDBKeyRange.bound([roomJid, 0], [roomJid, Number.MAX_SAFE_INTEGER])
    return await index.count(range)
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to count room messages:', error)
    }
    return 0
  }
}

/**
 * Update specific fields of a room message.
 * Note: Looks up by client-generated ID using the id index.
 */
export async function updateRoomMessage(
  id: string,
  updates: Partial<RoomMessage>
): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    // Look up by id index since primary key is now cacheKey
    const existing = await db.getFromIndex(ROOM_MESSAGES_STORE, 'id', id)
    if (!existing) return

    const updated = {
      ...existing,
      ...updates,
      // Preserve the cacheKey - it must match the original
      cacheKey: existing.cacheKey,
      timestamp:
        updates.timestamp instanceof Date
          ? updates.timestamp.getTime()
          : existing.timestamp,
      retractedAt:
        updates.retractedAt instanceof Date
          ? updates.retractedAt.getTime()
          : updates.retractedAt ?? existing.retractedAt,
      pollClosedAt:
        updates.pollClosedAt instanceof Date
          ? updates.pollClosedAt.getTime()
          : updates.pollClosedAt ?? existing.pollClosedAt,
    }

    await db.put(ROOM_MESSAGES_STORE, updated)
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to update room message:', error)
    }
  }
}

/**
 * Update reactions for a room message in IndexedDB.
 * Used as a fallback when the message is not currently loaded in memory.
 * Looks up by client ID or stanza-id (reactions may reference either).
 *
 * @returns true if the message was found and updated, false otherwise.
 */
export async function updateRoomMessageReactions(
  messageId: string,
  reactorNick: string,
  emojis: string[],
): Promise<boolean> {
  try {
    const db = await getDB(getStorageScopeJid())

    // Try by id index first, then by stanzaId index
    let existing = await db.getFromIndex(ROOM_MESSAGES_STORE, 'id', messageId)
    if (!existing) {
      existing = await db.getFromIndex(ROOM_MESSAGES_STORE, 'stanzaId', messageId)
    }
    if (!existing) return false

    // Build new reactions map: remove reactor from all, then add to new emojis
    const newReactions: Record<string, string[]> = {}
    if (existing.reactions) {
      for (const [emoji, reactors] of Object.entries(existing.reactions)) {
        const filtered = (reactors as string[]).filter((nick: string) => nick !== reactorNick)
        if (filtered.length > 0) {
          newReactions[emoji] = filtered
        }
      }
    }
    for (const emoji of emojis) {
      if (!newReactions[emoji]) {
        newReactions[emoji] = []
      }
      newReactions[emoji].push(reactorNick)
    }

    const updated = {
      ...existing,
      reactions: Object.keys(newReactions).length > 0 ? newReactions : undefined,
    }

    await db.put(ROOM_MESSAGES_STORE, updated)
    return true
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to update room message reactions in cache:', error)
    }
    return false
  }
}

/**
 * Delete a room message by ID.
 * Note: Looks up by client-generated ID using the id index, then deletes by cacheKey.
 */
export async function deleteRoomMessage(id: string): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    // Look up by id index to find the cacheKey
    const existing = await db.getFromIndex(ROOM_MESSAGES_STORE, 'id', id)
    if (!existing) return
    // Delete using the cacheKey (the actual primary key)
    await db.delete(ROOM_MESSAGES_STORE, existing.cacheKey)
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to delete room message:', error)
    }
  }
}

/**
 * Delete all messages for a room.
 */
export async function deleteRoomMessages(roomJid: string): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const index = tx.store.index('roomJid')

    let cursor = await index.openCursor(roomJid)
    while (cursor) {
      await cursor.delete()
      cursor = await cursor.continue()
    }

    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to delete room messages:', error)
    }
  }
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Clear all cached messages (both chat and room).
 */
export async function clearAllMessages(): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction([MESSAGES_STORE, ROOM_MESSAGES_STORE], 'readwrite')
    await Promise.all([tx.objectStore(MESSAGES_STORE).clear(), tx.objectStore(ROOM_MESSAGES_STORE).clear()])
    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to clear all messages:', error)
    }
  }
}

/**
 * Get the oldest message timestamp for a conversation (for determining if more history exists in IndexedDB).
 */
export async function getOldestMessageTimestamp(
  conversationId: string
): Promise<Date | null> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(MESSAGES_STORE, 'readonly')
    const index = tx.store.index('conv_timestamp')
    const range = IDBKeyRange.bound(
      [conversationId, 0],
      [conversationId, Number.MAX_SAFE_INTEGER]
    )

    const cursor = await index.openCursor(range, 'next')
    if (cursor?.value.conversationId === conversationId) {
      return new Date(cursor.value.timestamp)
    }
    return null
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get oldest message timestamp:', error)
    }
    return null
  }
}

/**
 * Get the oldest room message timestamp (for determining if more history exists in IndexedDB).
 */
export async function getOldestRoomMessageTimestamp(
  roomJid: string
): Promise<Date | null> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readonly')
    const index = tx.store.index('room_timestamp')
    const range = IDBKeyRange.bound([roomJid, 0], [roomJid, Number.MAX_SAFE_INTEGER])

    const cursor = await index.openCursor(range, 'next')
    if (cursor?.value.roomJid === roomJid) {
      return new Date(cursor.value.timestamp)
    }
    return null
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get oldest room message timestamp:', error)
    }
    return null
  }
}

/**
 * Iterate all stored chat messages in batches.
 * Used for search index backfill. Reads all messages from the store first,
 * then processes them in batches via the callback.
 *
 * Reading is done upfront (via getAll) so the IDB readonly transaction
 * completes before `onBatch` runs. This avoids TransactionInactiveError
 * when the callback performs async writes to a different database (e.g.
 * the search index), which would otherwise cause the cursor's transaction
 * to auto-commit while the event loop is idle.
 *
 * @param batchSize - Number of messages per batch (default: 500)
 * @param onBatch - Callback invoked with each batch of deserialized messages
 */
export async function iterateAllMessages(
  batchSize: number,
  onBatch: (messages: Message[]) => Promise<void>
): Promise<void> {
  const db = await getDB(getStorageScopeJid())
  const allRaw = await db.getAll(MESSAGES_STORE)

  for (let i = 0; i < allRaw.length; i += batchSize) {
    const batch = allRaw.slice(i, i + batchSize).map(deserializeMessage)
    await onBatch(batch)
  }
}

/**
 * Iterate all stored room messages in batches.
 * Used for search index backfill. Same upfront-read strategy as
 * `iterateAllMessages` to avoid IDB transaction lifetime issues.
 *
 * @param batchSize - Number of messages per batch (default: 500)
 * @param onBatch - Callback invoked with each batch of deserialized messages
 */
export async function iterateAllRoomMessages(
  batchSize: number,
  onBatch: (messages: RoomMessage[]) => Promise<void>
): Promise<void> {
  const db = await getDB(getStorageScopeJid())
  const allRaw = await db.getAll(ROOM_MESSAGES_STORE)

  for (let i = 0; i < allRaw.length; i += batchSize) {
    const batch = allRaw.slice(i, i + batchSize).map(deserializeRoomMessage)
    await onBatch(batch)
  }
}

/**
 * Check if IndexedDB message cache is available.
 */
export function isMessageCacheAvailable(): boolean {
  return isIndexedDBAvailable()
}

// =============================================================================
// Testing utilities (not exported in production builds)
// =============================================================================

/**
 * Reset the database instance. For testing only.
 * @internal
 */
export function _resetDBForTesting(): void {
  dbPromise = null
  dbNameForPromise = null
}
