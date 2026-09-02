/**
 * Full-text search index using a custom inverted index stored in IndexedDB.
 *
 * Zero runtime memory overhead — the index lives entirely in IndexedDB.
 * Queries do O(k) IDB lookups (k = number of query terms) instead of O(n) cursor scans.
 *
 * Two object stores:
 * - `search-tokens`: inverted index (token → posting list of indexIds)
 * - `search-docs`: forward index (indexId → document metadata + tokens for deletion)
 *
 * Uses the same scoped-DB pattern as messageCache.ts.
 *
 * @module SearchIndex
 */

import { openDB, type IDBPDatabase, type DBSchema } from 'idb'
import type { Message, RoomMessage } from '../core/types'
import { isNoLocalStore } from '../core/types/message-internal'
import { getStorageScopeJid } from './storageScope'
import {
  chatRetractionAliases,
  roomRetractionAliases,
  retractedAtForIdentity,
  type RetractionScope,
} from './retractedIdentities'
import * as messageCache from './messageCache'

import {
  chatMessageAuthor,
  identityKeys,
  occupantConflict,
  roomMessageAuthor,
  roomScope,
  searchDocumentFallbackKey,
  searchDocumentKey,
} from './messageIdentity'

const DB_NAME = 'fluux-search-index'
const DB_VERSION = 2
const TOKENS_STORE = 'search-tokens'
const DOCS_STORE = 'search-docs'
const META_STORE = 'search-meta'

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
      timestamp: number
      conversationId: string
    }
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
}

// =============================================================================
// Database management
// =============================================================================

let dbPromise: Promise<IDBPDatabase<SearchIndexSchema>> | null = null
let dbNameForPromise: string | null = null

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
  dbPromise = openDB<SearchIndexSchema>(targetDbName, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(TOKENS_STORE)) {
        db.createObjectStore(TOKENS_STORE, { keyPath: 'token' })
      }
      if (!db.objectStoreNames.contains(DOCS_STORE)) {
        const docsStore = db.createObjectStore(DOCS_STORE, { keyPath: 'indexId' })
        docsStore.createIndex('timestamp', 'timestamp', { unique: false })
        docsStore.createIndex('conversationId', 'conversationId', { unique: false })
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE, { keyPath: 'key' })
      }
    },
  })

  return dbPromise
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
 * The room form comes from {@link searchDocumentKey} — a persisted shape.
 */
function getIndexId(message: Message | RoomMessage): string {
  if (message.type === 'groupchat') {
    return `room:${searchDocumentKey(message)}`
  }
  return `chat:${message.id}`
}

/**
 * The index ids a message may ALSO be stored under, besides {@link getIndexId}.
 *
 * The two room forms are mutually exclusive at write time, so a room message
 * indexed before its archive id arrived lives under the composite form for good —
 * its document is invisible to a removal that only knows the stanza form. This is
 * the read-side complement, not a second write key: nothing is ever indexed here.
 */
function getFallbackIndexIds(message: Message | RoomMessage): string[] {
  if (message.type !== 'groupchat' || !message.stanzaId) return []
  return [`room:${searchDocumentFallbackKey(message)}`]
}

interface RoomDocumentOwner {
  roomJid: string
  from: string
  id: string
  originId?: string
  occupantId?: string
}

export interface RoomIdentityClosure {
  identityKeys: readonly string[]
  ids: readonly string[]
}

const ROOM_OWNER_CAP = 2000
const roomDocumentOwners = new Map<string, RoomDocumentOwner>()

function roomOwnerKey(indexId: string, scopeJid: string | null): string {
  return `${scopeJid ?? ''}\u0000${indexId}`
}

function clearRoomDocumentOwners(scopeJid: string | null): void {
  const prefix = `${scopeJid ?? ''}\u0000`
  for (const key of roomDocumentOwners.keys()) {
    if (key.startsWith(prefix)) roomDocumentOwners.delete(key)
  }
}

