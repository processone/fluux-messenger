/**
 * Full-text search index using a custom inverted index stored in IndexedDB.
 *
 * Token posting lists and document metadata are loaded on demand from IndexedDB.
 *
 * Uses the same scoped-DB pattern as messageCache.ts.
 *
 * @module SearchIndex
 */

import { openDB, type IDBPDatabase, type IDBPTransaction, type DBSchema } from 'idb'
import { openGuarded } from './idbConnection'
import type { Message, RoomMessage } from '../core/types'
import { isNoLocalStore } from '../core/types/message-internal'
import { captureStorageScope, getStorageScopeJid } from './storageScope'
import {
  chatRetractionAliases,
  ensureRetractionLedger,
  roomRetractionAliases,
  retractedAtForIdentity,
  type RetractionScope,
} from './retractedIdentities'
import * as messageCache from './messageCache'
import { setChatIdentityObserver } from './chatIdentityObserver'
import { roomRetractionRecordApplies } from './moderation'
import { getRoomModerationId, roomStanzaIdsMergeable } from './roomStanzaId'
import { messageFilterTokens } from './searchFilters'

import {
  archiveIdentityConflict,
  canonicalKey,
  CHAT_SCOPE,
  chatMessageAuthor,
  firstDeliveryConflict,
  identityKeys,
  isFirstDelivery,
  occupantConflict,
  receiptQualifiedKey,
  roomMessageAuthor,
  roomScope,
  searchDocumentFallbackKey,
  searchDocumentKey,
} from './messageIdentity'

const DB_NAME = 'fluux-search-index'
const DB_VERSION = 6
const TOKENS_STORE = 'search-tokens'
const DOCS_STORE = 'search-docs'
const META_STORE = 'search-meta'
/** Time-sorted rows keyed `[token, -timestamp, docNo]`: negative time makes ascending keys newest first. */
const POSTINGS_STORE = 'search-postings'
/** Meta keys of the time-sorted index. */
const NEXT_DOC_NO_KEY = 'next-doc-no'
const POSTINGS_READY_KEY = 'postings-ready'
const POSTINGS_CURSOR_KEY = 'postings-cursor'
/** Meta keys of the filter tokens copy (version 6): every document carries `filterTokens` once ready. */
const FILTERS_READY_KEY = 'filters-ready'
const FILTERS_CURSOR_KEY = 'filters-cursor'
const FILTERS_BUILD_KEY = 'filters-build'
const FILTERS_BUILD = '2'
const FILTERS_UNKNOWN_KEY = 'filters-unknown'
const filterErrors = new Map<string | null, string>()
const filterListeners = new Set<() => void>()
const filterChannel = typeof window !== 'undefined' && typeof window.BroadcastChannel === 'function'
  ? new window.BroadcastChannel('fluux-search-filters') : null
if (filterChannel) filterChannel.onmessage = event => {
  if (event.data === getStorageScopeJid()) notifyFilterIndex(false)
}

export function subscribeFilterIndex(listener: () => void): () => void {
  filterListeners.add(listener)
  return () => { filterListeners.delete(listener) }
}

function notifyFilterIndex(broadcast = true): void {
  for (const listener of filterListeners) listener()
  if (broadcast) filterChannel?.postMessage(getStorageScopeJid())
}
const pendingMutations = new Map<string | null, Promise<void>>()
const pendingMaintenance = new Map<string | null, Promise<unknown>>()

async function maintainIndex<T>(scopeJid: string | null, operation: () => Promise<T>): Promise<T> {
  const previous = pendingMaintenance.get(scopeJid) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(operation)
  pendingMaintenance.set(scopeJid, pending)
  try { return await pending } finally {
    if (pendingMaintenance.get(scopeJid) === pending) pendingMaintenance.delete(scopeJid)
  }
}

async function mutateIndex(scopeJid: string | null, mutation: () => Promise<void>): Promise<void> {
  const previous = pendingMutations.get(scopeJid) ?? Promise.resolve()
  const pending = previous.catch(() => {}).then(mutation)
  pendingMutations.set(scopeJid, pending)
  try { await pending } finally {
    if (pendingMutations.get(scopeJid) === pending) pendingMutations.delete(scopeJid)
  }
}

/** Minimum token length to index (skip single characters) */
const MIN_TOKEN_LENGTH = 2

/** Default max results returned by search */
const DEFAULT_SEARCH_LIMIT = 50

// =============================================================================
// Types
// =============================================================================

interface TokenEntry {
  token: string
  postings: string[] // indexId values
}

interface DocEntry {
  indexId: string
  messageId: string // client-generated message.id (matches data-message-id in DOM)
  tokens: string[]
  conversationId: string
  from: string
  nick?: string // sender nickname (room messages only)
  timestamp: number
  isRoom: boolean
  body: string
  /**
   * Optional here BY DESIGN, unlike SearchIndexResult: a DocEntry is read back
   * from IndexedDB, where a document written before these fields existed carries
   * no such key at all. Requiring them would have the type claim a guarantee the
   * stored data does not make.
   */
  stanzaId?: string
  originId?: string
  occupantId?: string
  /** Delivery evidence the room `from+id` rung reads; absent on older documents. */
  isDelayed?: boolean
  isOutgoing?: boolean
  receivedAt?: number
  /** Derived room-scoped lookup keys; older room documents receive them on upgrade. */
  identityKeys?: string[]
  /**
   * Reserved tokens for `from:`, `is:mine` and `has:` ({@link messageFilterTokens}).
   * They get time-sorted rows like words but stay out of the old token lists.
   * Absent on a document the version 6 copy has not reached yet.
   */
  filterTokens?: string[]
  filterBuild?: string
  filterContentUnknown?: boolean
  /**
   * Short unique number naming this document in {@link POSTINGS_STORE} rows.
   * Absent until the background copy or a write numbers the document.
   */
  docNo?: number
}

interface MetaEntry {
  key: string
  value: string
}

interface SearchIndexSchema extends DBSchema {
  [TOKENS_STORE]: {
    key: string
    value: TokenEntry
  }
  [DOCS_STORE]: {
    key: string
    value: DocEntry
    indexes: {
      conversationId: string
      identityKeys: string
      docNo: number
    }
  }
  [POSTINGS_STORE]: {
    key: [string, number, number]
    value: 1
  }
  [META_STORE]: {
    key: string
    value: MetaEntry
  }
}

/**
 * Result returned by the search index.
 * Contains document metadata and body for snippet generation.
 */
export interface SearchIndexResult {
  indexId: string
  messageId: string
  conversationId: string
  from: string
  nick?: string
  timestamp: number
  isRoom: boolean
  body: string
  /**
   * XEP-0359 / XEP-0421 identity. REQUIRED, though each may be undefined: a
   * projection that omits one produces a document no identity-verified removal
   * can prove it owns, and this result type has already lost them once. Required
   * means every construction site must state what it carries, so dropping a tier
   * is a build error rather than a review finding.
   */
  stanzaId: string | undefined
  originId: string | undefined
  occupantId: string | undefined
  /** Delivery evidence the room `from+id` rung reads (`firstDeliveryConflict`). */
  isDelayed?: boolean
  isOutgoing?: boolean
  receivedAt?: number
}

// =============================================================================
// Database management
// =============================================================================

let dbPromise: Promise<IDBPDatabase<SearchIndexSchema>> | null = null
let dbNameForPromise: string | null = null

const IDENTITY_MIGRATION_BATCH_SIZE = 256

/** Backfill without materializing an entire account's search documents at once. */
async function backfillRoomIdentityKeys(store: {
  getAll(query: IDBKeyRange | undefined, count: number): Promise<DocEntry[]>
  put(doc: DocEntry): Promise<unknown>
}): Promise<void> {
  let rows = await store.getAll(undefined, IDENTITY_MIGRATION_BATCH_SIZE)
  while (rows.length > 0) {
    await Promise.all(rows.filter(doc => doc.isRoom).map(async doc =>
      store.put({ ...doc, identityKeys: roomDocumentIdentityKeys(doc) }),
    ))
    rows = await store.getAll(
      IDBKeyRange.lowerBound(rows[rows.length - 1].indexId, true),
      IDENTITY_MIGRATION_BATCH_SIZE,
    )
  }
}

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

function getDB(
  scopeJid: string | null = getStorageScopeJid()
): Promise<IDBPDatabase<SearchIndexSchema>> {
  if (!isIndexedDBAvailable()) {
    return Promise.reject(new Error('IndexedDB not available'))
  }

  const targetDbName = getScopedDbName(scopeJid)

  if (dbPromise && dbNameForPromise === targetDbName) {
    return dbPromise
  }

  // Close previous DB if scope changed
  if (dbPromise && dbNameForPromise && dbNameForPromise !== targetDbName) {
    const previousPromise = dbPromise
    dbPromise = null
    dbNameForPromise = null
    void previousPromise.then((db) => db.close()).catch(() => {})
  }

  dbNameForPromise = targetDbName
  const forget = () => {
    if (dbPromise !== opening) return
    dbPromise = null
    dbNameForPromise = null
  }
  const opening = openGuarded((hooks) => openDB<SearchIndexSchema>(targetDbName, DB_VERSION, {
    upgrade(db, oldVersion, _newVersion, tx) {
      void tx.done.catch(() => {})
      if (!hooks.proceed()) {
        tx.abort()
        return
      }
      if (!db.objectStoreNames.contains(TOKENS_STORE)) {
        db.createObjectStore(TOKENS_STORE, { keyPath: 'token' })
      }
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        const docsStore = db.createObjectStore(DOCS_STORE, { keyPath: 'indexId' })
        docsStore.createIndex('conversationId', 'conversationId', { unique: false })
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' })
      }
      // Created before the early return below, or an upgrading database skips them.
      if (!db.objectStoreNames.contains(POSTINGS_STORE)) db.createObjectStore(POSTINGS_STORE)
      const numberedDocs = tx.objectStore(DOCS_STORE)
      if (!numberedDocs.indexNames.contains('docNo')) numberedDocs.createIndex('docNo', 'docNo', { unique: true })
      // A brand-new database has nothing to copy, so it starts ready.
      if (oldVersion === 0) {
        void tx.objectStore(META_STORE).put({ key: POSTINGS_READY_KEY, value: '1' })
        void tx.objectStore(META_STORE).put({ key: FILTERS_READY_KEY, value: '1' })
        void tx.objectStore(META_STORE).put({ key: FILTERS_BUILD_KEY, value: FILTERS_BUILD })
      }
      // Guarded: a later version bump re-runs this callback on a store that
      // already has the index, and re-creating it throws ConstraintError,
      // which aborts the upgrade and leaves search unable to open.
      const docsStore = tx.objectStore(DOCS_STORE)
      // Results are sorted in memory, so nothing reads a timestamp index.
      if ((docsStore.indexNames as DOMStringList).contains('timestamp')) docsStore.deleteIndex('timestamp')
      if (docsStore.indexNames.contains('identityKeys')) return
      docsStore.createIndex('identityKeys', 'identityKeys', { multiEntry: true })
      if (oldVersion > 0) {
        // The version-change transaction makes the backfill atomic with the
        // index. A failed write must not leave old documents undiscoverable.
        void backfillRoomIdentityKeys(docsStore).catch(() => {
          try { tx.abort() } catch { /* The failed request may already have aborted it. */ }
        })
      }
    },
    blocked: hooks.blocked,
    blocking: (_currentVersion, blockedVersion, event) => hooks.release(event.target as IDBDatabase, blockedVersion),
    terminated: hooks.lost,
  }), { database: targetDbName, onClosed: forget })
  dbPromise = opening
  void opening.catch(forget)
  return opening
}

