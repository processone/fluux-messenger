/**
 * Message cache using IndexedDB for unlimited message storage.
 *
 * Provides persistent storage for chat and room messages with efficient
 * querying by conversation/room and timestamp for pagination.
 *
 * Uses the 'idb' library for clean async/await API.
 */

import { openDB, type IDBPDatabase, type DBSchema } from 'idb'
// Imported from the declaring modules rather than the `core/types` barrel:
// the barrel also re-exports the store-binding port, which names
// `GetMessagesOptions` from this file, so going through it would make the two
// mutually recursive.
import type { Message } from '../core/types/chat'
import type { RoomMessage } from '../core/types/room'
import { getStorageScopeJid } from './storageScope'
import {
  canMergeOccupantSet,
  canonicalKey,
  chatMessageAuthor,
  extendOccupantComponent,
  identityKeys,
  identityFieldsEqual,
  identityProbes,
  mergeableOccupantCandidates,
  occupantConflict,
  referenceProbes,
  roomMessageAuthor,
  roomScope,
  sameLogicalMessage,
  tierKey,
  type IdentityProbe,
  type IdentityTier,
} from './messageIdentity'
import {
  adoptPendingRetraction,
  chatPendingRetractionAliases,
  chatRetractionAliases,
  noteRetractedIdentity,
  roomPendingRetractionAliases,
  roomRetractionAliases,
  retractedAtForIdentity,
  type RetractionScope,
} from './retractedIdentities'

import {
  makeCacheOrderKey,
  isAfterBoundary,
  isRenderableStoredMessage,
  type ExactPosition,
  exactPosition,
  type PointerOrder,
} from '../stores/shared/readState'