function recordRoomDocumentOwner(
  indexId: string,
  message: Message | RoomMessage,
  scopeJid: string | null
): void {
  if (message.type !== 'groupchat' || message.stanzaId) return
  roomDocumentOwners.set(roomOwnerKey(indexId, scopeJid), {
    roomJid: message.roomJid,
    from: message.from,
    id: message.id,
    originId: message.originId,
    occupantId: message.occupantId,
  })
  while (roomDocumentOwners.size > ROOM_OWNER_CAP) {
    const oldest = roomDocumentOwners.keys().next()
    if (oldest.done) break
    roomDocumentOwners.delete(oldest.value)
  }
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
    !occupantConflict(doc, message)
}

function fallbackDocNamesMessage(
  doc: DocEntry,
  message: Message | RoomMessage,
  indexId: string,
  scopeJid: string | null
): boolean {
  if (message.type !== 'groupchat' || !docBelongsToRoom(doc, message)) return false
  if (doc.messageId !== message.id || doc.from !== message.from) return false
  // A room message carrying neither occupant-id nor origin-id cannot prove
  // ownership of its composite document after nick reassignment, so only its
  // canonical document is removed. This window is bounded to messages indexed
  // in that identifier-less form; closing it requires additional durable
  // ownership data.
  const durableOwner: RoomDocumentOwner = {
    roomJid: doc.conversationId,
    from: doc.from,
    id: doc.messageId,
    originId: doc.originId,
    occupantId: doc.occupantId,
  }
  if (roomOwnerNamesMessage(durableOwner, message)) return true
  const owner = roomDocumentOwners.get(roomOwnerKey(indexId, scopeJid))
  return owner ? roomOwnerNamesMessage(owner, message) : false
}

function docBelongsToRoomIdentityClosure(
  doc: DocEntry,
  message: RoomMessage,
  indexId: string,
  closureKeys: ReadonlySet<string>,
  closureIds: ReadonlySet<string>,
  scopeJid: string | null
): boolean {
  if (!docBelongsToRoom(doc, message)) return false
  const docKeys = identityKeys(roomScope(doc.conversationId), {
    from: doc.from,
    id: doc.messageId,
    stanzaId: doc.stanzaId,
    originId: doc.originId,
    occupantId: doc.occupantId,
  })
  if (docKeys.slice(0, -1).some((key) => closureKeys.has(key))) return true
  if (!closureKeys.has(docKeys[docKeys.length - 1]) || !closureIds.has(doc.messageId)) {
    return false
  }
  return fallbackDocNamesMessage(
    doc,
    { ...message, id: doc.messageId },
    indexId,
    scopeJid
  )
}

function roomOwnerNamesMessage(owner: RoomDocumentOwner, message: RoomMessage): boolean {
  if (owner.roomJid !== message.roomJid || owner.from !== message.from || owner.id !== message.id) {
    return false
  }
  if (owner.occupantId && message.occupantId) return owner.occupantId === message.occupantId
  if (owner.originId && message.originId) return owner.originId === message.originId
  return false
}

function docBelongsToChat(doc: DocEntry, message: Message): boolean {
  return !doc.isRoom &&
    doc.messageId === message.id &&
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
    body: message.body!,
  }
  if (message.stanzaId) doc.stanzaId = message.stanzaId
  if (message.originId) doc.originId = message.originId
  if (message.type === 'groupchat') {
    doc.nick = message.nick
    if (message.occupantId) doc.occupantId = message.occupantId
  }
  return doc
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
 * say so. Two blind spots, one per timescale:
 *
 * - This session: a retraction and its target's own indexing are independent
 *   fire-and-forget promises, so `removeMessage` can find no document and the
 *   indexing that follows would put the retracted body back
 *   (`retractedIdentities.ts`).
 * - An earlier session: an archive re-delivery carries the original body, and
 *   only the cached tombstone still remembers the retraction.
 *
 * The in-memory check answers first and costs nothing; the cache read is the
 * fallback.
 */
function isKnownRetracted(message: Message | RoomMessage, scopeJid: string | null): boolean {
  const aliases =
    message.type === 'groupchat'
      ? roomRetractionAliases(message)
      : chatRetractionAliases(message)
  return retractedAtForIdentity(
    retractionScopeOf(message, scopeJid),
    aliases,
    (record) =>
      message.type === 'groupchat'
        ? roomMessageAuthor(message, record)
        : chatMessageAuthor(message, record)
  ) !== undefined
}