// =============================================================================
// Tokenization & Query Parsing
// =============================================================================

/**
 * Tokenize text into lowercase words.
 * Unicode-aware: splits on non-letter/non-number boundaries.
 * Drops tokens shorter than MIN_TOKEN_LENGTH.
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH)
}

/**
 * Parsed search query with quoted phrases and unquoted terms.
 */
export interface ParsedQuery {
  /** Exact phrases extracted from quoted segments (lowercased) */
  phrases: string[]
  /** Individual tokens from unquoted segments */
  terms: string[]
  /** Whether the last unquoted term should get prefix matching */
  lastTermPrefix: boolean
}

/**
 * Parse a search query into quoted phrases and unquoted terms.
 *
 * Quoted segments (`"exact phrase"`) are extracted as phrases for contiguous
 * substring matching. Everything outside quotes is tokenized normally.
 * The last unquoted token gets prefix matching for search-as-you-type,
 * unless the query ends with a closing quote.
 *
 * @example
 * parseSearchQuery('meeting "quarterly report"')
 * // { phrases: ["quarterly report"], terms: ["meeting"], lastTermPrefix: false }
 *
 * parseSearchQuery('"hello world" foo')
 * // { phrases: ["hello world"], terms: ["foo"], lastTermPrefix: true }
 */
export function parseSearchQuery(query: string): ParsedQuery {
  const phrases: string[] = []
  const termParts: string[] = []

  // Match quoted segments and capture everything outside them
  const quoteRegex = /"([^"]*?)"/g
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = quoteRegex.exec(query)) !== null) {
    // Collect text before this quoted segment
    if (match.index > lastIndex) {
      termParts.push(query.slice(lastIndex, match.index))
    }
    // Add the quoted content as a phrase (if non-empty after trimming)
    const phrase = match[1].trim().toLowerCase()
    if (phrase.length > 0) {
      phrases.push(phrase)
    }
    lastIndex = quoteRegex.lastIndex
  }

  // Collect remaining text after the last quote
  if (lastIndex < query.length) {
    termParts.push(query.slice(lastIndex))
  }

  // Tokenize all unquoted segments
  const terms = tokenize(termParts.join(' '))

  // Prefix matching: enabled if there are unquoted terms and the raw query
  // ends with an unquoted segment (not a closing quote)
  const trimmed = query.trimEnd()
  const endsWithQuote = trimmed.endsWith('"') && phrases.length > 0
  const lastTermPrefix = terms.length > 0 && !endsWithQuote

  return { phrases, terms, lastTermPrefix }
}

/**
 * Get unique tokens from text.
 */
function uniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))]
}

// =============================================================================
// Index ID helpers
// =============================================================================

/**
 * Build a composite index ID to avoid collisions between chat and room messages.
 * The room form comes from {@link searchDocumentKey} — a persisted shape. The chat
 * form is the cache row's conversation-qualified canonical key
 * ({@link messageCache.chatCacheKey}), also persisted: a client id alone cannot
 * distinguish conversations or conflicting archive identities.
 */
function getIndexId(message: Message | RoomMessage): string {
  if (message.type === 'groupchat') {
    return `room:${searchDocumentKey(message)}`
  }
  return `chat:${messageCache.chatCacheKey(message)}`
}

/**
 * The chat document ids a row may ALSO have been indexed under before its
 * archive id or origin id arrived: the canonical key follows the highest tier
 * present, so the same message is keyed by each lower rung in turn.
 */
function getChatFallbackIndexIds(message: Message): string[] {
  const own = getIndexId(message)
  const lower = (stanzaId?: string, originId?: string) =>
    `chat:${messageCache.chatCacheKey({ ...message, stanzaId, originId })}`
  return [
    ...(message.stanzaId ? [lower(undefined, message.originId)] : []),
    ...(message.stanzaId || message.originId ? [lower(undefined, undefined)] : []),
  ].filter((id, i, all) => id !== own && all.indexOf(id) === i)
}

/** The chat document id a cache row's identity key names, in `conversationId`. */
function chatIndexIdForKey(conversationId: string, identityKey: string): string {
  return `chat:${conversationId}\u0000${identityKey}`
}

function getChatRemovalIds(message: Message, closure?: ChatIdentityClosure, source?: Message | RoomMessage): string[] {
  return [...new Set([
    getIndexId(message),
    ...getChatFallbackIndexIds(message),
    ...(closure?.identityKeys ?? []).map(key => chatIndexIdForKey(message.conversationId, key)),
    ...(closure?.ids ?? []).map(id => getIndexId({ ...message, id, stanzaId: undefined, originId: undefined })),
    ...(source ? [getIndexId(source)] : []),
  ])]
}

/**
 * The index ids a message may ALSO be stored under, besides {@link getIndexId}.
 */
function getFallbackIndexIds(message: RoomMessage): string[] {
  if (!message.stanzaId) return []
  return [
    `room:${searchDocumentFallbackKey(message)}`, roomCollisionIndexId(message),
    ...(message.localRowRef ? [`room:${searchDocumentKey({ ...message, ...message.localRowRef })}`] : []),
  ]
}

/**
 * The document id a room message takes when its own id already names another
 * message: the occupant-qualified fallback key, and — for a copy that recorded
 * its receipt instant — the receipt-qualified key, so two first deliveries
 * sharing a client id (docs/MESSAGE_IDENTIFIERS.md §3) each keep a document.
 * Deterministic from the message's own fields, so a removal recomputes it.
 */
function roomCollisionIndexId(
  message: Pick<RoomMessage, 'roomJid' | 'from' | 'id' | 'occupantId'> & { receivedAt?: Date | number; timestamp?: Date | number },
): string {
  const scope = roomScope(message.roomJid)
  const identity = { from: message.from, id: message.id, occupantId: message.occupantId, receivedAt: message.receivedAt, timestamp: message.timestamp }
  return `room:${message.receivedAt !== undefined ? receiptQualifiedKey(scope, identity) : canonicalKey(scope, identity)}`
}

function roomDocumentIdentity(doc: DocEntry) {
  return { roomJid: doc.conversationId, from: doc.from, id: doc.messageId,
    stanzaId: doc.stanzaId, occupantId: doc.occupantId,
    timestamp: doc.timestamp, body: doc.body,
    receivedAt: doc.receivedAt, isDelayed: doc.isDelayed, isOutgoing: doc.isOutgoing }
}

export interface RoomIdentityClosure {
  identityKeys: readonly string[]
  ids: readonly string[]
}

/**
 * The identity aliases carried by one cached CHAT row.
 *
 * Chat documents are keyed by the row's canonical identity key, and the cache
 * merges rows that share an archive identity — so a document written under a key
 * that lost the merge is unreachable from the surviving row's own key. Removal
 * takes the whole list, the same job {@link RoomIdentityClosure} does for a room.
 * `identityKeys` are the surviving row's tier keys, any of which may have been a
 * canonical key; `ids` are the client ids it absorbed.
 */
export interface ChatIdentityClosure {
  ids: readonly string[]
  identityKeys?: readonly string[]
}

/**
 * Whether a document found under a FALLBACK id genuinely names this message.
 *
 * The composite form is `roomJid:from:id` — none of which is unique after a nick
 * reassignment, where an old archive copy and a recent message share all three
 * and differ only in their archive and occupant ids. Only one of them owns that
 * document (indexing is idempotent per id), so the other must not delete it.
 */
function docBelongsToRoom(doc: DocEntry, message: RoomMessage): boolean {
  return doc.isRoom &&
    doc.conversationId === message.roomJid &&
    !occupantConflict(doc, message) && roomStanzaIdsMergeable(roomDocumentIdentity(doc), message) &&
    (!firstDeliveryConflict(roomDocumentIdentity(doc), message) ||
      !!doc.stanzaId && doc.stanzaId === message.stanzaId ||
      !!doc.originId && doc.originId === message.originId)
}

/**
 * Whether a document found under a FALLBACK id was written by this message.
 *
 * The composite id names room, nick and client id, none of which is unique after
 * a nick reassignment, so the document must carry evidence of its own: the
 * XEP-0421 occupant id, the XEP-0359 origin id, or the receipt instant. Equal
 * receipt instants are the converse of the delivery-evidence rule that keeps two
 * `from+id` copies apart ({@link firstDeliveryConflict}): one client receives one
 * stanza at one instant. A document written before it carried any of the three
 * cannot be claimed and stays.
 */
