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

const DB_NAME = 'fluux-message-cache'
const DB_VERSION = 2
const MESSAGES_STORE = 'messages'
const ROOM_MESSAGES_STORE = 'room-messages'

/**
 * Generate a unique cache key for a room message.
 * Uses stanzaId if available (globally unique from server),
 * otherwise falls back to roomJid:from:id (unique per sender).
 *
 * This fixes the duplicate message issue where different senders
 * could have the same message ID (XMPP IDs are only unique per sender).
 */
function getRoomMessageCacheKey(message: {
  stanzaId?: string
  roomJid: string
  from: string
  id: string
}): string {
  // Prefer stanzaId - it's globally unique (XEP-0359)
  if (message.stanzaId) {
    return message.stanzaId
  }
  // Fallback: composite key using roomJid:from:id
  return `${message.roomJid}:${message.from}:${message.id}`
}

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
interface StoredRoomMessage
  extends Omit<RoomMessage, 'timestamp' | 'retractedAt' | 'replyTo'> {
  /** Cache key used as the primary key in IndexedDB */
  cacheKey: string
  /** Timestamp as milliseconds since epoch for indexing */
  timestamp: number
  /** Retracted timestamp as milliseconds if message was retracted */
  retractedAt?: number
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
    upgrade(db, oldVersion) {
      // Chat messages store (unchanged)
      if (!db.objectStoreNames.contains(MESSAGES_STORE)) {
        const msgStore = db.createObjectStore(MESSAGES_STORE, { keyPath: 'id' })
        msgStore.createIndex('conversationId', 'conversationId', { unique: false })
        msgStore.createIndex('stanzaId', 'stanzaId', { unique: false })
        msgStore.createIndex('timestamp', 'timestamp', { unique: false })
        msgStore.createIndex('conv_timestamp', ['conversationId', 'timestamp'], {
          unique: false,
        })
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
    cacheKey: getRoomMessageCacheKey(message),
    timestamp: message.timestamp.getTime(),
    retractedAt: message.retractedAt?.getTime(),
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
  }
}

// =============================================================================
// Chat Message Operations
// =============================================================================

/**
 * Save a chat message to IndexedDB.
 * Upserts - will overwrite if message with same ID exists.
 */
export async function saveMessage(message: Message): Promise<void> {
  try {
    const db = await getDB(getStorageScopeJid())
    await db.put(MESSAGES_STORE, serializeMessage(message))
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to save message:', error)
    }
  }
}

/**
 * Save multiple chat messages to IndexedDB in a single transaction.
 */
export async function saveMessages(messages: Message[]): Promise<void> {
  if (messages.length === 0) return

  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(MESSAGES_STORE)

    await Promise.all(messages.map((msg) => store.put(serializeMessage(msg))))
    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to save messages:', error)
    }
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
        results.push(deserializeMessage(stored))
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
 * Write buffer for room messages.
 * Collects messages and flushes them in batches for better performance
 * and reliability during rapid-fire history message delivery (e.g., room join).
 */
const roomMessageBuffer: RoomMessage[] = []
let roomMessageFlushTimer: ReturnType<typeof setTimeout> | null = null
let roomMessageBufferScope: string | null = null
const ROOM_MESSAGE_FLUSH_DELAY = 100 // ms - flush after 100ms of inactivity

/**
 * Flush the room message buffer to IndexedDB.
 */
async function flushRoomMessageBuffer(scopeJid: string | null): Promise<void> {
  if (roomMessageBuffer.length === 0) return

  // Take all messages from buffer
  const messagesToSave = roomMessageBuffer.splice(0, roomMessageBuffer.length)

  try {
    const db = await getDB(scopeJid)
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(ROOM_MESSAGES_STORE)

    await Promise.all(messagesToSave.map((msg) => store.put(serializeRoomMessage(msg))))
    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to flush room message buffer:', error)
    }
  }
}

/**
 * Save a room message to IndexedDB.
 * Uses a write buffer to batch rapid writes for better performance.
 */
export async function saveRoomMessage(message: RoomMessage): Promise<void> {
  const currentScope = getStorageScopeJid()

  // Ensure queued messages are flushed to the account-specific DB they belong to.
  if (roomMessageBuffer.length > 0 && roomMessageBufferScope !== currentScope) {
    await flushPendingRoomMessages()
  }

  roomMessageBufferScope = currentScope

  // Add to buffer
  roomMessageBuffer.push(message)

  // Clear existing timer
  if (roomMessageFlushTimer) {
    clearTimeout(roomMessageFlushTimer)
  }

  // Set new timer to flush after delay
  roomMessageFlushTimer = setTimeout(() => {
    roomMessageFlushTimer = null
    const flushScope = roomMessageBufferScope
    roomMessageBufferScope = null
    void flushRoomMessageBuffer(flushScope)
  }, ROOM_MESSAGE_FLUSH_DELAY)
}

/**
 * Force flush any pending room messages immediately.
 * Call this before disconnect or when ensuring data persistence.
 */
export async function flushPendingRoomMessages(): Promise<void> {
  if (roomMessageFlushTimer) {
    clearTimeout(roomMessageFlushTimer)
    roomMessageFlushTimer = null
  }
  const flushScope = roomMessageBufferScope
  roomMessageBufferScope = null
  await flushRoomMessageBuffer(flushScope)
}

/**
 * Save multiple room messages to IndexedDB in a single transaction.
 */
export async function saveRoomMessages(messages: RoomMessage[]): Promise<void> {
  if (messages.length === 0) return

  try {
    const db = await getDB(getStorageScopeJid())
    const tx = db.transaction(ROOM_MESSAGES_STORE, 'readwrite')
    const store = tx.objectStore(ROOM_MESSAGES_STORE)

    await Promise.all(messages.map((msg) => store.put(serializeRoomMessage(msg))))
    await tx.done
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to save room messages:', error)
    }
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
        results.push(deserializeRoomMessage(stored))
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
    }

    await db.put(ROOM_MESSAGES_STORE, updated)
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to update room message:', error)
    }
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
    await flushPendingRoomMessages()
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
  if (roomMessageFlushTimer) {
    clearTimeout(roomMessageFlushTimer)
    roomMessageFlushTimer = null
  }
  roomMessageBuffer.length = 0
  roomMessageBufferScope = null
  dbPromise = null
  dbNameForPromise = null
}
