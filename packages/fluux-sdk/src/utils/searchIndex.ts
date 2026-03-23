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
import { getStorageScopeJid } from './storageScope'

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
// Tokenization
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
 * For room messages, uses the cacheKey pattern (stanzaId or roomJid:from:id).
 */
function getIndexId(message: Message | RoomMessage): string {
  if (message.type === 'groupchat') {
    // Use stanzaId if available, otherwise composite key (matches messageCache pattern)
    const key = message.stanzaId || `${message.roomJid}:${message.from}:${message.id}`
    return `room:${key}`
  }
  return `chat:${message.id}`
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
 * Skips messages with no body, retracted messages, and noStore messages.
 * Silently returns if IndexedDB is not available.
 */
export async function indexMessage(message: Message | RoomMessage): Promise<void> {
  if (!isIndexedDBAvailable()) return
  if (!message.body || message.isRetracted || message.noStore) return

  const indexId = getIndexId(message)
  const tokens = uniqueTokens(message.body)
  if (tokens.length === 0) return

  const conversationId = message.type === 'groupchat' ? message.roomJid : message.conversationId

  const db = await getDB()
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE], 'readwrite')
  const tokensStore = tx.objectStore(TOKENS_STORE)
  const docsStore = tx.objectStore(DOCS_STORE)

  // Check if already indexed (idempotent)
  const existing = await docsStore.get(indexId)
  if (existing) {
    await tx.done
    return
  }

  // Write document entry
  const doc: DocEntry = {
    indexId,
    messageId: message.id,
    tokens,
    conversationId,
    from: message.from,
    timestamp: message.timestamp.getTime(),
    isRoom: message.type === 'groupchat',
    body: message.body,
  }
  if (message.type === 'groupchat') doc.nick = message.nick
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
}

/**
 * Maximum messages per IDB transaction to avoid transaction lifetime issues.
 * IDB transactions auto-commit when the event loop goes idle; large batches
 * with many awaits can exceed this window and silently fail.
 */
const INDEX_BATCH_SIZE = 50

/**
 * Index multiple messages, splitting into small transactions to avoid
 * IDB transaction lifetime issues.
 * Silently returns if IndexedDB is not available.
 */
export async function indexMessages(messages: (Message | RoomMessage)[]): Promise<void> {
  if (!isIndexedDBAvailable()) return
  const indexable = messages.filter((m) => m.body && !m.isRetracted && !m.noStore)
  if (indexable.length === 0) return

  // Process in small batches to keep each IDB transaction short-lived
  for (let i = 0; i < indexable.length; i += INDEX_BATCH_SIZE) {
    const batch = indexable.slice(i, i + INDEX_BATCH_SIZE)
    await indexBatch(batch)
  }
}

/**
 * Index a small batch of messages in a single transaction.
 * Kept small enough that the IDB transaction won't auto-commit.
 */
async function indexBatch(messages: (Message | RoomMessage)[]): Promise<void> {
  const db = await getDB()
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE], 'readwrite')
  const tokensStore = tx.objectStore(TOKENS_STORE)
  const docsStore = tx.objectStore(DOCS_STORE)

  const tokenCache = new Map<string, TokenEntry>()

  for (const message of messages) {
    const indexId = getIndexId(message)
    const tokens = uniqueTokens(message.body!)
    if (tokens.length === 0) continue

    const conversationId =
      message.type === 'groupchat' ? message.roomJid : message.conversationId

    // Skip if already indexed
    const existing = await docsStore.get(indexId)
    if (existing) continue

    const doc: DocEntry = {
      indexId,
      messageId: message.id,
      tokens,
      conversationId,
      from: message.from,
      timestamp: message.timestamp.getTime(),
      isRoom: message.type === 'groupchat',
      body: message.body!,
    }
    if (message.type === 'groupchat') doc.nick = message.nick
    await docsStore.put(doc)

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
}

/**
 * Remove a message from the search index.
 * Reads the document's token list and removes it from all posting lists.
 */
export async function removeMessage(message: Message | RoomMessage): Promise<void> {
  if (!isIndexedDBAvailable()) return
  const indexId = getIndexId(message)

  const db = await getDB()
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE], 'readwrite')
  const tokensStore = tx.objectStore(TOKENS_STORE)
  const docsStore = tx.objectStore(DOCS_STORE)

  const doc = await docsStore.get(indexId)
  if (!doc) {
    await tx.done
    return
  }

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
  await tx.done
}