function fallbackDocNamesMessage(doc: DocEntry, message: Message | RoomMessage): boolean {
  if (message.type !== 'groupchat' || !docBelongsToRoom(doc, message)) return false
  if (doc.messageId !== message.id || doc.from !== message.from) return false
  if (doc.occupantId && message.occupantId) return doc.occupantId === message.occupantId
  if (doc.originId && message.originId) return doc.originId === message.originId
  if (doc.receivedAt !== undefined && message.receivedAt !== undefined) {
    return doc.receivedAt === message.receivedAt.getTime()
  }
  return false
}

function roomDocumentIdentityKeys(doc: DocEntry): string[] {
  return identityKeys(roomScope(doc.conversationId), {
    from: doc.from,
    id: doc.messageId,
    stanzaId: doc.stanzaId,
    originId: doc.originId,
    occupantId: doc.occupantId,
  })
}

function docBelongsToRoomIdentityClosure(
  doc: DocEntry,
  message: RoomMessage,
  closureKeys: ReadonlySet<string>,
  closureIds: ReadonlySet<string>
): boolean {
  if (!docBelongsToRoom(doc, message)) return false
  const docKeys = roomDocumentIdentityKeys(doc)
  if (docKeys.slice(0, -1).some((key) => closureKeys.has(key))) return true
  if (!closureKeys.has(docKeys[docKeys.length - 1]) || !closureIds.has(doc.messageId)) {
    return false
  }
  return fallbackDocNamesMessage(doc, { ...message, id: doc.messageId })
}

function docBelongsToChat(doc: DocEntry, message: Message): boolean {
  return docSharesChatOwner(doc, message) && !archiveIdentityConflict(doc, message) && (
    !!doc.stanzaId && doc.stanzaId === message.stanzaId ||
    !!doc.originId && doc.originId === message.originId ||
    !doc.stanzaId && !doc.originId && !message.stanzaId && !message.originId && doc.messageId === message.id
  )
}

/**
 * Whether a chat document belongs to the same conversation AND sender as
 * `message`, saying nothing about which message it names.
 *
 * The ownership half of {@link docBelongsToChat}, for a document found under an
 * id the cache row ABSORBED rather than under the row's own id — where the
 * messageId is expected to differ, but a document from another conversation or
 * another sender must still not be dropped.
 */
function docSharesChatOwner(doc: DocEntry, message: Message): boolean {
  return !doc.isRoom &&
    doc.conversationId === message.conversationId &&
    doc.from === message.from
}

function createDocEntry(
  message: Message | RoomMessage,
  indexId: string,
  tokens: string[]
): DocEntry {
  const doc: DocEntry = {
    indexId,
    messageId: message.id,
    tokens,
    conversationId: message.type === 'groupchat' ? message.roomJid : message.conversationId,
    from: message.from,
    timestamp: message.timestamp.getTime(),
    isRoom: message.type === 'groupchat',
    body: message.body,
  }
  if (message.stanzaId) doc.stanzaId = message.stanzaId
  if (message.originId) doc.originId = message.originId
  if (message.isDelayed) doc.isDelayed = true
  if (message.isOutgoing) doc.isOutgoing = true
  if (message.type === 'groupchat') {
    doc.nick = message.nick
    if (message.occupantId) doc.occupantId = message.occupantId
    if (message.receivedAt) doc.receivedAt = message.receivedAt.getTime()
    doc.identityKeys = roomDocumentIdentityKeys(doc)
  }
  doc.filterTokens = messageFilterTokens(message)
  doc.filterBuild = FILTERS_BUILD
  return doc
}

function sameIndexDocument(a: DocEntry, b: DocEntry): boolean {
  return (Object.keys({ ...a, ...b }) as Array<keyof DocEntry>).every(key => {
    if (key === 'docNo') return true
    if (key === 'tokens' || key === 'identityKeys' || key === 'filterTokens') {
      const left = a[key] ?? []
      const right = b[key] ?? []
      return left.length === right.length && left.every((value, i) => value === right[i])
    }
    return a[key] === b[key]
  })
}

type SearchWriteTx = IDBPTransaction<
  SearchIndexSchema,
  ['search-tokens', 'search-docs', 'search-postings', 'search-meta'],
  'readwrite'
>

type PostingKey = [string, number, number]

function postingKeys(doc: DocEntry): PostingKey[] {
  // A malformed delay stamp can persist as NaN, which no key can hold: such a
  // document sorts as the oldest instead of failing every write and every copy.
  const time = Number.isFinite(doc.timestamp) ? doc.timestamp : 0
  if (doc.docNo === undefined) return []
  return [...doc.tokens, ...doc.filterTokens ?? []].map(token => [token, -time, doc.docNo as number])
}

const postingKeyId = (key: PostingKey) => `${key[0]}\u0000${key[1]}\u0000${key[2]}`

/**
 * The one place that changes a document inside a write transaction. It keeps the
 * time-sorted rows (`search-postings`) and the document in step, so no caller can
 * change one without the other. The old posting lists stay the caller's job until
 * they are removed.
 */
function createDocumentWriter(tx: SearchWriteTx) {
  const docs = tx.objectStore(DOCS_STORE)
  const rows = tx.objectStore(POSTINGS_STORE)
  const meta = tx.objectStore(META_STORE)
  let next: number | undefined
  let repaired = false
  const changeUnknown = async (previous: boolean | undefined, current: boolean | undefined) => {
    const delta = Number(!!current) - Number(!!previous)
    if (previous && !current) repaired = true
    if (!delta) return
    const count = Number((await meta.get(FILTERS_UNKNOWN_KEY))?.value ?? 0)
    await meta.put({ key: FILTERS_UNKNOWN_KEY, value: String(Math.max(0, count + delta)) })
  }
  const allocate = async (): Promise<number> => {
    if (next === undefined) next = Number((await meta.get(NEXT_DOC_NO_KEY))?.value ?? 1)
    return next++
  }
  return {
    get repaired() { return repaired },
    /** Store a document, numbering it if needed and replacing the rows of the one it overwrites. */
    async put(doc: DocEntry): Promise<void> {
      const previous = await docs.get(doc.indexId)
      const numbered: DocEntry = { ...doc, docNo: doc.docNo ?? previous?.docNo ?? await allocate() }
      const keys = postingKeys(numbered)
      if (previous) {
        const kept = new Set(keys.map(postingKeyId))
        for (const key of postingKeys(previous)) if (!kept.has(postingKeyId(key))) await rows.delete(key)
      }
      await changeUnknown(previous?.filterContentUnknown, numbered.filterContentUnknown)
      await docs.put(numbered)
      for (const key of keys) await rows.put(1, key)
    },
    /** Delete a stored document and its rows. */
    async delete(doc: DocEntry): Promise<void> {
      await changeUnknown(doc.filterContentUnknown, false)
      await docs.delete(doc.indexId)
      for (const key of postingKeys(doc)) await rows.delete(key)
    },
    /**
     * Change a document's id only: a numbered document keeps its docNo, so its
     * rows stay. An unnumbered one is numbered now, because the copy cursor may
     * already be past its new id.
     */
    async relocate(doc: DocEntry, indexId: string): Promise<void> {
      await docs.delete(doc.indexId)
      if (doc.docNo === undefined) await this.put({ ...doc, indexId })
      else await docs.put({ ...doc, indexId })
    },
    /** Persist the next free number; call once before the transaction completes. */
    async flush(): Promise<void> {
      if (next !== undefined) await meta.put({ key: NEXT_DOC_NO_KEY, value: String(next) })
    },
  }
}

/** The retraction scope a message belongs to. */
function retractionScopeOf(
  message: Message | RoomMessage,
  accountScope: string | null
): RetractionScope {
  return message.type === 'groupchat'
    ? { kind: 'room', entityId: message.roomJid, accountScope }
    : { kind: 'chat', entityId: message.conversationId, accountScope }
}

/**
 * Whether the message has been retracted even though the copy in hand does not
 * say so. Two blind spots:
 *
 * - The write race: a retraction and its target's own indexing are independent
 *   fire-and-forget promises, so `removeMessage` can find no document and the
 *   indexing that follows would put the retracted body back. The ledger
 *   (`retractedIdentities.ts`) remembers the retraction, across restarts too.
 * - An archive re-delivery carries the original body, and the cached tombstone
 *   still remembers the retraction.
 *
 * The in-memory check answers first and costs nothing; the cache read is the
 * fallback. Callers await {@link ensureRetractionLedger} first, so the ledger has
 * its stored records before it is asked.
 */
function isKnownRetracted(
  message: Message | RoomMessage,
  scopeJid: string | null,
  requireCorroboration = false
): boolean {
  const aliases =
    message.type === 'groupchat'
      ? roomRetractionAliases(message)
      : chatRetractionAliases(message)
  return retractedAtForIdentity(
    retractionScopeOf(message, scopeJid),
    aliases,
    (record) =>
      message.type === 'groupchat'
        ? roomRetractionRecordApplies(message, record, scopeJid) && (!requireCorroboration ||
          !!message.stanzaId && message.stanzaId === record.stanzaId ||
          !!message.originId && message.originId === record.originId ||
          !!message.occupantId && message.occupantId === record.actorOccupantId)
        : chatMessageAuthor(message, record) && !archiveIdentityConflict(message, record)
  ) !== undefined
}

/**
 * Whether the session ledger may judge this copy BEFORE it is resolved against
 * the cache. A room re-delivery must first attach to the row it re-delivers and
 * take that row's receipt instant (`resolveMessagesForIndex` does so on the
 * write path), or a nick-level record would tombstone a copy of a later
 * message; a first delivery is its own occurrence and can be judged at once.
 */
function judgedBeforeResolution(message: Message | RoomMessage): boolean {
  return message.type !== 'groupchat' || isFirstDelivery(message)
}

async function isRetractedElsewhere(
  message: Message | RoomMessage,
  scopeJid: string | null
): Promise<boolean> {
  await ensureRetractionLedger(scopeJid)
  if (judgedBeforeResolution(message) && isKnownRetracted(message, scopeJid)) return true
  return (await messageCache.areRetractedInCache([message], scopeJid))[0]
}