const DB_NAME = 'fluux-message-cache'
// v3: add a SPARSE index on `encryptedPayload` so deferred decryption can list
// only the messages still awaiting a key — without scanning the whole archive.
// v4: canonicalize the room archive — one cached row per logical message. A fresh
// canonically-keyed store (identityKeys[]/ids[] multiEntry + room_ts_from_id order
// index) replaces the old room store; the v4 upgrade streams every legacy row
// through the identity-resolving upsert into it and aborts atomically on failure.
const DB_VERSION = 4
const MESSAGES_STORE = 'messages'
// The canonical room store (v4+). Keyed by the canonical durable identity key.
const ROOM_MESSAGES_STORE = 'room-messages-canonical'
// The pre-v4 room store. Read + cleared by the v4 migration only; never written live.
const LEGACY_ROOM_MESSAGES_STORE = 'room-messages'

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
  /** Cache key used as the primary key in IndexedDB. */
  cacheKey: string
  /** Every room-scoped identity tier this row is known under (see {@link identityKeys}). */
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
    key: string // cacheKey — the canonical durable identity key
    value: StoredRoomMessage
    indexes: {
      roomJid: string
      // multiEntry over identityKeys[] — the finder resolves every identity tier here.
      identityKeys: string
      // multiEntry over ids[] — a merged row is findable by EVERY absorbed client id.
      ids: string
      timestamp: number
      room_timestamp: [string, number]
      // Stable room order key (roomJid, timestamp, from, id) for the archive read path.
      room_ts_from_id: [string, number, string, string]
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

      // Room messages store (v4 canonical). A fresh canonically-keyed store replaces
      // the pre-v4 room store; when the legacy store is present, the migration streams
      // every legacy row through the identity-resolving upsert into it.
      if (!db.objectStoreNames.contains(ROOM_MESSAGES_STORE)) {
        const s = db.createObjectStore(ROOM_MESSAGES_STORE, { keyPath: 'cacheKey' })
        s.createIndex('roomJid', 'roomJid', { unique: false })
        // No unscoped `stanzaId` or `originId` scalar index: stanzaIds/originIds are
        // assigned per-archive and repeat across rooms, so a scalar index on either
        // would let a lookup cross rooms — and nothing queries them anyway. Every
        // stanzaId/originId query goes through the room-scoped `identityKeys` alias
        // instead (see tierKey / getRoomMessageByStanzaId /
        // updateRoomMessageReactions).
        s.createIndex('identityKeys', 'identityKeys', { unique: false, multiEntry: true })
        s.createIndex('ids', 'ids', { unique: false, multiEntry: true })
        s.createIndex('timestamp', 'timestamp', { unique: false })
        s.createIndex('room_timestamp', ['roomJid', 'timestamp'], { unique: false })
        s.createIndex('room_ts_from_id', ['roomJid', 'timestamp', 'from', 'id'], { unique: false })

        // `as never`: the legacy store is not in the v4 schema, so idb's typed
        // objectStoreNames.contains() would reject its name — but it can still be
        // present in an upgrading DB, which is exactly what we test for here.
        if (db.objectStoreNames.contains(LEGACY_ROOM_MESSAGES_STORE as never)) {
          // idb does NOT await this callback, and rethrowing would be an unhandled
          // rejection. Fire the migration and, on ANY failure, explicitly abort the
          // version-change transaction (which rejects openDB). The transaction stays
          // alive meanwhile via the migration's chained requests, and openDB resolves
          // only after it commits. Do not deleteObjectStore here (illegal from the
          // async continuation) — the migration clear()s the legacy store instead.
          migrateRoomStoreToCanonical(transaction, scopeJid).catch((err) => {
            // Log before aborting: this streaming rewrite of the whole room archive
            // is the riskiest path in the upgrade, and the abort otherwise swallows
            // the cause silently. Then: aborting rejects openDB (getDB's caller
            // handles that) AND rejects transaction.done with AbortError; nothing
            // awaits `done`, so attach a no-op catch first to keep the abort from
            // surfacing as an unhandled rejection, then abort.
            console.error('v4 room-store migration aborted:', err)
            transaction.done.catch(() => {})
            transaction.abort()
          })
        }
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
    cacheKey: canonicalKey(roomScope(message.roomJid), message),
    identityKeys: identityKeys(roomScope(message.roomJid), message),
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
// Retraction enforcement (XEP-0424)
// =============================================================================

/**
 * A retracted row keeps its position and its tombstone flag and NOTHING a reader
 * could render as content. `isRenderableStoredMessage` keeps a tombstone
 * renderable on `isRetracted` alone, so stripping these does not move an unread
 * boundary or a catch-up cursor.
 *
 * `body` is required on `BaseMessage`, so it is emptied rather than deleted.
 * `replyTo` is left alone: it quotes ANOTHER message, which this retraction does
 * not cover.
 */
function scrubRetractedContent<T extends StoredMessage | StoredRoomMessage>(row: T): T {
  return {
    ...row,
    body: '',
    originalBody: undefined,
    attachment: undefined,
    linkPreview: undefined,
    poll: undefined,
    pollClosed: undefined,
    encryptedPayload: undefined,
    unsupportedEncryption: undefined,
  }
}

/**
 * The single retraction gate every cache write passes through.
 *
 * Two jobs, in order:
 * 1. Adopt a retraction this session recorded but the row could not carry — the
 *    retraction arrived while this very write was still in flight, so there was
 *    no row to tombstone (see `retractedIdentities.ts`).
 * 2. Strip the content of any retracted row, whatever marked it: a fresh
 *    tombstone, a re-delivered MAM copy merged onto one, or the ledger above.
 *
 * Applying it at write time rather than at the tombstoning call site is what
 * makes "no retracted body survives in the cache" hold for EVERY writer,
 * including a re-save that would otherwise resurrect the body.
 */
function enforceRetraction(
  row: StoredMessage,
  scope: RetractionScope
): StoredMessage
function enforceRetraction(
  row: StoredRoomMessage,
  scope: RetractionScope
): StoredRoomMessage
function enforceRetraction(
  row: StoredMessage | StoredRoomMessage,
  scope: RetractionScope
): StoredMessage | StoredRoomMessage {
  let next = row
  if (!next.isRetracted) {
    const verifiedAliases =
      scope.kind === 'room'
        ? roomRetractionAliases(next as StoredRoomMessage)
        : chatRetractionAliases(next)
    const retractedAt =
      retractedAtForIdentity(scope, verifiedAliases, (record) =>
        scope.kind === 'room'
          ? roomMessageAuthor(next as StoredRoomMessage, record)
          : chatMessageAuthor(next, record)
      ) ??
      adoptPendingRetraction(
        scope,
        scope.kind === 'room'
          ? roomPendingRetractionAliases(next as StoredRoomMessage)
          : chatPendingRetractionAliases(next),
        (record) =>
          scope.kind === 'room'
            ? roomMessageAuthor(next as StoredRoomMessage, record)
            : chatMessageAuthor(next, record)
      )
    if (retractedAt !== undefined) {
      noteRetractedIdentity(scope, verifiedAliases, next, retractedAt)
      next = { ...next, isRetracted: true, retractedAt }
    }
  }
  return next.isRetracted ? scrubRetractedContent(next) : next
}

/** The retraction scope a stored chat row belongs to. */
function chatScopeOf(row: { conversationId: string }, accountScope?: string | null): RetractionScope {
  return { kind: 'chat', entityId: row.conversationId, accountScope }
}

/** The retraction scope a stored room row belongs to. */
function roomScopeOf(row: { roomJid: string }, accountScope?: string | null): RetractionScope {
  return { kind: 'room', entityId: row.roomJid, accountScope }
}

// =============================================================================
// v4 room-store canonicalization (identity-resolving upsert + streaming migration)
// =============================================================================

let migrationFaultForTesting = false
/** @internal test seam — force the v4 migration to throw, to verify it aborts. */
export function _setMigrationFaultForTesting(on: boolean): void {
  migrationFaultForTesting = on
}

type RoomIdentityStore = {
  index(name: 'identityKeys'): { getAll(key: string): Promise<StoredRoomMessage[]> }
  index(name: 'ids'): { getAll(key: string): Promise<StoredRoomMessage[]> }
}

/** The minimal room-store surface the identity-resolving upsert needs. */
type RoomStoreLike = RoomIdentityStore & {
  get(key: string): Promise<StoredRoomMessage | undefined>
  put(v: StoredRoomMessage): Promise<unknown>
  delete(key: string): Promise<void>
}

/**
 * Every existing row in `m`'s strongest compatible identity component, de-duped
 * by cacheKey.
 */
async function findRoomRowsByIdentity(
  store: RoomIdentityStore,
  m: StoredRoomMessage,
  excludeKey?: string
): Promise<StoredRoomMessage[]> {
  const currentKeys = identityKeys(roomScope(m.roomJid), m)
  const orderedKeys = [...currentKeys, ...m.identityKeys.filter((key) => !currentKeys.includes(key))]
  return findRoomIdentityComponent(
    store.index('identityKeys'),
    m.roomJid,
    orderedKeys,
    m,
    excludeKey
  )
}

async function findRoomIdentityComponent(
  identityIndex: { getAll(key: string): Promise<StoredRoomMessage[]> },
  roomJid: string,
  orderedKeys: readonly string[],
  incoming: Pick<StoredRoomMessage, 'occupantId'>,
  excludeKey?: string
): Promise<StoredRoomMessage[]> {
  const selected = new Map<string, StoredRoomMessage>()
  let resolved = false
  for (const key of orderedKeys) {
    const rows = (await identityIndex.getAll(key)).filter((row) =>
      row.roomJid === roomJid &&
      row.cacheKey !== excludeKey &&
      !selected.has(row.cacheKey)
    )
    if (rows.length === 0) continue
    if (!resolved) {
      resolved = true
      for (const row of mergeableOccupantCandidates(incoming, rows)) {
        selected.set(row.cacheKey, row)
      }
      if (selected.size === 0) return []
      continue
    }
    for (const row of extendOccupantComponent(incoming, [...selected.values()], rows)) {
      selected.set(row.cacheKey, row)
    }
  }
  return [...selected.values()]
}

/**
 * Resolve the one cached row carrying client `id` WITHIN a room. The `ids` index is
 * store-wide and non-unique — client ids repeat across rooms, and per XEP-0359 an id
 * is unique only per (room, sender) — so a plain index `get` returns the
 * globally-first match and can land in the wrong room. Fetch every id match and keep
 * the one in this room; when the caller knows the sender, also match `from`. Returns
 * undefined when no row in the room carries the id. Shared by every room-aware
 * by-id lookup (getRoomMessage, updateRoomMessage, deleteRoomMessage).
 */
async function findRoomRowById(
  idsIndex: { getAll(key: string): Promise<StoredRoomMessage[]> },
  roomJid: string,
  id: string,
  from?: string,
  occupantId?: string
): Promise<StoredRoomMessage | undefined> {
  const matches = await idsIndex.getAll(id)
  const candidates = matches.filter((r) =>
    r.roomJid === roomJid &&
    (from === undefined || r.from === from)
  )
  const mergeable = mergeableOccupantCandidates({ occupantId }, candidates)
  return mergeable.find((candidate) =>
    !!occupantId && candidate.occupantId === occupantId
  ) ?? mergeable[0]
}

function roomRowBelongsToMessage(row: StoredRoomMessage, message: RoomMessage): boolean {
  if (occupantConflict(row, message)) return false
  const messageKeys = new Set(identityKeys(roomScope(message.roomJid), message))
  return row.identityKeys.some((key) => messageKeys.has(key))
}

async function findRoomRowsByReference(
  store: RoomIdentityStore,
  roomJid: string,
  reference: string
): Promise<{ tier: IdentityTier; authoritative: boolean; candidates: StoredRoomMessage[] } | undefined> {
  for (const probe of referenceProbes<StoredRoomMessage>(reference, 'archive-first')) {
    const matches = probe.tier === 'fallback'
      ? await store.index('ids').getAll(reference)
      : await store.index('identityKeys').getAll(
          probe.tier === 'stanzaId'
            ? tierKey(roomScope(roomJid), 'stanzaId', reference)
            : tierKey(roomScope(roomJid), 'originId', reference)
        )
    const candidates = matches.filter((row) => row.roomJid === roomJid)
    if (candidates.length > 0) {
      return { tier: probe.tier, authoritative: probe.authoritative, candidates }
    }
  }
  return undefined
}

/**
 * Core: resolve every existing row sharing any tier with `incoming` (echo,
 * live/MAM, bridge), merge them and `incoming` into one, delete the losers, put
 * the survivor. `incoming` is an already-serialized StoredRoomMessage, so callers
 * that need to PRESERVE accumulated aliases (updateRoomMessage) union them in
 * first. `excludeKey` skips a specific existing row from the merge — used when the
 * caller already holds that row's data in `incoming` and must not merge its
 * pre-update copy back in (which the union would do, re-adding a removed reaction).
 */
async function upsertStoredRoomRow(
  store: RoomStoreLike,
  incoming: StoredRoomMessage,
  excludeKey?: string,
  scopeJid?: string | null
): Promise<void> {
  const matches = await findRoomRowsByIdentity(store, incoming, excludeKey)
  let merged = incoming
  for (const row of matches) merged = mergeRoomRows(merged, row)
  const survivorKey = merged.cacheKey
  if (excludeKey && excludeKey !== survivorKey) await store.delete(excludeKey)
  for (const row of matches) if (row.cacheKey !== survivorKey) await store.delete(row.cacheKey)
  // The scrub is unconditional here BY DESIGN: only the mergeable occupant subset
  // is absorbed, so a reused nick cannot carry another occupant's tombstone here.
  // Two copies that carry NO occupant-id on either side remain indistinguishable —
  // there is no evidence to separate them, and inventing one would need durable
  // data the pre-XEP-0421 archive does not have.
  await store.put(enforceRetraction(merged, roomScopeOf(merged, scopeJid)))
}

/** Insert or merge a live-arriving message by identity (migration + archive write path). */
async function upsertRoomRowByIdentity(
  store: RoomStoreLike,
  message: RoomMessage,
  scopeJid?: string | null
): Promise<void> {
  await upsertStoredRoomRow(store, serializeRoomMessage(message), undefined, scopeJid)
}

/** Minimal cursor view over the legacy room store during migration. */
type LegacyRoomCursor = { value: StoredRoomMessage; continue(): Promise<LegacyRoomCursor | null> }
/** Minimal legacy-store view: stream every row out, then empty. */
type LegacyRoomStore = { openCursor(): Promise<LegacyRoomCursor | null>; clear(): Promise<void> }
/** Minimal version-change transaction view the streaming migration needs. */
type MigrationTransaction = { objectStore(name: string): unknown }

/**
 * Stream every legacy room row through the identity-resolving upsert into the
 * canonical store, one cursor step at a time (never `getAll()` the whole archive
 * into memory), then empty the legacy store. Runs inside the v4 version-change
 * transaction; any throw is caught by the caller, which aborts that transaction
 * atomically — so a partial rewrite can never be observed.
 */
async function migrateRoomStoreToCanonical(
  transaction: MigrationTransaction,
  scopeJid: string | null
): Promise<void> {
  const legacy = transaction.objectStore(LEGACY_ROOM_MESSAGES_STORE) as LegacyRoomStore
  const dest = transaction.objectStore(ROOM_MESSAGES_STORE) as RoomStoreLike
  let cursor = await legacy.openCursor()
  while (cursor) {
    if (migrationFaultForTesting) throw new Error('migration fault (test)')
    await upsertRoomRowByIdentity(dest, deserializeRoomMessage(cursor.value), scopeJid)
    cursor = await cursor.continue()
  }
  await legacy.clear() // legacy store now empty; a future version bump can drop it synchronously
}

// =============================================================================
// Chat Message Operations
// =============================================================================

type StoredMessageCursor = {
  value: StoredMessage
  continue(): Promise<StoredMessageCursor | null>
}

type ChatMessageReader = {
  get(key: string): Promise<StoredMessage | undefined>
  index(name: 'stanzaId'): { getAll(key: string): Promise<StoredMessage[]> }
  index(name: 'conv_timestamp'): {
    openCursor(range: IDBKeyRange): Promise<StoredMessageCursor | null>
  }
}

/** Minimal structural view of the idb chat-message object store. */
type ChatMessageStore = ChatMessageReader & {
  put(value: StoredMessage): Promise<unknown>
}

async function findChatRowsByReference(
  store: ChatMessageReader,
  conversationId: string,
  reference: string
): Promise<{ tier: IdentityTier; authoritative: boolean; candidates: StoredMessage[] } | undefined> {
  for (const probe of referenceProbes<StoredMessage>(reference, 'archive-first')) {
    const candidates = await findChatRowsForProbe(store, conversationId, reference, probe)
    if (candidates.length > 0) {
      return { tier: probe.tier, authoritative: probe.authoritative, candidates }
    }
  }
  return undefined
}

async function findChatRowsForProbe(
  store: ChatMessageReader,
  conversationId: string,
  reference: string,
  probe: IdentityProbe<StoredMessage>
): Promise<StoredMessage[]> {
  let matches: StoredMessage[] = []
  if (probe.tier === 'stanzaId') {
    matches = await store.index('stanzaId').getAll(reference)
  } else if (probe.tier === 'originId') {
    let cursor = await store.index('conv_timestamp').openCursor(
      entityTimestampRange(conversationId)
    )
    while (cursor) {
      if (probe.matches(cursor.value)) matches.push(cursor.value)
      cursor = await cursor.continue()
    }
  } else {
    const clientMatch = await store.get(reference)
    if (clientMatch) matches = [clientMatch]
  }
  return matches.filter(
    (row) => row.conversationId === conversationId && probe.matches(row)
  )
}

async function findChatRowsByIdentity(
  store: ChatMessageReader,
  message: Message
): Promise<StoredMessage[]> {
  for (const probe of identityProbes<StoredMessage>(message, 'archive-first')) {
    const matches = await findChatRowsForProbe(
      store,
      message.conversationId,
      probe.reference,
      probe
    )
    const candidates = probe.tier === 'fallback'
      ? matches.filter((row) => row.from === message.from)
      : matches
    if (candidates.length > 0) return candidates
  }
  return []
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
  // Date/Map/Set are objects but carry no own enumerable keys, so the object branch
  // below would collapse each to `{}` — making two values that differ only in such a
  // field stringify equal and breaking COMMUTATIVITY (not just the tiebreak). Not live
  // today (no content-projection field is a Date), but normalize Date defensively.
  // Map/Set remain hazards: content-projection fields must stay JSON-plain.
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const o = v as Record<string, unknown>
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
}

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
    stanzaId: _s, originId: _o, occupantId: _oi, timestamp: _t, reactions: _r,
    identityKeys: _ik, ids: _ids,
    isRetracted: _rt, retractedAt: _ra, isModerated: _m, moderatedBy: _mb, moderationReason: _mr,
    pollClosed: _pc, pollClosedAt: _pca, deliveryError: _de, cacheKey: _ck, ...content
  } = m
  return content
}