/**
 * Update a message in the search index (e.g., after XEP-0308 correction).
 * Removes the old entry and re-indexes with the new body.
 */
export async function updateMessage(message: Message | RoomMessage): Promise<void> {
  if (!isIndexedDBAvailable()) return
  await removeMessage(message)
  await indexMessage(message)
}

/**
 * Search for messages matching the query.
 *
 * Tokenizes the query, looks up posting lists for each term, intersects them,
 * and returns matching documents sorted by timestamp (newest first).
 *
 * The last query term supports prefix matching for search-as-you-type.
 */
export async function search(
  query: string,
  options?: { limit?: number; conversationId?: string }
): Promise<SearchIndexResult[]> {
  if (!isIndexedDBAvailable()) return []
  const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT
  const tokens = tokenize(query)
  if (tokens.length === 0) return []

  const db = await getDB()

  // Split: exact match for all terms except last, prefix for last term
  const exactTerms = tokens.slice(0, -1)
  const prefixTerm = tokens[tokens.length - 1]

  const tx = db.transaction([TOKENS_STORE, DOCS_STORE], 'readonly')
  const tokensStore = tx.objectStore(TOKENS_STORE)
  const docsStore = tx.objectStore(DOCS_STORE)

  // Gather posting lists for exact terms
  const postingLists: Set<string>[] = []

  for (const term of exactTerms) {
    const entry = await tokensStore.get(term)
    if (!entry || entry.postings.length === 0) {
      // A required term has no matches — empty result
      return []
    }
    postingLists.push(new Set(entry.postings))
  }

  // Prefix match for the last term using IDB key range
  const prefixPostings = new Set<string>()
  const range = IDBKeyRange.bound(prefixTerm, prefixTerm + '\uffff')
  let cursor = await tokensStore.openCursor(range)
  while (cursor) {
    for (const id of cursor.value.postings) {
      prefixPostings.add(id)
    }
    cursor = await cursor.continue()
  }

  if (prefixPostings.size === 0) return []
  postingLists.push(prefixPostings)

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

  // Dynamic import to avoid circular dependency and keep lazy loading possible
  const messageCache = await import('./messageCache')

  let chatCount = 0
  let roomCount = 0

  await messageCache.iterateAllMessages(BACKFILL_BATCH_SIZE, async (batch) => {
    await indexMessages(batch)
    chatCount += batch.length
  })

  await messageCache.iterateAllRoomMessages(BACKFILL_BATCH_SIZE, async (batch) => {
    await indexMessages(batch)
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

  // Clear existing index data
  const db = await getDB()
  const tx = db.transaction([TOKENS_STORE, DOCS_STORE, META_STORE], 'readwrite')
  await tx.objectStore(TOKENS_STORE).clear()
  await tx.objectStore(DOCS_STORE).clear()
  await tx.objectStore(META_STORE).clear()
  await tx.done

  // Count total messages for progress reporting
  const messageCache = await import('./messageCache')
  const totalMessages =
    (await messageCache.getTotalMessageCount()) +
    (await messageCache.getTotalRoomMessageCount())

  let indexed = 0

  await messageCache.iterateAllMessages(BACKFILL_BATCH_SIZE, async (batch) => {
    await indexMessages(batch)
    indexed += batch.length
    onProgress?.({ indexed, total: totalMessages })
  })

  await messageCache.iterateAllRoomMessages(BACKFILL_BATCH_SIZE, async (batch) => {
    await indexMessages(batch)
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
  try {
    const db = await getDB()
    const tx = db.transaction([TOKENS_STORE, DOCS_STORE, META_STORE], 'readwrite')
    await tx.objectStore(TOKENS_STORE).clear()
    await tx.objectStore(DOCS_STORE).clear()
    await tx.objectStore(META_STORE).clear()
    await tx.done
  } catch {
    // Ignore errors (DB may not exist yet)
  }
}

/**
 * Destroy the search index (close and delete the database).
 * Call on logout or account switch.
 */
export async function destroySearchIndex(): Promise<void> {
  if (dbPromise) {
    try {
      const db = await dbPromise
      db.close()
    } catch {
      // Ignore close errors
    }
    dbPromise = null
    dbNameForPromise = null
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
}