/**
 * Batch twin of {@link isRetractedElsewhere}: one cache transaction, not one per
 * message. `fromCache` skips that transaction for callers whose messages ARE the
 * cache rows — a backfill would otherwise read the whole archive back a second
 * time to learn what each row already says.
 */
async function rejectRetracted(
  messages: (Message | RoomMessage)[],
  fromCache: boolean,
  scopeJid: string | null
): Promise<(Message | RoomMessage)[]> {
  await ensureRetractionLedger(scopeJid)
  const unknown = messages.filter((m) => !judgedBeforeResolution(m) || !isKnownRetracted(m, scopeJid))
  if (fromCache || unknown.length === 0) return unknown
  const retracted = await messageCache.areRetractedInCache(unknown, scopeJid)
  return unknown.filter((_, i) => !retracted[i])
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Initialize the search index for the given account scope.
 * Opens (or creates) the IndexedDB database.
 */
export async function initSearchIndex(scopeJid: string): Promise<void> {
  await getDB(scopeJid)
}

/**
 * Index a single message into the search index.
 * Skips retracted messages and noLocalStore messages.
 * Silently returns if IndexedDB is not available.
 */
export async function indexMessage(
  message: Message | RoomMessage,
  scopeJid: string | null = getStorageScopeJid()
): Promise<void> {
  if (!isIndexedDBAvailable()) return
  if (message.isRetracted || isNoLocalStore(message)) return
  if (await isRetractedElsewhere(message, scopeJid)) return

  await writeIndexBatch([message], scopeJid)
}

/**
 * Maximum messages per IDB transaction to avoid transaction lifetime issues.
 * IDB transactions auto-commit when the event loop goes idle; large batches
 * with many awaits can exceed this window and silently fail.
 */
const INDEX_BATCH_SIZE = 50

/** Options for {@link indexMessages}. */
export interface IndexMessagesOptions {
  /**
   * The messages were read straight from the message cache, so their
   * `isRetracted` flag is already the durable truth and needs no second look.
   * Set by the backfill and the rebuild; never by a live ingestion path, whose
   * messages come off the wire and may name something the archive has since
   * tombstoned.
   */
  fromCache?: boolean
}

/**
 * Index multiple messages, splitting into small transactions to avoid
 * IDB transaction lifetime issues.
 * Silently returns if IndexedDB is not available.
 */
export async function indexMessages(
  messages: (Message | RoomMessage)[],
  options: IndexMessagesOptions = {},
  scopeJid: string | null = getStorageScopeJid()
): Promise<void> {
  if (!isIndexedDBAvailable()) return
  const candidates = messages.filter((m) => !m.isRetracted && !isNoLocalStore(m))
  const indexable = await rejectRetracted(candidates, options.fromCache === true, scopeJid)
  if (indexable.length === 0) return

  // Process in small batches to keep each IDB transaction short-lived
  for (let i = 0; i < indexable.length; i += INDEX_BATCH_SIZE) {
    const batch = indexable.slice(i, i + INDEX_BATCH_SIZE)
    await writeIndexBatch(batch, scopeJid)
  }
}

/**
 * Index a small batch of messages in a single transaction.
 * Kept small enough that the IDB transaction won't auto-commit.
 */
async function writeIndexBatch(
  messages: (Message | RoomMessage)[],
  scopeJid: string | null,
  removal?: { message: Message | RoomMessage; identityClosure?: RoomIdentityClosure | ChatIdentityClosure },
  transition?: { previous: Message[]; current: Message },
): Promise<void> {
  await mutateIndex(scopeJid, async () => {
    const resolved = messages.length ? await messageCache.resolveMessagesForIndex(messages, scopeJid) : []
    const db = await getDB(scopeJid)
    const chatIds = new Set<string>()
    if (removal && !messages.length && removal.message.type === 'chat') {
      for (const id of getChatRemovalIds(removal.message, removal.identityClosure)) chatIds.add(id)
    }
    for (let i = 0; i < resolved.length; i++) {
      const entry = resolved[i]
      if (entry?.message.type !== 'chat' || !entry.cached && !removal) continue
      for (const id of getChatRemovalIds(entry.message, removal?.identityClosure, messages[i])) chatIds.add(id)
    }
    const chatDocs = (await Promise.all([...chatIds].map(id => db.get(DOCS_STORE, id))))
      .filter((doc): doc is DocEntry => !!doc && !doc.isRoom)
    const chatOwners = chatDocs.length ? await messageCache.resolveMessagesForIndex(chatDocs.map(doc => ({
      type: 'chat', conversationId: doc.conversationId, id: doc.messageId, from: doc.from,
      stanzaId: doc.stanzaId, originId: doc.originId, body: doc.body,
      timestamp: new Date(doc.timestamp), isOutgoing: doc.isOutgoing ?? false,
    })), scopeJid) : []
    const ownedChatDocs = new Map(chatDocs.flatMap((doc, i) => {
      const owner = chatOwners[i]
      return owner ? [[doc.indexId, createDocEntry(owner.message, doc.indexId, doc.tokens)] as const] : []
    }))
    const tx = db.transaction([TOKENS_STORE, DOCS_STORE, POSTINGS_STORE, META_STORE], 'readwrite')
    void tx.done.catch(() => {})
    const tokensStore = tx.objectStore(TOKENS_STORE)
    const docsStore = tx.objectStore(DOCS_STORE)
    const writer = createDocumentWriter(tx)
    const postings = new Map<string, { before: string[]; after: Set<string> }>()
    const getPostings = async (token: string): Promise<Set<string>> => {
      let entry = postings.get(token)
      if (!entry) {
        const before = (await tokensStore.get(token))?.postings ?? []
        entry = { before, after: new Set(before) }
        postings.set(token, entry)
      }
      return entry.after
    }
    const remove = (message: Message | RoomMessage, closure?: RoomIdentityClosure | ChatIdentityClosure, source?: Message | RoomMessage, keep?: DocEntry) =>
      removeMessageEntries(tx, writer, message, getPostings, ownedChatDocs, closure, source, keep)
    try {
      if (transition) {
        const { previous, current } = transition
        const nextId = getIndexId(current)
        for (const before of previous) {
          const oldId = getIndexId(before)
          const doc = await docsStore.get(oldId)
          if (!doc || !docBelongsToChat(doc, before)) continue
          await writer.delete(doc)
          for (const token of doc.tokens) (await getPostings(token)).delete(oldId)
          if (current.isRetracted || isNoLocalStore(current) || await docsStore.get(nextId)) continue
          await writer.put({ ...doc, indexId: nextId, messageId: current.id,
            stanzaId: current.stanzaId, originId: current.originId, timestamp: current.timestamp.getTime() })
          for (const token of doc.tokens) (await getPostings(token)).add(nextId)
        }
      }
      if (removal && !messages.length) await remove(removal.message, removal.identityClosure)
      for (let i = 0; i < resolved.length; i++) {
        const entry = resolved[i]
        if (!entry) continue
        const { message, cached } = entry
        let indexId = getIndexId(message)
        const collision = await docsStore.get(indexId)
        if (message.type === 'groupchat' && collision && !docBelongsToRoom(collision, message)) {
          if (getRoomModerationId(message) && !getRoomModerationId(roomDocumentIdentity(collision))) {
            const relocatedId = roomCollisionIndexId(roomDocumentIdentity(collision))
            await writer.relocate(collision, relocatedId)
            for (const token of collision.tokens) {
              const posting = await getPostings(token)
              posting.delete(indexId)
              posting.add(relocatedId)
            }
          } else {
            indexId = roomCollisionIndexId(message)
          }
        }
        const doc = message.isRetracted || isNoLocalStore(message) || isKnownRetracted(message, scopeJid)
          ? undefined : createDocEntry(message, indexId, uniqueTokens(message.body))
        if (cached || removal) await remove(message, removal?.identityClosure, messages[i], doc)
        if (!doc) continue
        const existing = await docsStore.get(indexId)
        if (existing) {
          const sameOwner = message.type === 'groupchat' ? docBelongsToRoom(existing, message) : docBelongsToChat(existing, message)
          if (sameOwner && existing.body === doc.body &&
            (existing.filterContentUnknown || existing.filterBuild !== FILTERS_BUILD)) {
            await writer.put({ ...existing, filterTokens: doc.filterTokens, filterBuild: FILTERS_BUILD, filterContentUnknown: false })
          }
          continue
        }
        await writer.put(doc)
        for (const token of doc.tokens) (await getPostings(token)).add(indexId)
      }
      for (const [token, { before, after }] of postings) {
        if (before.length === after.size && before.every(id => after.has(id))) continue
        if (after.size) await tokensStore.put({ token, postings: [...after] })
        else await tokensStore.delete(token)
      }
      await writer.flush()
      await tx.done
      if (writer.repaired && getStorageScopeJid() === scopeJid) notifyFilterIndex()
    } catch (error) {
      try { tx.abort() } catch {
        // An already completed or aborted transaction cannot be aborted again.
      }
      await tx.done.catch(() => {})
      throw error
    }
  })
}

export async function reconcileChatIndexKeys(previous: Message[], current: Message, scopeJid: string | null): Promise<void> {
  if (!isIndexedDBAvailable()) return
  await writeIndexBatch([], scopeJid, undefined, { previous, current })
}

setChatIdentityObserver(reconcileChatIndexKeys)

/**
 * Remove a message from the search index.
 * Room identity-key hits select candidates; ownership checks still decide
 * which documents and token postings may be removed.
 */
export async function removeMessage(
  message: Message | RoomMessage,
  scopeJid: string | null = getStorageScopeJid(),
  identityClosure?: RoomIdentityClosure | ChatIdentityClosure
): Promise<void> {
  if (!isIndexedDBAvailable()) return
  await writeIndexBatch([], scopeJid, { message, identityClosure })
}

/**
 * Remove every indexed document of one conversation or room, with its token
 * postings. Called when the conversation itself is deleted: the message cache
 * drops its rows, and without this the search results would keep serving the
 * deleted text. `kind` keeps a 1:1 chat and a room that share a JID apart.
 */
export async function removeConversation(
  kind: 'chat' | 'room',
  conversationId: string,
  scopeJid: string | null = getStorageScopeJid()
): Promise<void> {
  if (!isIndexedDBAvailable()) return
  const isRoom = kind === 'room'
  await mutateIndex(scopeJid, async () => {
    const db = await getDB(scopeJid)
    const tx = db.transaction([TOKENS_STORE, DOCS_STORE, POSTINGS_STORE, META_STORE], 'readwrite')
    void tx.done.catch(() => {})
    const tokensStore = tx.objectStore(TOKENS_STORE)
    const docsStore = tx.objectStore(DOCS_STORE)
    const writer = createDocumentWriter(tx)
    try {
      const docs = (await docsStore.index('conversationId').getAll(conversationId))
        .filter(doc => doc.isRoom === isRoom)
      const dropped = new Map<string, Set<string>>()
      for (const doc of docs) {
        await writer.delete(doc)
        for (const token of doc.tokens) {
          let ids = dropped.get(token)
          if (!ids) dropped.set(token, ids = new Set())
          ids.add(doc.indexId)
        }
      }
      for (const [token, ids] of dropped) {
        const entry = await tokensStore.get(token)
        if (!entry) continue
        const postings = entry.postings.filter(id => !ids.has(id))
        if (postings.length) await tokensStore.put({ token, postings })
        else await tokensStore.delete(token)
      }
      await tx.done
    } catch (error) {
      try { tx.abort() } catch {
        // An already completed or aborted transaction cannot be aborted again.
      }
      await tx.done.catch(() => {})
      throw error
    }
  })
}

async function removeMessageEntries(
  tx: SearchWriteTx,
  writer: ReturnType<typeof createDocumentWriter>,
  message: Message | RoomMessage,
  getPostings: (token: string) => Promise<Set<string>>,
  ownedChatDocs: ReadonlyMap<string, DocEntry>,
  identityClosure?: RoomIdentityClosure | ChatIdentityClosure,
  source?: Message | RoomMessage,
  keep?: DocEntry,
): Promise<void> {
  const docsStore = tx.objectStore(DOCS_STORE)
  const roomIdentityClosure =
    identityClosure && 'identityKeys' in identityClosure ? identityClosure : undefined
  const closureKeys = new Set(roomIdentityClosure?.identityKeys ?? [])
  const closureIds = new Set(roomIdentityClosure?.ids ?? [])

  const drop = async (
    indexId: string,
    verification: 'chat' | 'room' | 'room-identity' | 'room-closure' | 'room-source'
  ): Promise<void> => {
    const doc = await docsStore.get(indexId)
    if (!doc) return
    if (message.type === 'groupchat' && !docBelongsToRoom(doc, message)) return
    if (source && message.type === 'groupchat' &&
      !roomMessageAuthor(doc, { actorJid: message.from, actorOccupantId: message.occupantId })) return
    if (verification === 'chat') {
      const owner = ownedChatDocs.get(indexId)
      const absorbed = (doc.stanzaId || doc.originId) && identityClosure?.identityKeys?.includes(
        canonicalKey(CHAT_SCOPE, { ...doc, id: doc.messageId }),
      )
      if (message.type !== 'chat' || !docSharesChatOwner(doc, message) ||
        !absorbed && (!owner || archiveIdentityConflict(doc, message) || !docBelongsToChat(owner, message))) return
    }
    if (verification === 'room' && (message.type !== 'groupchat' || !docBelongsToRoom(doc, message))) return
    if (verification === 'room-source' && (!source || !fallbackDocNamesMessage(
      doc, { ...message, id: source.id, from: source.from }
    ))) return
    if (verification === 'room-identity' && !fallbackDocNamesMessage(doc, message)) return
    if (
      verification === 'room-closure' &&
      (message.type !== 'groupchat' || !docBelongsToRoomIdentityClosure(doc, message, closureKeys, closureIds))
    ) return

    if (keep && sameIndexDocument(doc, keep)) return
    for (const token of doc.tokens) (await getPostings(token)).delete(indexId)

    // Remove the document and its rows
    await writer.delete(doc)
  }

  if (message.type === 'chat') {
    for (const id of getChatRemovalIds(message, identityClosure, source)) await drop(id, 'chat')
    return
  }
  await drop(getIndexId(message), message.stanzaId ? 'room' : 'room-identity')
  for (const fallbackId of getFallbackIndexIds(message)) {
    await drop(fallbackId, 'room-identity')
  }
  if (source && getIndexId(source) !== getIndexId(message)) {
    await drop(getIndexId(source), 'room-source')
  }
  if (message.type === 'groupchat' && roomIdentityClosure) {
    const seen = new Set<string>()
    for (const key of closureKeys) {
      const docs = await docsStore.index('identityKeys').getAll(key)
      for (const doc of docs) {
        if (seen.has(doc.indexId)) continue
        seen.add(doc.indexId)
        await drop(doc.indexId, 'room-closure')
      }
    }
  }
}

/**
 * Update a message in the search index (e.g., after XEP-0308 correction).
 * Removes the old entry and re-indexes with the new body.
 */
export async function updateMessage(
  message: Message | RoomMessage,
  scopeJid: string | null = getStorageScopeJid()
): Promise<void> {
  if (!isIndexedDBAvailable()) return
  const indexable = !message.isRetracted && !isNoLocalStore(message) &&
    !await isRetractedElsewhere(message, scopeJid)
  await writeIndexBatch(indexable ? [message] : [], scopeJid, { message })
}

/** Where {@link search} looks. */
export interface SearchOptions {
  limit?: number
  conversationId?: string
  isRoom?: boolean
  /** Only messages at or after this instant (epoch ms). */
  after?: number
  /** Only messages strictly before this instant (epoch ms). */
  before?: number
  /**
   * Filter tokens a message must carry: one token of each group (`from:alice`
   * may name several). Answered only once {@link isFilterIndexReady}.
   */
  filterGroups?: string[][]
}

/** Whether a document's time falls in the asked span; a malformed time counts as the oldest. */
function inSpan(doc: DocEntry, options: SearchOptions | undefined): boolean {
  const time = Number.isFinite(doc.timestamp) ? doc.timestamp : 0
  return (options?.after === undefined || time >= options.after) &&
    (options?.before === undefined || time < options.before)
}

/**
 * Search for messages matching the query.
 *
 * Tokenizes the query and returns matching documents sorted by timestamp (newest
 * first). Once the time-sorted index is ready it walks that index newest first and
 * stops at the limit; until then it intersects the old posting lists.
 *
 * Supports quoted phrases: `"exact phrase"` requires the phrase to appear
 * contiguously in the message body. Unquoted terms use AND matching with
 * prefix matching on the last term for search-as-you-type.
 */
export async function search(
  query: string,
  options?: SearchOptions
): Promise<SearchIndexResult[]> {
  if (!isIndexedDBAvailable()) return []
  const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT
  if (options?.after !== undefined && options.before !== undefined && options.after >= options.before) return []
  const parsed = parseSearchQuery(query)

  // Collect all tokens needed for index lookup:
  // unquoted terms + tokens from each phrase
  const phraseTokens = parsed.phrases.flatMap((p) => tokenize(p))
  const allTokens = [...parsed.terms, ...phraseTokens]

  // Deduplicate tokens for index lookup
  const uniqueAllTokens = [...new Set(allTokens)]
  const filterGroups = (options?.filterGroups ?? []).filter((group) => group.length > 0)
  if (uniqueAllTokens.length === 0 && filterGroups.length === 0) return []

  const scopeJid = getStorageScopeJid()
  await ensureRetractionLedger(scopeJid)
  const db = await getDB(scopeJid)
  if (filterGroups.length > 0) {
    // A half-copied filter index would hide messages without saying so
    if (!await isFilterIndexReady(scopeJid)) return []
    return searchTimeSorted(db, parsed, uniqueAllTokens, limit, { ...options, filterGroups }, scopeJid)
  }
  // The time-sorted index answers only once it holds every document; until then
  // the old lists do, so a half-copied index can never hide a message.
  if ((await db.get(META_STORE, POSTINGS_READY_KEY)) !== undefined) {
    return searchTimeSorted(db, parsed, uniqueAllTokens, limit, options, scopeJid)
  }
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE], 'readonly')
  const tokensStore = tx.objectStore(TOKENS_STORE)
  const docsStore = tx.objectStore(DOCS_STORE)

  // Determine which token gets prefix matching
  // Only the last unquoted term, and only if lastTermPrefix is set
  const prefixToken = parsed.lastTermPrefix
    ? parsed.terms[parsed.terms.length - 1]
    : null

  // Tokens that need exact matching (all except the prefix token)
  const exactTokens = prefixToken
    ? uniqueAllTokens.filter((t) => t !== prefixToken)
    : uniqueAllTokens

  // Gather posting lists for exact terms
  const postingLists: Set<string>[] = []

  for (const term of exactTokens) {
    const entry = await tokensStore.get(term)
    if (!entry || entry.postings.length === 0) {
      // A required term has no matches — empty result
      return []
    }
    postingLists.push(new Set(entry.postings))
  }

  // Prefix match for the prefix token using IDB key range
  if (prefixToken) {
    const prefixPostings = new Set<string>()
    const range = IDBKeyRange.bound(prefixToken, prefixToken + '\uffff')
    let cursor = await tokensStore.openCursor(range)
    while (cursor) {
      for (const id of cursor.value.postings) {
        prefixPostings.add(id)
      }
      cursor = await cursor.continue()
    }
    if (prefixPostings.size === 0) return []
    postingLists.push(prefixPostings)
  }

  if (postingLists.length === 0) return []

  // Intersect all posting lists
  // Start with the smallest set for efficiency
  postingLists.sort((a, b) => a.size - b.size)
  let result = postingLists[0]
  for (let i = 1; i < postingLists.length; i++) {
    const next = postingLists[i]
    result = new Set([...result].filter((id) => next.has(id)))
    if (result.size === 0) return []
  }

  // Narrow by the scope filters on the ids alone, before any document is read.
  // A document id starts with its kind, and the conversation index lists the
  // ids of one conversation without reading the documents.
  let ids = [...result]
  if (options?.isRoom !== undefined) {
    const prefix = options.isRoom ? 'room:' : 'chat:'
    ids = ids.filter((id) => id.startsWith(prefix))
  }
  if (options?.conversationId) {
    // Probe only the candidate ids: one key-only cursor over the conversation's
    // index entries, jumping to each candidate in primary-key order, never
    // collecting the whole conversation.
    const kept: string[] = []
    let cursor = await docsStore.index('conversationId')
      .openKeyCursor(IDBKeyRange.only(options.conversationId))
    for (const id of [...ids].sort()) {
      if (!cursor) break
      // The cursor may only move forward; a candidate it already passed is absent.
      if (id > cursor.primaryKey) {
        cursor = await cursor.continuePrimaryKey(options.conversationId, id)
      }
      if (cursor && cursor.primaryKey === id) kept.push(id)
    }
    const keptSet = new Set(kept)
    ids = ids.filter((id) => keptSet.has(id))
  }

  // Fetch only the documents that passed the scope filters, applying the exact
  // filters that need the stored fields.
  const scoped: DocEntry[] = []
  for (const indexId of ids) {
    const doc = await docsStore.get(indexId)
    if (!doc) continue
    if (options?.conversationId && doc.conversationId !== options.conversationId) continue
    if (options?.isRoom !== undefined && doc.isRoom !== options.isRoom) continue
    if (!inSpan(doc, options)) continue
    // Post-filter: verify exact phrases appear contiguously in the body
    if (parsed.phrases.length > 0) {
      const bodyLower = doc.body.toLowerCase()
      if (!parsed.phrases.every((phrase) => bodyLower.includes(phrase))) continue
    }
    scoped.push(doc)
  }
  await tx.done

  // Newest first. The sort is stable, so equal timestamps keep their lookup order.
  scoped.sort((a, b) => b.timestamp - a.timestamp)

  // Judge retractions newest first and stop once the limit is filled: the cache
  // is read for the documents that can appear, not for every match.
  const limited: DocEntry[] = []
  const retracted: (Message | RoomMessage)[] = []
  await takeUnretracted(scoped, limited, retracted, limit, scopeJid)
  await removeRetracted(retracted, scopeJid)
  return limited.map(docToResult)
}