/**
 * Choose the CONTENT-owner row by a strict TOTAL order, so the choice is the same
 * regardless of argument order AND a tie happens only when the rows are identical.
 * Higher decryption rank, then edited, then non-empty body, then — the fix — a
 * stable serialization of the CONTENT PROJECTION (not the whole row), so two rows
 * differing in attachment / poll / reply / encryption metadata still resolve
 * deterministically instead of picking `a`. Serializing the projection rather than
 * the whole row is the LOAD-BEARING invariant for associativity: the fields
 * {@link contentProjection} excludes (aliases, reactions, timestamp, retraction,
 * moderation, poll closure, delivery error) CHANGE during a merge, so a whole-row
 * serialization would make the winner grouping-dependent (see contentProjection).
 */
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
 * so no edit, poll closure, retraction, reaction, moderation, mention, or alias
 * is lost.
 */
export function mergeRoomRows(a: StoredRoomMessage, b: StoredRoomMessage): StoredRoomMessage {
  const owner = contentOwner(a, b)
  const aSid = a.stanzaId != null, bSid = b.stanzaId != null
  const timestamp = aSid !== bSid ? (aSid ? a.timestamp : b.timestamp) : Math.min(a.timestamp, b.timestamp)
  const retracted = !!(a.isRetracted || b.isRetracted)
  const moderated = !!(a.isModerated || b.isModerated)
  // isMention is set only on the live stanza path and never recomputed for a MAM
  // copy of the same message (see countRoomUnreadInArchive's doc), so it must be
  // treated as MONOTONIC evidence here: an absent/false flag on one copy must
  // never erase a `true` established by the other. OR it independently of
  // contentOwner — taking it from `owner` alone would silently drop a live-set
  // `true` whenever the MAM copy (no flag) wins content ownership.
  const mentioned = !!(a.isMention || b.isMention)
  // Poll closure: symmetric even when both closed with different records.
  const pollClosed = a.pollClosed && b.pollClosed
    ? (stableStringify(a.pollClosed) <= stableStringify(b.pollClosed) ? a.pollClosed : b.pollClosed)
    : (a.pollClosed ?? b.pollClosed)

  const merged: StoredRoomMessage = {
    ...owner,
    stanzaId: minStr(a.stanzaId, b.stanzaId),
    originId: minStr(a.originId, b.originId),
    occupantId: minStr(a.occupantId, b.occupantId),
    timestamp,
    reactions: mergeReactions(a.reactions, b.reactions),
    identityKeys: unionSorted(a.identityKeys, b.identityKeys),
    ids: unionSorted(a.ids, b.ids),
    deliveryError: a.deliveryError && b.deliveryError ? (stableStringify(a.deliveryError) <= stableStringify(b.deliveryError) ? a.deliveryError : b.deliveryError) : undefined,
    ...(retracted ? { isRetracted: true, retractedAt: minNum(a.retractedAt, b.retractedAt) } : {}),
    ...(moderated ? { isModerated: true, moderatedBy: minStr(a.moderatedBy, b.moderatedBy), moderationReason: minStr(a.moderationReason, b.moderationReason) } : {}),
    ...(pollClosed ? { pollClosed, pollClosedAt: minNum(a.pollClosedAt, b.pollClosedAt) } : {}),
    ...(mentioned ? { isMention: true } : {}),
  }
  merged.cacheKey = canonicalKey(roomScope(merged.roomJid), merged)
  merged.identityKeys = unionSorted(merged.identityKeys, identityKeys(roomScope(merged.roomJid), merged))
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
  message: Message,
  scopeJid: string | null
): Promise<void> {
  const existing = (await findChatRowsByIdentity(store, message))[0]
  const incomingRank = decryptionRank(message)
  if (existing && incomingRank < 2 && decryptionRank(existing) > incomingRank) {
    // Existing entry is more recoverable — don't degrade it.
    return
  }
  // XEP-0424 is monotonic: a re-delivered copy of a retracted message (MAM
  // re-ingestion, a carbon) carries its original body and would otherwise
  // resurrect it. The chat twin of mergeRoomRows' retraction OR.
  const incoming =
    existing?.isRetracted
      ? { ...serializeMessage(message), isRetracted: true, retractedAt: existing.retractedAt }
      : serializeMessage(message)
  await store.put(enforceRetraction(incoming, chatScopeOf(incoming, scopeJid)))
}