async function isRetractedElsewhere(
  message: Message | RoomMessage,
  scopeJid: string | null
): Promise<boolean> {
  if (isKnownRetracted(message, scopeJid)) return true
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
  const unknown = messages.filter((m) => !isKnownRetracted(m, scopeJid))
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
 * Skips messages with no body, retracted messages, and noLocalStore messages.
 * Silently returns if IndexedDB is not available.
 */
export async function indexMessage(
  message: Message | RoomMessage,
  scopeJid: string | null = getStorageScopeJid()
): Promise<void> {
  if (!isIndexedDBAvailable()) return
  if (!message.body || message.isRetracted || isNoLocalStore(message)) return
  if (await isRetractedElsewhere(message, scopeJid)) return

  const indexId = getIndexId(message)
  const tokens = uniqueTokens(message.body)
  if (tokens.length === 0) return

  const db = await getDB(scopeJid)
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE], 'readwrite')
  const tokensStore = tx.objectStore(TOKENS_STORE)
  const docsStore = tx.objectStore(DOCS_STORE)

  // Check if already indexed (idempotent)
  const existing = await docsStore.get(indexId)
  if (existing) {
    await tx.done
    return
  }

  const doc = createDocEntry(message, indexId, tokens)
  if (isKnownRetracted(message, scopeJid)) {
    await tx.done
    return
  }
  await docsStore.put(doc)

  // Update posting lists for each token
  for (const token of tokens) {
    const entry = await tokensStore.get(token)
    if (entry) {
      if (!entry.postings.includes(indexId)) {
        entry.postings.push(indexId)
        await tokensStore.put(entry)
      }
    } else {
      await tokensStore.put({ token, postings: [indexId] })
    }
  }

  await tx.done
  recordRoomDocumentOwner(indexId, message, scopeJid)
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
  const candidates = messages.filter((m) => m.body && !m.isRetracted && !isNoLocalStore(m))
  const indexable = await rejectRetracted(candidates, options.fromCache === true, scopeJid)
  if (indexable.length === 0) return

  // Process in small batches to keep each IDB transaction short-lived
  for (let i = 0; i < indexable.length; i += INDEX_BATCH_SIZE) {
    const batch = indexable.slice(i, i + INDEX_BATCH_SIZE)
    await indexBatch(batch, scopeJid)
  }
}

/**
 * Index a small batch of messages in a single transaction.
 * Kept small enough that the IDB transaction won't auto-commit.
 */
async function indexBatch(
  messages: (Message | RoomMessage)[],
  scopeJid: string | null
): Promise<void> {
  const db = await getDB(scopeJid)
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE], 'readwrite')
  const tokensStore = tx.objectStore(TOKENS_STORE)
  const docsStore = tx.objectStore(DOCS_STORE)

  const tokenCache = new Map<string, TokenEntry>()
  const indexedMessages: Array<{ indexId: string; message: Message | RoomMessage }> = []

  for (const message of messages) {
    const indexId = getIndexId(message)
    const tokens = uniqueTokens(message.body!)
    if (tokens.length === 0) continue

    // Skip if already indexed
    const existing = await docsStore.get(indexId)
    if (existing) continue

    const doc = createDocEntry(message, indexId, tokens)
    if (isKnownRetracted(message, scopeJid)) continue
    await docsStore.put(doc)
    indexedMessages.push({ indexId, message })

    for (const token of tokens) {
      let entry = tokenCache.get(token)
      if (!entry) {
        entry = (await tokensStore.get(token)) || { token, postings: [] }
        tokenCache.set(token, entry)
      }
      if (!entry.postings.includes(indexId)) {
        entry.postings.push(indexId)
      }
    }
  }

  // Write all modified token entries
  for (const entry of tokenCache.values()) {
    await tokensStore.put(entry)
  }

  await tx.done
  for (const indexed of indexedMessages) {
    recordRoomDocumentOwner(indexed.indexId, indexed.message, scopeJid)
  }
}