/**
 * Take documents newest first until the limit is filled, setting aside the ones a
 * retraction says are gone. The cache is read for the documents that can appear,
 * not for every match. Shared by both search paths, so both keep the same check.
 */
async function takeUnretracted(
  candidates: DocEntry[],
  limited: DocEntry[],
  retracted: (Message | RoomMessage)[],
  limit: number,
  scopeJid: string | null,
): Promise<void> {
  const CHUNK_MIN = 25
  for (let start = 0; start < candidates.length && limited.length < limit;) {
    const chunk = candidates.slice(start, start + Math.max(limit - limited.length, CHUNK_MIN))
    start += chunk.length
    const messages = chunk.map(docToMessage)
    const cachedRetractions = await messageCache.areRetractedInCache(messages, scopeJid)
    for (const [index, doc] of chunk.entries()) {
      const message = messages[index]
      if (isKnownRetracted(message, scopeJid, true) || cachedRetractions[index]) {
        retracted.push(message)
      } else if (limited.length < limit) {
        limited.push(doc)
      }
    }
  }
}

/** Drop the documents of retracted messages that a search turned up. */
async function removeRetracted(retracted: (Message | RoomMessage)[], scopeJid: string | null): Promise<void> {
  for (const message of retracted) {
    try {
      await removeMessage(message, scopeJid, message.type === 'groupchat'
        ? { identityKeys: roomRetractionAliases(message), ids: [message.id] } : undefined)
    } catch (error) {
      console.warn('Failed to remove a retracted search document:', error)
    }
  }
}