/**
 * Save a chat message to IndexedDB.
 * Upserts - will overwrite if message with same ID exists, EXCEPT it never
 * degrades an already-decrypted entry (see {@link putChatMessageGuarded}).
 */
export async function saveMessageWithResult(message: Message): Promise<boolean> {
  const scopeJid = getStorageScopeJid()
  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction(MESSAGES_STORE, 'readwrite')
    await putChatMessageGuarded(tx.store, message, scopeJid)
    await tx.done
    return true
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to save message:', error)
    }
    return false
  }
}

export async function saveMessage(message: Message): Promise<void> {
  await saveMessageWithResult(message)
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

  const scopeJid = getStorageScopeJid()
  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction(MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(MESSAGES_STORE)

    for (const msg of messages) {
      await putChatMessageGuarded(store, msg, scopeJid)
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

export interface RoomMessageReference {
  roomJid: string
  id: string
  from?: string
  occupantId?: string
}

export async function getMessagesByReferences(
  chatIds: readonly string[],
  roomReferences: readonly RoomMessageReference[]
): Promise<{ chatMessages: Array<Message | null>; roomMessages: Array<RoomMessage | null> }> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction([MESSAGES_STORE, ROOM_MESSAGES_STORE], 'readonly')
    const chatStore = tx.objectStore(MESSAGES_STORE)
    const roomIds = tx.objectStore(ROOM_MESSAGES_STORE).index('ids')
    const [storedChatMessages, storedRoomMessages] = await Promise.all([
      Promise.all(chatIds.map(id => chatStore.get(id))),
      Promise.all(roomReferences.map(reference =>
        findRoomRowById(
          roomIds,
          reference.roomJid,
          reference.id,
          reference.from,
          reference.occupantId
        )
      )),
    ])
    await tx.done
    return {
      chatMessages: storedChatMessages.map(stored => stored ? deserializeMessage(stored) : null),
      roomMessages: storedRoomMessages.map(stored => stored ? deserializeRoomMessage(stored) : null),
    }
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get messages by references:', error)
    }
    return {
      chatMessages: chatIds.map(() => null),
      roomMessages: roomReferences.map(() => null),
    }
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
 * Key range over a `[entityId, timestamp]` compound index, pinned to one entity.
 *
 * BOTH ends must name the entity. A half-open range (`upperBound([id, t])` /
 * `lowerBound([id, t])`) bounds only the timestamp: everything belonging to
 * entities sorting before (resp. after) `id` is still inside it. The read loops
 * skip foreign rows but cannot STOP on them — `results.length < limit` never
 * trips once the walk has left the entity, and an unlimited read has no stop
 * condition at all — so the cursor walks the rest of the store, one awaited
 * `continue()` per row. On the activation path (`getMessagesAround` issues one
 * range of each shape) that turns a ~150-row read into a full-archive scan.
 *
 * Bounds carry the caller's exclusivity: `before` is an exclusive upper bound,
 * `after` an exclusive lower bound. The open end takes the same 0 /
 * MAX_SAFE_INTEGER sentinels the unfiltered range already uses.
 */
function entityTimestampRange(
  entityId: string,
  before?: Date,
  after?: Date
): IDBKeyRange {
  return IDBKeyRange.bound(
    [entityId, after ? after.getTime() : 0],
    [entityId, before ? before.getTime() : Number.MAX_SAFE_INTEGER],
    !!after, // exclude the lower bound only when the caller gave one
    !!before // ...same for the upper
  )
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

    // Key range: always pinned to this conversation at BOTH ends, whichever
    // subset of before/after the caller gave (see entityTimestampRange).
    const range = entityTimestampRange(conversationId, before, after)

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

// =============================================================================
// Archive count primitive (unread only — mentions stay on the live +1 path)
// =============================================================================

/** Default cap on the reported `unread` count — the badge saturates here. */
const DEFAULT_UNREAD_CAP = 999

export interface UnreadCountArgs {
  /** Cursor start: the read pointer's timestamp, or the entity's history watermark. */
  floor: Date
  /**
   * The read pointer's ORDER, for a strict-after-POSITION test rather than a
   * timestamp-only test — two messages can share a millisecond. Identity plays
   * no part in counting, so this deliberately takes `readPointer.order` rather
   * than the pointer: nothing here can reach for a name.
   *
   * A `floor` order (a pointer migrated from the pre-#1081 legacy fields) makes
   * {@link isAfterBoundary} read the boundary as at-or-after its timestamp — so
   * every row at the pointer's exact millisecond, including the pointer's own
   * message, resolves as "after" the pointer and gets counted. That is
   * at-or-after-TIMESTAMP semantics, not strict-after-timestamp: it over-counts
   * by up to the same-ms sibling set, which is the safe direction (an
   * over-count clears the moment the user reads; an under-count would hide a
   * message permanently). Omitting `pointer` entirely counts everything from
   * `floor`.
   */
  pointer?: PointerOrder
  /** Cap on the reported `unread` count. Default {@link DEFAULT_UNREAD_CAP}. */
  unreadCap?: number
}

/** Result of an archive unread count. */
export interface ArchiveCount {
  /** Renderable incoming messages strictly after the pointer, saturating at `unreadCap`. */
  unread: number
}

/**
 * Whether an archive row sorts strictly after the read boundary. No pointer
 * means everything from `floor` counts.
 *
 * This is the COUNTING question, so it uses {@link isAfterBoundary} — a `floor`
 * boundary means at-or-after its millisecond, which over-counts (safe). Never
 * hand-roll this comparison, and never substitute the advance comparator: its
 * floor rule is the opposite one (#1173).
 */
function isStrictlyAfterPointer(position: ExactPosition, pointerPosition: PointerOrder | undefined): boolean {
  return pointerPosition ? isAfterBoundary(position, pointerPosition) : true
}

/**
 * Count unread chat messages in the durable archive, independent of what is
 * resident in memory — the replacement for the incremental `+1` counter and the
 * bounded-slice recount, neither of which is correct for a backgrounded
 * conversation with deep history.
 *
 * Cursors `conv_timestamp` forward from `floor`, counting renderable incoming
 * rows strictly after the pointer's POSITION (not just its timestamp — see
 * {@link isStrictlyAfterPointer}). `unread` saturates at `unreadCap`; once it
 * reaches the cap there is nothing further this walk can learn, so it ends
 * there.
 *
 * This derives `unread` only. Mentions stay on the existing live `+1` counter
 * (`isMention` is set only on the live stanza path — see `Chat.ts` — and
 * never recomputed for archive rows, so an archive scan cannot report a
 * trustworthy mention count).
 *
 * Returns `null` on any IndexedDB error, so callers can distinguish "zero
 * unread" from "could not determine."
 */
export async function countUnreadInArchive(
  conversationId: string,
  args: UnreadCountArgs
): Promise<ArchiveCount | null> {
  const { floor, pointer, unreadCap = DEFAULT_UNREAD_CAP } = args
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(MESSAGES_STORE, 'readonly')
    const index = tx.store.index('conv_timestamp')
    const range = IDBKeyRange.bound([conversationId, floor.getTime()], [conversationId, Number.MAX_SAFE_INTEGER])

    const pointerPosition = pointer
    let unread = 0

    let cursor = await index.openCursor(range, 'next')
    while (cursor) {
      const stored = cursor.value
      if (stored.conversationId === conversationId) {
        const message = deserializeMessage(stored)
        if (!message.isOutgoing && isRenderableStoredMessage(message)) {
          const position: ExactPosition = {
            role: 'exact',
            timestamp: stored.timestamp,
            tiebreak: makeCacheOrderKey(message, 'chat'),
          }
          if (isStrictlyAfterPointer(position, pointerPosition)) {
            unread++
            if (unread >= unreadCap) break
          }
        }
      }
      cursor = await cursor.continue()
    }

    return { unread }
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to count unread in archive:', error)
    }
    return null
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
  updates: Partial<Message>,
  scopeJid: string | null = getStorageScopeJid(),
  expectedOwner?: Pick<Message, 'conversationId' | 'from'>
): Promise<void> {
  try {
    const db = await getDB(scopeJid)
    const existing = await db.get(MESSAGES_STORE, id)
    if (!existing) return
    if (expectedOwner && (
      existing.conversationId !== expectedOwner.conversationId ||
      existing.from !== expectedOwner.from
    )) return

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

    await db.put(MESSAGES_STORE, enforceRetraction(updated, chatScopeOf(updated, scopeJid)))
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
  conversationId: string,
  messageId: string,
  reactorJid: string,
  emojis: string[],
): Promise<boolean> {
  const scopeJid = getStorageScopeJid()
  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction(MESSAGES_STORE, 'readwrite')
    const existing = (await findChatRowsByReference(tx.store, conversationId, messageId))?.candidates[0]
    if (!existing) {
      await tx.done
      return false
    }

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

    await tx.store.put(enforceRetraction(updated, chatScopeOf(updated, scopeJid)))
    await tx.done
    return true
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to update message reactions in cache:', error)
    }
    return false
  }
}

export interface RetractionTargetResolution<T> {
  tier: IdentityTier
  authoritative: boolean
  candidates: T[]
}

/**
 * Every cached chat message a `<retract id="…">` reference could name, most
 * specific tier first.
 *
 * A retraction names ONE tier of its target (`Chat.getMessageReferenceId`), and
 * which tier it is depends on what the retracting client knew — so the reference
 * has to be tried against the whole ladder, not just the store's primary key.
 * Resolution stops at the highest tier with a match: indexed `stanzaId`, then
 * `originId` through a conversation-bounded cursor walk, then the primary-key
 * client id. Adding an origin-id index would be a schema change.
 *
 * Confined to `conversationId`: a client id is a name in one stream and repeats
 * across conversations.
 */
export async function findChatRetractionTargets(
  conversationId: string,
  targetId: string,
  scopeJid: string | null = getStorageScopeJid()
): Promise<RetractionTargetResolution<Message> | undefined> {
  try {
    const db = await getDB(scopeJid)
    const store = db.transaction(MESSAGES_STORE).store
    const resolution = await findChatRowsByReference(store, conversationId, targetId)
    return resolution
      ? { ...resolution, candidates: resolution.candidates.map(deserializeMessage) }
      : undefined
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to resolve chat retraction target:', error)
    }
    return undefined
  }
}