/**
 * Remove a message from the search index.
 * Reads the document's token list and removes it from all posting lists.
 */
export async function removeMessage(
  message: Message | RoomMessage,
  scopeJid: string | null = getStorageScopeJid(),
  roomIdentityClosure?: RoomIdentityClosure
): Promise<void> {
  if (!isIndexedDBAvailable()) return

  const db = await getDB(scopeJid)
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE], 'readwrite')
  const tokensStore = tx.objectStore(TOKENS_STORE)
  const docsStore = tx.objectStore(DOCS_STORE)
  const closureKeys = new Set(roomIdentityClosure?.identityKeys ?? [])
  const closureIds = new Set(roomIdentityClosure?.ids ?? [])

  const drop = async (
    indexId: string,
    verification: 'chat' | 'room' | 'room-identity' | 'room-closure'
  ): Promise<void> => {
    const doc = await docsStore.get(indexId)
    if (!doc) return
    if (verification === 'chat' && (message.type === 'groupchat' || !docBelongsToChat(doc, message))) return
    if (verification === 'room' && (message.type !== 'groupchat' || !docBelongsToRoom(doc, message))) return
    if (verification === 'room-identity' && !fallbackDocNamesMessage(doc, message, indexId, scopeJid)) return
    if (
      verification === 'room-closure' &&
      (message.type !== 'groupchat' || !docBelongsToRoomIdentityClosure(
        doc,
        message,
        indexId,
        closureKeys,
        closureIds,
        scopeJid
      ))
    ) return

    // Remove from all posting lists
    for (const token of doc.tokens) {
      const entry = await tokensStore.get(token)
      if (entry) {
        entry.postings = entry.postings.filter((id) => id !== indexId)
        if (entry.postings.length === 0) {
          await tokensStore.delete(token)
        } else {
          await tokensStore.put(entry)
        }
      }
    }

    // Remove the document
    await docsStore.delete(indexId)
    roomDocumentOwners.delete(roomOwnerKey(indexId, scopeJid))
  }

  await drop(
    getIndexId(message),
    message.type !== 'groupchat' ? 'chat' : message.stanzaId ? 'room' : 'room-identity'
  )
  for (const fallbackId of getFallbackIndexIds(message)) {
    await drop(fallbackId, 'room-identity')
  }
  if (message.type === 'groupchat' && roomIdentityClosure) {
    const docs = await docsStore.index('conversationId').getAll(message.roomJid)
    for (const doc of docs) await drop(doc.indexId, 'room-closure')
  }

  await tx.done
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
  await removeMessage(message, scopeJid)
  await indexMessage(message, scopeJid)
}

/**
 * Search for messages matching the query.
 *
 * Tokenizes the query, looks up posting lists for each term, intersects them,
 * and returns matching documents sorted by timestamp (newest first).
 *
 * Supports quoted phrases: `"exact phrase"` requires the phrase to appear
 * contiguously in the message body. Unquoted terms use AND matching with
 * prefix matching on the last term for search-as-you-type.
 */
export async function search(
  query: string,
  options?: { limit?: number; conversationId?: string; isRoom?: boolean }
): Promise<SearchIndexResult[]> {
  if (!isIndexedDBAvailable()) return []
  const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT
  const parsed = parseSearchQuery(query)

  // Collect all tokens needed for index lookup:
  // unquoted terms + tokens from each phrase
  const phraseTokens = parsed.phrases.flatMap((p) => tokenize(p))
  const allTokens = [...parsed.terms, ...phraseTokens]

  // Deduplicate tokens for index lookup
  const uniqueAllTokens = [...new Set(allTokens)]
  if (uniqueAllTokens.length === 0) return []

  const db = await getDB()
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

  // Fetch matching documents
  const docs: DocEntry[] = []
  for (const indexId of result) {
    const doc = await docsStore.get(indexId)
    if (doc) {
      // Apply conversation filter if specified
      if (options?.conversationId && doc.conversationId !== options.conversationId) {
        continue
      }
      // Apply isRoom filter if specified
      if (options?.isRoom !== undefined && doc.isRoom !== options.isRoom) {
        continue
      }
      // Post-filter: verify exact phrases appear contiguously in the body
      if (parsed.phrases.length > 0) {
        const bodyLower = doc.body.toLowerCase()
        const allPhrasesMatch = parsed.phrases.every((phrase) =>
          bodyLower.includes(phrase)
        )
        if (!allPhrasesMatch) continue
      }
      docs.push(doc)
    }
  }

  // Sort by timestamp descending (newest first)
  docs.sort((a, b) => b.timestamp - a.timestamp)

  // Limit results
  const limited = docs.slice(0, limit)

  return limited.map((doc) => {
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
    }
  })
}