// =============================================================================
// Search on the time-sorted index
// =============================================================================

/** A conversation this small is read whole and matched in memory. */
const SMALL_CONVERSATION_DOCS = 5000
/** Candidates read per page, and the most a page grows to when few survive. */
const SEARCH_PAGE_START = 128
const SEARCH_PAGE_MAX = 1024
/** Other exact words checked by key lookups, this many at a time. */
const LOOKUP_BATCH = 128

/** Position in key order: negative time, then document number. */
/** One word of the query: its tokens (several for a prefix) and how many rows they hold. */
interface SearchSide { tokens: string[]; prefix: boolean; count: number }

interface SearchPosition { negTime: number; docNo: number }

/**
 * A token's rows in the asked span, after a position when one is given. Keys hold
 * the negative time, so `before` bounds the low end and `after` the high end; no
 * row has an infinite docNo, so `[token, -t, Infinity]` falls between instants.
 */
function postingRange(token: string, after?: SearchPosition, span: SearchOptions = {}): IDBKeyRange {
  const top: PostingKey = [token, span.after === undefined ? Infinity : -span.after, Infinity]
  if (after) return IDBKeyRange.bound([token, after.negTime, after.docNo], top, true, false)
  return IDBKeyRange.bound([token, span.before === undefined ? -Infinity : -span.before, Infinity], top)
}

async function searchTimeSorted(
  db: IDBPDatabase<SearchIndexSchema>,
  parsed: ParsedQuery,
  uniqueAllTokens: string[],
  limit: number,
  options: SearchOptions | undefined,
  scopeJid: string | null,
): Promise<SearchIndexResult[]> {
  const prefixToken = parsed.lastTermPrefix ? parsed.terms[parsed.terms.length - 1] : null
  const exactTokens = prefixToken ? uniqueAllTokens.filter((t) => t !== prefixToken) : uniqueAllTokens
  const phrases = parsed.phrases.map((phrase) => phrase.toLowerCase())
  const filterGroups = (options?.filterGroups ?? []).map(group => [...new Set(group)])
  const keeps = (doc: DocEntry): boolean => {
    if (options?.conversationId && doc.conversationId !== options.conversationId) return false
    if (options?.isRoom !== undefined && doc.isRoom !== options.isRoom) return false
    if (!inSpan(doc, options)) return false
    if (phrases.length === 0) return true
    const bodyLower = doc.body.toLowerCase()
    return phrases.every((phrase) => bodyLower.includes(phrase))
  }

  const limited: DocEntry[] = []
  const retracted: (Message | RoomMessage)[] = []
  const judge = (docs: DocEntry[]) => takeUnretracted(docs, limited, retracted, limit, scopeJid)

  // A small conversation is cheaper to read whole than to walk word by word.
  let small: DocEntry[] | undefined
  if (options?.conversationId) {
    const range = IDBKeyRange.only(options.conversationId)
    const tx = db.transaction([DOCS_STORE], 'readonly')
    const index = tx.objectStore(DOCS_STORE).index('conversationId')
    if (await index.count(range) <= SMALL_CONVERSATION_DOCS) small = await index.getAll(range)
    await tx.done
  }

  if (small) {
    const matches = small.filter((doc) =>
      keeps(doc) &&
      filterGroups.every((group) => group.some((token) => doc.filterTokens?.includes(token))) &&
      exactTokens.every((token) => doc.tokens.includes(token)) &&
      (prefixToken === null || doc.tokens.some((token) => token.startsWith(prefixToken))))
    const time = (doc: DocEntry) => (Number.isFinite(doc.timestamp) ? doc.timestamp : 0)
    matches.sort((a, b) => time(b) - time(a) || (a.docNo ?? 0) - (b.docNo ?? 0))
    await judge(matches)
  } else {
    let after: SearchPosition | undefined
    let pageSize = SEARCH_PAGE_START
    let plan: SearchSide[] | undefined
    // Documents already taken, so a correction that moves one past the cursor cannot repeat it.
    const seen = new Set<string>()
    while (limited.length < limit) {
      const tx = db.transaction([DOCS_STORE, POSTINGS_STORE, TOKENS_STORE], 'readonly')
      void tx.done.catch(() => {})
      const rows = tx.objectStore(POSTINGS_STORE)
      const docs = tx.objectStore(DOCS_STORE)

      // The driving side is the one with the fewest rows; the rest are lookups.
      // Worked out once: later pages reuse it.
      if (!plan) {
        const prefixTokens = prefixToken
          ? await tx.objectStore(TOKENS_STORE).getAllKeys(IDBKeyRange.bound(prefixToken, prefixToken + '\uffff')) : []
        // Row-only indexes remain readable after their legacy word lists are retired.
        if (prefixToken && prefixTokens.length === 0) {
          let cursor = await rows.openKeyCursor(IDBKeyRange.bound([prefixToken], [prefixToken + '\uffff']))
          while (cursor) {
            const token = cursor.key[0]
            prefixTokens.push(token)
            cursor = await cursor.continue([token + '\u0000', -Infinity, -Infinity])
          }
        }
        const sides: SearchSide[] = []
        for (const token of exactTokens) sides.push({ tokens: [token], prefix: false, count: await rows.count(postingRange(token, undefined, options)) })
        if (prefixToken) {
          let count = 0
          for (const token of prefixTokens) count += await rows.count(postingRange(token, undefined, options))
          sides.push({ tokens: prefixTokens, prefix: true, count })
        }
        // A filter is one more side: `has:image` with few rows drives a search, words or none
        for (const group of filterGroups) {
          let count = 0
          for (const token of group) count += await rows.count(postingRange(token, undefined, options))
          sides.push({ tokens: group, prefix: false, count })
        }
        sides.sort((a, b) => a.count - b.count)
        plan = sides
      }
      if (plan.some((side) => side.count === 0)) { await tx.done; break }
      const [driver, ...others] = plan

      // The next page of the driving side, merged newest first.
      const positions: PostingKey[] = []
      for (const token of driver.tokens) {
        positions.push(...await rows.getAllKeys(postingRange(token, after, options), pageSize))
      }
      positions.sort((a, b) => a[1] - b[1] || a[2] - b[2])
      const page = positions.filter((key, i) => i === 0 || key[1] !== positions[i - 1][1] || key[2] !== positions[i - 1][2])
        .slice(0, pageSize)
      if (page.length === 0) { await tx.done; break }

      let survivors = page
      // A prefix that does not drive is matched on the documents' own tokens below:
      // probing every expansion for every candidate would cost candidates x expansions.
      const prefixChecked = others.some((side) => side.prefix)
      for (const side of others.filter((other) => !other.prefix)) {
        const kept: PostingKey[] = []
        for (let i = 0; i < survivors.length; i += LOOKUP_BATCH) {
          const batch = survivors.slice(i, i + LOOKUP_BATCH)
          const found = await Promise.all(batch.map(async (key) => {
            for (const token of side.tokens) {
              if (await rows.getKey([token, key[1], key[2]]) !== undefined) return true
            }
            return false
          }))
          kept.push(...batch.filter((_, j) => found[j]))
        }
        survivors = kept
        if (survivors.length === 0) break
      }

      const matches: DocEntry[] = []
      const numbers = docs.index('docNo')
      for (const key of survivors) {
        const doc = await numbers.get(key[2])
        if (!doc || seen.has(doc.indexId) || !keeps(doc)) continue
        if (prefixChecked && !doc.tokens.some((token) => token.startsWith(prefixToken as string))) continue
        seen.add(doc.indexId)
        matches.push(doc)
      }
      await tx.done

      const last = page[page.length - 1]
      after = { negTime: last[1], docNo: last[2] }
      const exhausted = page.length < pageSize
      // The retraction check leaves this transaction; the next page opens its own.
      await judge(matches)
      if (exhausted) break
      if (matches.length < limit) pageSize = Math.min(pageSize * 2, SEARCH_PAGE_MAX)
    }
  }

  await removeRetracted(retracted, scopeJid)
  return limited.map(docToResult)
}