/**
 * Every cached chat row sharing any identity tier with `message`.
 *
 * Unlike reference resolution, this probes the complete ladder because a
 * resolved target can bridge several archive copies through different aliases.
 * The caller repeats this expansion for newly discovered authorized copies.
 */
export async function findChatMessageCopies(
  conversationId: string,
  message: Message,
  scopeJid: string | null = getStorageScopeJid()
): Promise<Message[]> {
  try {
    const db = await getDB(scopeJid)
    const store = db.transaction(MESSAGES_STORE).store
    const found = new Map<string, StoredMessage>()
    for (const probe of identityProbes<StoredMessage>(message, 'archive-first')) {
      const matches = await findChatRowsForProbe(
        store,
        conversationId,
        probe.reference,
        probe
      )
      const candidates = probe.tier === 'fallback'
        ? matches.filter((row) => row.from === message.from)
        : matches
      for (const candidate of candidates) found.set(candidate.id, candidate)
    }
    return [...found.values()].map(deserializeMessage)
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to expand chat message copies:', error)
    }
    return []
  }
}

/**
 * Every cached room message a `<retract id="…">` reference could name, most
 * specific tier first.
 *
 * Room twin of {@link findChatRetractionTargets}, resolved entirely through the
 * room-scoped `identityKeys` aliases plus the `ids` index. Every lookup is
 * confined to `roomJid`: stanza ids and origin ids are assigned per archive and
 * repeat across rooms, and client ids repeat everywhere.
 *
 * Resolution stops at the first tier with a match. MORE THAN ONE row can come
 * back from the `ids` tier alone — after a nick
 * reassignment an old archive copy and a recent message can share room, nick and
 * client id. The caller's XEP-0424 authorship gate (occupant-id first) decides
 * among rows within that tier, exactly as it does for a resident window.
 */