// =============================================================================
// Backfill
// =============================================================================

const BACKFILL_KEY = 'backfill-complete'
const BACKFILL_BATCH_SIZE = 500

/**
 * Check if the initial backfill from messageCache has been completed.
 */
async function isBackfillComplete(): Promise<boolean> {
  const db = await getDB()
  const entry = await db.get(META_STORE, BACKFILL_KEY)
  return !!entry
}

/**
 * Mark the backfill as complete so it won't run again.
 */
async function markBackfillComplete(): Promise<void> {
  const db = await getDB()
  await db.put(META_STORE, { key: BACKFILL_KEY, value: 'true' })
}

/**
 * Backfill the search index with all existing messages from messageCache.
 *
 * Runs once per account — tracks completion in the search index DB.
 * Processes messages in batches to avoid holding all messages in memory.
 * Safe to call multiple times; subsequent calls are no-ops.
 */
export async function backfillFromMessageCache(): Promise<void> {
  if (!isIndexedDBAvailable()) return

  if (await isBackfillComplete()) return

  let chatCount = 0
  let roomCount = 0

  await messageCache.iterateAllMessages(BACKFILL_BATCH_SIZE, async (batch) => {
    await indexMessages(batch, { fromCache: true })
    chatCount += batch.length
  })

  await messageCache.iterateAllRoomMessages(BACKFILL_BATCH_SIZE, async (batch) => {
    await indexMessages(batch, { fromCache: true })
    roomCount += batch.length
  })

  await markBackfillComplete()

  if (chatCount > 0 || roomCount > 0) {
    console.log(`[searchIndex] Backfill complete: indexed ${chatCount} chat + ${roomCount} room messages`)
  }
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

  const scopeJid = getStorageScopeJid()
  clearRoomDocumentOwners(scopeJid)
  // Clear existing index data
  const db = await getDB(scopeJid)
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE, META_STORE], 'readwrite')
  await tx.objectStore(TOKENS_STORE).clear()
  await tx.objectStore(DOCS_STORE).clear()
  await tx.objectStore(META_STORE).clear()
  await tx.done

  // Count total messages for progress reporting
  const totalMessages =
    (await messageCache.getTotalMessageCount()) +
    (await messageCache.getTotalRoomMessageCount())

  let indexed = 0

  await messageCache.iterateAllMessages(BACKFILL_BATCH_SIZE, async (batch) => {
    await indexMessages(batch, { fromCache: true })
    indexed += batch.length
    onProgress?.({ indexed, total: totalMessages })
  })

  await messageCache.iterateAllRoomMessages(BACKFILL_BATCH_SIZE, async (batch) => {
    await indexMessages(batch, { fromCache: true })
    indexed += batch.length
    onProgress?.({ indexed, total: totalMessages })
  })

  await markBackfillComplete()
  return indexed
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
  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction([TOKENS_STORE, DOCS_STORE, META_STORE], 'readwrite')
    await tx.objectStore(TOKENS_STORE).clear()
    await tx.objectStore(DOCS_STORE).clear()
    await tx.objectStore(META_STORE).clear()
    await tx.done
    clearRoomDocumentOwners(scopeJid)
  } catch {
    // Ignore errors (DB may not exist yet)
  }
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
  dbPromise = null
  dbNameForPromise = null
  roomDocumentOwners.clear()
}