function docToMessage(doc: DocEntry): Message | RoomMessage {
  const fields = {
    id: doc.messageId ?? doc.indexId.replace(/^(chat:|room:)/, ''),
    from: doc.from,
    body: doc.body,
    timestamp: new Date(doc.timestamp),
    stanzaId: doc.stanzaId,
    originId: doc.originId,
    isOutgoing: doc.isOutgoing ?? false,
    isDelayed: doc.isDelayed,
    ...(doc.receivedAt !== undefined ? { receivedAt: new Date(doc.receivedAt) } : {}),
  }
  return doc.isRoom
    ? { ...fields, type: 'groupchat', roomJid: doc.conversationId,
      nick: doc.nick ?? doc.from.split('/')[1], occupantId: doc.occupantId }
    : { ...fields, type: 'chat', conversationId: doc.conversationId }
}

function docToResult(doc: DocEntry): SearchIndexResult {
  // Derive nick: prefer stored nick, fall back to resource part of occupant JID
  const nick = doc.nick ?? (doc.isRoom ? doc.from.split('/')[1] : undefined)
  return {
    indexId: doc.indexId,
    messageId: doc.messageId ?? doc.indexId.replace(/^(chat:|room:)/, ''),
    conversationId: doc.conversationId,
    from: doc.from,
    ...(nick ? { nick } : {}),
    timestamp: doc.timestamp,
    isRoom: doc.isRoom,
    body: doc.body,
    // Stated unconditionally, not spread conditionally: the result type requires
    // them so a future edit cannot drop a tier and leave the document ownerless.
    stanzaId: doc.stanzaId,
    originId: doc.originId,
    occupantId: doc.occupantId,
    ...(doc.isDelayed ? { isDelayed: true } : {}),
    ...(doc.isOutgoing ? { isOutgoing: true } : {}),
    ...(doc.receivedAt !== undefined ? { receivedAt: doc.receivedAt } : {}),
  }
}

// =============================================================================
// Backfill
// =============================================================================

const BACKFILL_KEY = 'backfill-complete'
const BACKFILL_BATCH_SIZE = 500

/**
 * The document-key format a completed backfill wrote. A chat document is keyed by
 * the conversation-qualified canonical key; the earlier format keyed it by client
 * id (stored as `'true'`), which cannot be translated in place.
 */
const BACKFILL_FORMAT = 'chat-cache-key'

async function isBackfillComplete(scopeJid: string | null): Promise<boolean> {
  const db = await getDB(scopeJid)
  const entry = await db.get(META_STORE, BACKFILL_KEY)
  return entry?.value === BACKFILL_FORMAT
}

async function markBackfillComplete(scopeJid: string | null): Promise<void> {
  const db = await getDB(scopeJid)
  await db.put(META_STORE, { key: BACKFILL_KEY, value: BACKFILL_FORMAT })
}

/**
 * Backfill the search index with all existing messages from messageCache.
 *
 * A completion marker for the current document-key format makes this a no-op.
 * A missing or outdated marker requires clearing the index and rebuilding from
 * the cache. Only a completed scan writes the marker, so interrupted scans retry.
 * Backfill, explicit rebuilds and clears are serialized per account in this runtime.
 */
export async function backfillFromMessageCache(): Promise<void> {
  if (!isIndexedDBAvailable()) return

  const scope = captureStorageScope()
  await maintainIndex(scope.jid, async () => {
    scope.assertCurrent()
    if (await isBackfillComplete(scope.jid)) return
    scope.assertCurrent()
    await clearIndexData(scope.jid)
    scope.assertCurrent()

    let chatCount = 0
    let roomCount = 0

    await messageCache.iterateAllMessages('chat', BACKFILL_BATCH_SIZE, async (batch) => {
      scope.assertCurrent()
      await indexMessages(batch, { fromCache: true }, scope.jid)
      scope.assertCurrent()
      chatCount += batch.length
    })

    scope.assertCurrent()
    await messageCache.iterateAllMessages('room', BACKFILL_BATCH_SIZE, async (batch) => {
      scope.assertCurrent()
      await indexMessages(batch, { fromCache: true }, scope.jid)
      scope.assertCurrent()
      roomCount += batch.length
    })

    scope.assertCurrent()
    await markBackfillComplete(scope.jid)

    if (chatCount > 0 || roomCount > 0) {
      console.log(`[searchIndex] Backfill complete: indexed ${chatCount} chat + ${roomCount} room messages`)
    }
  })
}

// =============================================================================
// Time-sorted index copy
// =============================================================================

/** Documents numbered and given rows per transaction. */
const POSTINGS_COPY_BATCH_SIZE = 200
/** Pause between batches so the interface keeps its frames. */
const POSTINGS_COPY_PAUSE_MS = 16

function isStorageFull(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'QuotaExceededError'
}

/**
 * One copy transaction: read the cursor, number the unnumbered documents after
 * it, write their rows, then advance the cursor. A document and its rows change
 * in the same transaction, so a document retracted or deleted meanwhile cannot
 * come back through its rows. Resolves to how many documents it read.
 */
async function copyPostingsBatch(scopeJid: string | null): Promise<number> {
  const db = await getDB(scopeJid)
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE, POSTINGS_STORE, META_STORE], 'readwrite')
  void tx.done.catch(() => {})
  try {
    const meta = tx.objectStore(META_STORE)
    if (await meta.get(POSTINGS_READY_KEY)) { await tx.done; return 0 }
    const cursor = (await meta.get(POSTINGS_CURSOR_KEY))?.value
    const batch = await tx.objectStore(DOCS_STORE).getAll(
      cursor === undefined ? undefined : IDBKeyRange.lowerBound(cursor, true),
      POSTINGS_COPY_BATCH_SIZE,
    )
    if (batch.length === 0) { await tx.done; return 0 }
    const writer = createDocumentWriter(tx)
    for (const doc of batch) if (doc.docNo === undefined) await writer.put(doc)
    await writer.flush()
    await meta.put({ key: POSTINGS_CURSOR_KEY, value: batch[batch.length - 1].indexId })
    await tx.done
    return batch.length
  } catch (error) {
    try { tx.abort() } catch { /* Already finished. */ }
    await tx.done.catch(() => {})
    throw error
  }
}

/** Set the ready marker once no document is left after the cursor. */
async function markPostingsReady(scopeJid: string | null): Promise<void> {
  const db = await getDB(scopeJid)
  const tx = db.transaction([DOCS_STORE, META_STORE], 'readwrite')
  void tx.done.catch(() => {})
  const meta = tx.objectStore(META_STORE)
  const cursor = (await meta.get(POSTINGS_CURSOR_KEY))?.value
  const rest = await tx.objectStore(DOCS_STORE).getAll(
    cursor === undefined ? undefined : IDBKeyRange.lowerBound(cursor, true), 1)
  if (rest.length === 0) await meta.put({ key: POSTINGS_READY_KEY, value: '1' })
  await tx.done
}

/**
 * Copy the stored search documents into the time-sorted index, in the background.
 *
 * Reads the stored documents only, never the message cache: a document known only
 * from server search exists nowhere else. Resumable: the cursor lives in the
 * database, so a quit continues where it stopped, and two windows serialize on
 * the transaction. The loop checks the account between batches, so an account
 * switch ends it. A full disk ends it quietly and the next login retries. Search
 * keeps using the old lists until the ready marker is written; nothing here changes what it returns.
 */
export async function migrateSearchPostings(): Promise<void> {
  if (!isIndexedDBAvailable()) return
  const scope = captureStorageScope()
  await maintainIndex(scope.jid, async () => {
    try {
      for (;;) {
        scope.assertCurrent()
        if (await copyPostingsBatch(scope.jid) > 0) {
          await new Promise(resolve => setTimeout(resolve, POSTINGS_COPY_PAUSE_MS))
          continue
        }
        scope.assertCurrent()
        await markPostingsReady(scope.jid)
        if (await isPostingsReady(scope.jid)) return
      }
    } catch (error) {
      if (!isStorageFull(error)) throw error
      console.warn('[searchIndex] Not enough storage to build the time-sorted index; retrying at next login')
    }
  })
}