export async function findRoomRetractionTargets(
  roomJid: string,
  targetId: string,
  scopeJid: string | null = getStorageScopeJid()
): Promise<RetractionTargetResolution<RoomMessage> | undefined> {
  try {
    const db = await getDB(scopeJid)
    const store = db.transaction(ROOM_MESSAGES_STORE).store
    const resolution = await findRoomRowsByReference(store, roomJid, targetId)
    return resolution
      ? { ...resolution, candidates: resolution.candidates.map(deserializeRoomMessage) }
      : undefined
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to resolve room retraction target:', error)
    }
    return undefined
  }
}

export interface RoomMessageCopy {
  cacheKey: string
  identityKeys: string[]
  ids: string[]
  message: RoomMessage
}

export async function findRoomMessageCopies(
  roomJid: string,
  message: RoomMessage,
  scopeJid: string | null = getStorageScopeJid()
): Promise<RoomMessageCopy[]> {
  try {
    const db = await getDB(scopeJid)
    const store = db.transaction(ROOM_MESSAGES_STORE).store
    const found = new Map<string, StoredRoomMessage>()
    const queue = [serializeRoomMessage(message)]
    for (let index = 0; index < queue.length; index++) {
      const matches = await findRoomRowsByIdentity(store, queue[index])
      for (const row of matches) {
        if (row.roomJid !== roomJid || found.has(row.cacheKey)) continue
        found.set(row.cacheKey, row)
        queue.push(row)
      }
    }
    return [...found.values()].map((row) => ({
      cacheKey: row.cacheKey,
      identityKeys: row.identityKeys,
      ids: row.ids,
      message: deserializeRoomMessage(row),
    }))
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to expand room message copies:', error)
    }
    return []
  }
}

/**
 * Which of these messages the durable archive already holds as a tombstone,
 * positionally aligned with the input.
 *
 * The search index has no retraction state of its own and an incoming copy
 * carries none either: an archive re-delivery of a message retracted in an
 * EARLIER session arrives with its original body, and nothing but the cache row
 * remembers otherwise. One readonly transaction probes every identity tier the
 * incoming room copy carries; a merged row keeps every absorbed tier in
 * `identityKeys`.
 */
export async function areRetractedInCache(
  messages: readonly (Message | RoomMessage)[],
  scopeJid: string | null = getStorageScopeJid()
): Promise<boolean[]> {
  const verdicts = new Array<boolean>(messages.length).fill(false)
  if (messages.length === 0) return verdicts

  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction([MESSAGES_STORE, ROOM_MESSAGES_STORE], 'readonly')
    const chatRows = tx.objectStore(MESSAGES_STORE)
    const roomRows = tx.objectStore(ROOM_MESSAGES_STORE).index('identityKeys')
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i]
      if (message.type === 'groupchat') {
        const candidates = await findRoomIdentityComponent(
          roomRows,
          message.roomJid,
          identityKeys(roomScope(message.roomJid), message),
          message
        )
        verdicts[i] = candidates.some((row) => row.isRetracted === true)
      } else {
        const rows = await findChatRowsByIdentity(chatRows, message)
        verdicts[i] = rows.some((row) => row.isRetracted === true)
      }
    }
    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to read retraction state from cache:', error)
    }
  }
  return verdicts
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
export async function saveRoomMessageWithResult(message: RoomMessage): Promise<boolean> {
  return saveRoomMessages([message])
}

export async function saveRoomMessage(message: RoomMessage): Promise<void> {
  await saveRoomMessageWithResult(message)
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

  const scopeJid = getStorageScopeJid()
  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(ROOM_MESSAGES_STORE)

    // Sequential, NOT Promise.all: each upsert resolves existing rows by identity
    // and merges, so a same-batch optimistic+reflection pair must collapse into one
    // row — the second upsert has to observe the first's write. Concurrent puts would
    // each see an empty store and leave two rows.
    for (const msg of messages) await upsertRoomRowByIdentity(store as never, msg, scopeJid)
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
 * Get a room message by its client-generated ID, scoped to a room.
 *
 * Client ids repeat across rooms (and, per XEP-0359, are unique only per sender), so
 * the store-wide `ids` index is filtered to `roomJid` — pass `from` to also pin the
 * sender. A MERGED row carries every absorbed client id in `ids[]`, so it stays
 * findable by ANY of them. See {@link findRoomRowById}.
 */
export async function getRoomMessage(
  roomJid: string,
  id: string,
  from?: string,
  occupantId?: string
): Promise<RoomMessage | null> {
  try {
    const db = await getDB(getStorageScopeJid())
    const stored = await findRoomRowById(
      db.transaction(ROOM_MESSAGES_STORE).store.index('ids'),
      roomJid,
      id,
      from,
      occupantId
    )
    return stored ? deserializeRoomMessage(stored) : null
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get room message:', error)
    }
    return null
  }
}

/**
 * Get a room message by its stanzaId, scoped to a room.
 *
 * stanzaIds are assigned per-archive and repeat across rooms, so the global
 * `stanzaId` index could return a different room's message. Resolving through the
 * room-scoped `identityKeys` alias ({@link tierKey}) confines the lookup to
 * this room, and also finds a MERGED row (which carries the stanza tier in its
 * `identityKeys[]` even when the survivor's own `stanzaId` scalar came from a
 * different copy).
 */