/** Whether the time-sorted index holds every document. */
export async function isPostingsReady(scopeJid: string | null = getStorageScopeJid()): Promise<boolean> {
  const db = await getDB(scopeJid)
  return (await db.get(META_STORE, POSTINGS_READY_KEY)) !== undefined
}

// =============================================================================
// Filter tokens copy (version 6)
// =============================================================================

/** Documents given filter tokens per transaction: each batch also reads the message cache. */
const FILTERS_COPY_BATCH_SIZE = 100

/**
 * One copy batch: read the documents after the cursor, look their messages up in
 * the cache (a stored document has no attachment or poll), then give each one
 * its filter tokens and rows in one write transaction with the cursor. A
 * document written meanwhile already carries its tokens and is left alone, as
 * is one deleted meanwhile. Resolves to how many documents it read.
 */
async function copyFiltersBatch(scopeJid: string | null, assertCurrent: () => void): Promise<number> {
  const db = await getDB(scopeJid)
  const build = (await db.get(META_STORE, FILTERS_BUILD_KEY))?.value
  if (build === FILTERS_BUILD && await db.get(META_STORE, FILTERS_READY_KEY)) return 0
  const cursor = build === FILTERS_BUILD ? (await db.get(META_STORE, FILTERS_CURSOR_KEY))?.value : undefined
  const batch = await db.getAll(DOCS_STORE,
    cursor === undefined ? undefined : IDBKeyRange.lowerBound(cursor, true), FILTERS_COPY_BATCH_SIZE)
  const pending = batch.filter(doc => doc.filterBuild !== FILTERS_BUILD)
  const cached = pending.length ? await messageCache.resolveMessagesForIndex(pending.map(docToMessage), scopeJid) : []
  const sources = new Map(pending.map((doc, i) => [doc.indexId, cached[i]?.cached ? cached[i]?.message : undefined]))
  assertCurrent()
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE, POSTINGS_STORE, META_STORE], 'readwrite')
  void tx.done.catch(() => {})
  try {
    const meta = tx.objectStore(META_STORE)
    const currentBuild = (await meta.get(FILTERS_BUILD_KEY))?.value
    const currentCursor = currentBuild === FILTERS_BUILD ? (await meta.get(FILTERS_CURSOR_KEY))?.value : undefined
    // Another tab may have committed this batch while the cache was being read.
    if (currentCursor !== cursor || (currentBuild === FILTERS_BUILD && await meta.get(FILTERS_READY_KEY))) {
      await tx.done
      return 1
    }
    if (currentBuild !== FILTERS_BUILD) {
      await meta.put({ key: FILTERS_BUILD_KEY, value: FILTERS_BUILD })
      await meta.delete(FILTERS_READY_KEY)
      await meta.delete(FILTERS_CURSOR_KEY)
    }
    const docs = tx.objectStore(DOCS_STORE)
    const writer = createDocumentWriter(tx)
    for (const snapshot of pending) {
      assertCurrent()
      const current = await docs.get(snapshot.indexId)
      if (!current || current.filterBuild === FILTERS_BUILD) continue
      const source = sameIndexDocument(current, snapshot) ? sources.get(current.indexId) : undefined
      if (source && (source.isRetracted || isNoLocalStore(source))) {
        await writer.delete(current)
        for (const token of current.tokens) {
          const entry = await tx.objectStore(TOKENS_STORE).get(token)
          const postings = entry?.postings.filter(id => id !== current.indexId) ?? []
          if (postings.length) await tx.objectStore(TOKENS_STORE).put({ token, postings })
          else await tx.objectStore(TOKENS_STORE).delete(token)
        }
        continue
      }
      const filterTokens = source ? messageFilterTokens(source)
        : messageFilterTokens({ ...docToMessage(current), body: '' })
      await writer.put({ ...current, filterTokens, filterBuild: FILTERS_BUILD, filterContentUnknown: !source })
    }
    await writer.flush()
    if (batch.length) await meta.put({ key: FILTERS_CURSOR_KEY, value: batch[batch.length - 1].indexId })
    else await meta.put({ key: FILTERS_READY_KEY, value: '1' })
    await tx.done
    return batch.length
  } catch (error) {
    try { tx.abort() } catch { /* A failed request may already have aborted the transaction. */ }
    await tx.done.catch(() => {})
    throw error
  }
}

export type FilterIndexState = { status: 'preparing' | 'usable' | 'incomplete' | 'unavailable'; reason?: string }

export async function getFilterIndexState(scopeJid: string | null = getStorageScopeJid()): Promise<FilterIndexState> {
  const reason = filterErrors.get(scopeJid)
  if (reason) return { status: 'unavailable', reason }
  if (!isIndexedDBAvailable()) return { status: 'unavailable', reason: 'IndexedDB not available' }
  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction(META_STORE)
    const [build, ready, unknown] = await Promise.all([
      tx.store.get(FILTERS_BUILD_KEY), tx.store.get(FILTERS_READY_KEY), tx.store.get(FILTERS_UNKNOWN_KEY),
    ])
    await tx.done
    if (build?.value !== FILTERS_BUILD || !ready) return { status: 'preparing' }
    return { status: Number(unknown?.value ?? 0) > 0 ? 'incomplete' : 'usable' }
  } catch (error) {
    return { status: 'unavailable', reason: error instanceof Error ? error.message : String(error) }
  }
}

export async function migrateSearchFilters(): Promise<void> {
  if (!isIndexedDBAvailable()) return
  const scope = captureStorageScope()
  filterErrors.delete(scope.jid)
  notifyFilterIndex()
  await maintainIndex(scope.jid, async () => {
    try {
      for (;;) {
        scope.assertCurrent()
        const copied = await copyFiltersBatch(scope.jid, scope.assertCurrent)
        scope.assertCurrent()
        if (!copied) break
        await new Promise(resolve => setTimeout(resolve, POSTINGS_COPY_PAUSE_MS))
      }
    } catch (error) {
      if (scope.isCurrent()) {
        filterErrors.set(scope.jid, error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (scope.isCurrent()) notifyFilterIndex()
    }
  })
}

export async function isFilterIndexReady(scopeJid: string | null = getStorageScopeJid()): Promise<boolean> {
  const state = await getFilterIndexState(scopeJid)
  return state.status === 'usable' || state.status === 'incomplete'
}

/**
 * Progress info emitted during index rebuild.
 */
export interface RebuildProgress {
  /** Messages indexed so far */
  indexed: number
  /** Total messages to index (chat + room) */
  total: number
}

/**
 * Rebuild the search index from scratch.
 *
 * Clears all indexed data and re-indexes every message from messageCache.
 * Intended for the "Rebuild search index" button in settings.
 *
 * @param onProgress - Optional callback invoked after each batch with progress info.
 * @returns The total number of messages indexed.
 */
export async function rebuildSearchIndex(
  onProgress?: (progress: RebuildProgress) => void
): Promise<number> {
  if (!isIndexedDBAvailable()) return 0

  const scope = captureStorageScope()
  return maintainIndex(scope.jid, async () => {
    scope.assertCurrent()
    await clearIndexData(scope.jid)
    scope.assertCurrent()

    // Count total messages for progress reporting
    const totalMessages =
      (await messageCache.getTotalMessageCount('chat')) +
      (await messageCache.getTotalMessageCount('room'))

    let indexed = 0
    scope.assertCurrent()

    await messageCache.iterateAllMessages('chat', BACKFILL_BATCH_SIZE, async (batch) => {
      scope.assertCurrent()
      await indexMessages(batch, { fromCache: true }, scope.jid)
      scope.assertCurrent()
      indexed += batch.length
      onProgress?.({ indexed, total: totalMessages })
    })

    scope.assertCurrent()
    await messageCache.iterateAllMessages('room', BACKFILL_BATCH_SIZE, async (batch) => {
      scope.assertCurrent()
      await indexMessages(batch, { fromCache: true }, scope.jid)
      scope.assertCurrent()
      indexed += batch.length
      onProgress?.({ indexed, total: totalMessages })
    })

    scope.assertCurrent()
    await markBackfillComplete(scope.jid)
    return indexed
  })
}

// =============================================================================
// Lifecycle
// =============================================================================

/**
 * Clear all data from the search index (tokens, docs, and meta).
 * Keeps the database open — call on logout to wipe indexed data.
 */
export async function clearSearchIndex(): Promise<void> {
  if (!isIndexedDBAvailable()) return
  const scopeJid = getStorageScopeJid()
  try { await maintainIndex(scopeJid, () => clearIndexData(scopeJid)) } catch {
    // Ignore errors (DB may not exist yet)
  }
}

async function clearIndexData(scopeJid: string | null): Promise<void> {
  await mutateIndex(scopeJid, async () => {
    const db = await getDB(scopeJid)
    const tx = db.transaction([TOKENS_STORE, DOCS_STORE, POSTINGS_STORE, META_STORE], 'readwrite')
    await tx.objectStore(TOKENS_STORE).clear()
    await tx.objectStore(DOCS_STORE).clear()
    await tx.objectStore(POSTINGS_STORE).clear()
    await tx.objectStore(META_STORE).clear()
    // An empty index has nothing to copy: whatever is written next numbers itself.
    await tx.objectStore(META_STORE).put({ key: POSTINGS_READY_KEY, value: '1' })
    await tx.objectStore(META_STORE).put({ key: FILTERS_READY_KEY, value: '1' })
    await tx.objectStore(META_STORE).put({ key: FILTERS_BUILD_KEY, value: FILTERS_BUILD })
    await tx.done
  })
}

/**
 * Close the current database connection without deleting data.
 * @internal Used for testing cleanup.
 */
export async function closeSearchIndex(): Promise<void> {
  if (dbPromise) {
    try {
      const db = await dbPromise
      db.close()
    } catch {
      // Ignore
    }
    dbPromise = null
    dbNameForPromise = null
  }
}

/**
 * Reset internal database reference for testing.
 * @internal
 */
export function _resetDBForTesting(): void {
  filterErrors.clear()
  dbPromise = null
  dbNameForPromise = null
}