export async function getRoomMessageByStanzaId(
  roomJid: string,
  stanzaId: string
): Promise<RoomMessage | null> {
  try {
    const db = await getDB(getStorageScopeJid())
    const stored = await db.getFromIndex(ROOM_MESSAGES_STORE, 'identityKeys', tierKey(roomScope(roomJid), 'stanzaId', stanzaId))
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

    // Key range: pinned to this room at both ends (see entityTimestampRange).
    const range = entityTimestampRange(roomJid, before, after)

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

  let anchor = await getRoomMessage(roomJid, anchorMessageId)
  if (!anchor) anchor = await getRoomMessageByStanzaId(roomJid, anchorMessageId)
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

  const merged: RoomMessage[] = []
  for (const m of [...olderAndAnchor, ...newer]) {
    const keys = new Set(identityKeys(roomScope(roomJid), m))
    const candidates = merged.filter((resident) =>
      identityKeys(roomScope(roomJid), resident).some((key) => keys.has(key))
    )
    const matches = mergeableOccupantCandidates(m, candidates)
    if (matches.some((resident) => sameLogicalMessage(roomScope(roomJid), resident, m))) continue
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
 * Count unread room messages in the durable archive, independent of what is
 * resident in memory. Room counterpart of {@link countUnreadInArchive} — see it
 * for the general shape.
 *
 * Cursors `room_ts_from_id` — `[roomJid, timestamp, from, id]` — forward from
 * `floor`. This is that index's first consumer. The upper bound is
 * `[roomJid, Infinity, '￿', '￿']`; every row in range is visited and
 * adjudicated independently by {@link isAfterBoundary}, so it is the `Infinity`
 * in the timestamp slot — not the `'￿'` string sentinels — that makes the
 * bound safe: any finite timestamp compares less than `Infinity`, so the
 * trailing `from`/`id` components are never actually reached. Swapping
 * `Infinity` for `Number.MAX_SAFE_INTEGER` (the convention used in the chat
 * range above) would make those sentinels suddenly load-bearing, and could
 * silently drop a row whose `from` sorts above `'￿'`. `unread` saturates at
 * `unreadCap`; once it reaches the cap there is nothing further this walk can
 * learn, so it ends there.
 *
 * This derives `unread` only, deliberately — an earlier revision of this
 * primitive also tallied mentions from the archive, but `isMention` is set
 * only on the live stanza path (`Chat.ts`'s `checkForMention`) and is never
 * recomputed for MAM rows (`MAM.ts`'s `RoomMessage` construction), so an
 * archive scan reports `0` for every mention that arrived while offline —
 * and a "complete scan may lower the count" rule would zero out a correctly
 * live-counted mention. Mentions stay on the existing live `+1` counter,
 * cleared by explicit read / mark-read.
 *
 * Returns `null` on any IndexedDB error, so callers can distinguish "zero
 * unread" from "could not determine."
 */
export async function countRoomUnreadInArchive(roomJid: string, args: UnreadCountArgs): Promise<ArchiveCount | null> {
  const { floor, pointer, unreadCap = DEFAULT_UNREAD_CAP } = args
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readonly')
    const index = tx.store.index('room_ts_from_id')
    const range = IDBKeyRange.bound([roomJid, floor.getTime(), '', ''], [roomJid, Infinity, '￿', '￿'])

    const pointerPosition = pointer
    let unread = 0

    let cursor = await index.openCursor(range, 'next')
    while (cursor) {
      const stored = cursor.value
      if (stored.roomJid === roomJid) {
        const message = deserializeRoomMessage(stored)
        if (!message.isOutgoing && isRenderableStoredMessage(message)) {
          const position: ExactPosition = {
            role: 'exact',
            timestamp: stored.timestamp,
            tiebreak: makeCacheOrderKey(message, 'room'),
          }
          if (isStrictlyAfterPointer(position, pointerPosition)) {
            unread++
            if (unread >= unreadCap) break
          }
        }
      }
      cursor = await cursor.continue()
    }

    return { unread }
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to count room unread in archive:', error)
    }
    return null
  }
}

/**
 * Resolve an archive id — a MAM `page.first`/`page.last` value, which is what a
 * {@link CoverageRecord}'s `bottomId` names — to its position in archive
 * order. `parseArchiveMessage`/`parseRoomArchiveMessage` (`MAM.ts`) store this
 * id as the row's `stanzaId` (`stanzaId = parsed.stanzaId || archiveId`), so
 * the lookup goes through the stanza-id path, never the client-generated
 * `id`. Rooms reuse their own per-archive id sequence, so a bare `stanzaId`
 * index lookup could return a DIFFERENT room's row — {@link
 * getRoomMessageByStanzaId} confines it to `entityId` (room-scoping
 * footgun, see that function's doc). Chat's single per-account archive makes
 * a plain `getMessageByStanzaId` lookup unambiguous.
 *
 * Returns `null` when the id is not cached (evicted, or the coverage record
 * is stale) — the caller (`resolveCoverageBottom`) turns that into
 * `'unresolvable'` rather than treating it as "nothing to resolve."
 */
export async function resolveArchivePosition(
  entityId: string,
  archiveId: string,
  isRoom: boolean
): Promise<ExactPosition | null> {
  const message = isRoom
    ? await getRoomMessageByStanzaId(entityId, archiveId)
    : await getMessageByStanzaId(archiveId)
  if (!message) return null
  return exactPosition(message, isRoom ? 'room' : 'chat')
}

/**
 * Update specific fields of a room message, resolving the row through the room-scoped
 * `ids` alias so a caller holding a pre-merge id still finds it. Client ids repeat
 * across rooms, so the lookup is confined to `roomJid` (and `from` when the caller
 * knows the sender) — otherwise the update could mutate another room's message.
 *
 * When an update carries an identity FIELD it splits two ways:
 *   - Expansion (a new stanzaId/originId, or a changed id) — the existing row's
 *     accumulated aliases are unioned into the updated row, then it is re-keyed
 *     and any OTHER row already at the new identity tier is merged in.
 *   - Revocation ({ stanzaId: undefined }, as clearMessageStanzaId sends) — the
 *     cleared tier's scoped alias is REMOVED from identityKeys, so a later message
 *     carrying that stanzaId no longer resolves to this row and is not wrongly
 *     merged in.
 */
export async function updateRoomMessage(
  roomJid: string,
  id: string,
  updates: Partial<RoomMessage>,
  from?: string,
  scopeJid: string | null = getStorageScopeJid(),
  expectedOwner?: RoomMessage,
  expectedCacheKey?: string
): Promise<void> {
  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(ROOM_MESSAGES_STORE)
    const existing = expectedCacheKey
      ? await store.get(expectedCacheKey)
      : await findRoomRowById(
          store.index('ids'),
          roomJid,
          id,
          from,
          expectedOwner?.occupantId ?? updates.occupantId
        )
    if (!existing) { await tx.done; return }
    if (expectedOwner && !roomRowBelongsToMessage(existing, expectedOwner)) {
      await tx.done
      return
    }
    const updated = { ...deserializeRoomMessage(existing), ...updates } as RoomMessage
    const serialized = serializeRoomMessage(updated)
    // The in-place path requires both unchanged identity fields and an unchanged
    // serialized key. Either kind of change needs the merge/re-key path below.
    if (identityFieldsEqual(updated, existing) && serialized.cacheKey === existing.cacheKey) {
      const row = serialized
      row.identityKeys = existing.identityKeys // unchanged
      row.ids = existing.ids
      await store.put(enforceRetraction(row, roomScopeOf(row, scopeJid)))
    } else {
      // An identity field changed. Union the existing row's accumulated aliases in
      // (do NOT delete-then-upsert — a deleted row cannot be rediscovered, and
      // re-serialization resets ids/identityKeys). But a REVOCATION ({ stanzaId:
      // undefined }) must REMOVE the cleared scoped alias, not union it back:
      const revoked: string[] = []
      if ('stanzaId' in updates && updated.stanzaId == null && existing.stanzaId) revoked.push(tierKey(roomScope(existing.roomJid), 'stanzaId', existing.stanzaId))
      if ('originId' in updates && updated.originId == null && existing.originId) revoked.push(tierKey(roomScope(existing.roomJid), 'originId', existing.originId))

      const row = serialized // ids=[updated.id]; identityKeys reflect current fields (a revoked tier is already absent)
      row.ids = unionSorted(existing.ids, row.ids)
      row.identityKeys = unionSorted(existing.identityKeys, row.identityKeys).filter((k) => !revoked.includes(k))
      // excludeKey = old cacheKey: overwrites when the canonical key is unchanged,
      // re-keys + deletes the stale row when it changed; either way the pre-update
      // copy is not merged back in. The finder uses row.identityKeys (revoked tier
      // absent), so a row legitimately still carrying that stanzaId is NOT pulled in.
      await upsertStoredRoomRow(store as never, row, existing.cacheKey, scopeJid)
    }
    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to update room message:', error)
    }
  }
}

/**
 * Update reactions for a room message in IndexedDB.
 * Used as a fallback when the message is not currently loaded in memory.
 * Resolves the target strictly within `roomJid` — a reaction may reference either
 * a room-scoped stanza-id or a client id, and BOTH repeat across rooms.
 *
 * @returns true if the message was found and updated, false otherwise.
 */
export async function updateRoomMessageReactions(
  roomJid: string,
  messageId: string,
  reactorNick: string,
  emojis: string[],
): Promise<boolean> {
  const scopeJid = getStorageScopeJid()
  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const store = tx.store

    // Both resolution paths must be confined to THIS room, or a collision in
    // another room wins. A MUC reaction references the server stanza-id, which
    // repeats across rooms (per-archive) — so we resolve it through the
    // room-scoped `identityKeys` alias (tierKey), a single indexed get.
    // The `ids` multiEntry index is store-wide and non-unique, and cacheKeys sort
    // by room JID, so getFromIndex('ids', …) could return a DIFFERENT room's
    // message when a client id collides; take every id match and keep the one in
    // this room. (Mirrors getRoomMessageByStanzaId's room-scoping.)
    const resolution = await findRoomRowsByReference(store, roomJid, messageId)
    const existing = resolution && canMergeOccupantSet(resolution.candidates)
      ? resolution.candidates[0]
      : undefined
    if (!existing) {
      await tx.done
      return false
    }

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

    // Authoritative: apply the change to the found row and put under its OWN
    // cacheKey — never route through mergeRoomRows, whose reaction-union would
    // resurrect a reactor this call just removed.
    const updated = {
      ...existing,
      reactions: Object.keys(newReactions).length > 0 ? newReactions : undefined,
    }

    await store.put(enforceRetraction(updated, roomScopeOf(updated, scopeJid)))
    await tx.done
    return true
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to update room message reactions in cache:', error)
    }
    return false
  }
}

/**
 * Delete a room message by ID, scoped to a room.
 * Resolves the row through the room-scoped `ids` alias (so a pre-merge id still finds
 * a merged row, and a colliding id in another room is not deleted), then deletes by
 * its cacheKey (the primary key). Pass `from` to also pin the sender.
 */
export async function deleteRoomMessage(
  roomJid: string,
  id: string,
  from?: string,
  occupantId?: string
): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const existing = await findRoomRowById(tx.store.index('ids'), roomJid, id, from, occupantId)
    // Delete using the cacheKey (the actual primary key)
    if (existing) await tx.store.delete(existing.cacheKey)
    await tx.done
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

/**
 * Expose {@link contentProjection} so tests can assert its contract directly
 * (which fields it omits/includes) rather than only exercising it indirectly
 * through {@link mergeRoomRows}. For testing only.
 * @internal
 */
export function _contentProjectionForTesting(m: StoredRoomMessage): unknown {
  return contentProjection(m)
}
