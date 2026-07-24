/**
 * Avatar cache using IndexedDB for efficient binary storage
 * Avatars are stored by their SHA-1 hash (from XEP-0084)
 * JID → hash mappings are also stored to enable restoration on app restart
 */

import { getBareJid } from '../core/jid'

const DB_NAME = 'fluux-avatar-cache'
const DB_VERSION = 4
const STORE_NAME = 'avatars'
const HASH_STORE_NAME = 'avatar-hashes'
const NO_AVATAR_STORE_NAME = 'no-avatar-jids'
const PEP_FORBIDDEN_STORE_NAME = 'pep-forbidden-domains'

/**
 * Default TTL for "no avatar" cache entries (24 hours in milliseconds)
 * After this time, we'll re-check if the JID has an avatar
 */
const NO_AVATAR_TTL_MS = 24 * 60 * 60 * 1000

/**
 * Default TTL for PEP-forbidden domain cache entries (7 days in milliseconds).
 * Domains that return 'forbidden' or 'service-unavailable' for PEP avatar
 * requests are cached so we skip PEP and go directly to vCard-temp.
 */
const PEP_FORBIDDEN_TTL_MS = 7 * 24 * 60 * 60 * 1000

interface CachedAvatar {
  hash: string // SHA-1 hash (primary key)
  data: Blob // Image blob
  mimeType: string // e.g., "image/png"
  timestamp: number // When cached
}

export type AvatarEntityType = 'contact' | 'room' | 'occupant'

export interface AvatarHashMapping {
  jid: string // JID (primary key)
  hash: string // SHA-1 hash
  type: AvatarEntityType
}

export interface RoomOccupantAvatarHashMapping {
  occupantId: string
  hash: string
}

export type RoomOccupantAvatarHashesByRoom =
  Map<string, RoomOccupantAvatarHashMapping[]>

const OCCUPANT_HASH_KEY_PREFIX = 'muc-occupant:'

/**
 * XEP-0421 occupant identifiers are opaque and only stable within one room.
 * Encode both components so an identifier can never collide with a JID mapping
 * or with the same opaque value issued by another room.
 */
function occupantHashMappingKey(roomJid: string, occupantId: string): string {
  return `${OCCUPANT_HASH_KEY_PREFIX}${encodeURIComponent(getBareJid(roomJid))}:${encodeURIComponent(occupantId)}`
}

function parseOccupantHashMappingKey(
  key: string
): { roomJid: string; occupantId: string } | null {
  if (!key.startsWith(OCCUPANT_HASH_KEY_PREFIX)) return null
  const encoded = key.slice(OCCUPANT_HASH_KEY_PREFIX.length)
  const separator = encoded.indexOf(':')
  if (separator < 0) return null
  try {
    return {
      roomJid: decodeURIComponent(encoded.slice(0, separator)),
      occupantId: decodeURIComponent(encoded.slice(separator + 1)),
    }
  } catch {
    return null
  }
}

/**
 * Entry tracking a JID that has been confirmed to have no avatar
 * Used to prevent repeated queries for JIDs without avatars
 */
interface NoAvatarEntry {
  jid: string // JID (primary key)
  timestamp: number // When this was recorded
  type: AvatarEntityType // 'contact' or 'room'
}

/**
 * Entry tracking a domain whose server blocks PEP avatar access.
 * Used to skip PEP requests and go directly to vCard-temp.
 */
interface PepForbiddenDomainEntry {
  domain: string // Domain (primary key)
  timestamp: number // When this was recorded
}

let dbPromise: Promise<IDBDatabase> | null = null

/**
 * In-memory pool of active blob URLs, keyed by avatar hash.
 * Ensures deduplication (same hash = same blob URL) and enables
 * proper cleanup via URL.revokeObjectURL().
 */
const blobUrlPool = new Map<string, string>()

/**
 * Lazily shared snapshot of durable XEP-0421 bindings.
 *
 * Room joins complete independently, so each `mucJoined` callback asks for one
 * room. Sharing the grouped snapshot here turns an autojoin burst into one
 * IndexedDB read without coupling the cache layer to join ordering. Successful
 * writes update the loaded snapshot below; clearing avatar data drops it.
 */
let occupantMappingsByRoomPromise:
  Promise<RoomOccupantAvatarHashesByRoom> | null = null

/**
 * In-memory set of domains known to block PEP avatar access.
 * Populated from IndexedDB on load, updated on new forbidden responses.
 * Enables synchronous checks to skip PEP requests entirely.
 */
const pepForbiddenDomains = new Set<string>()

/**
 * Check if IndexedDB is available in the current environment
 */
function isIndexedDBAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

/**
 * Get or initialize the IndexedDB database
 */
function getDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise

  // Silently fail in environments without IndexedDB (e.g., tests)
  if (!isIndexedDBAvailable()) {
    return Promise.reject(new Error('IndexedDB not available'))
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      reject(request.error)
    }

    request.onsuccess = () => {
      resolve(request.result)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result
      // Avatar blob store (v1)
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'hash' })
      }
      // JID → hash mapping store (v2)
      if (!db.objectStoreNames.contains(HASH_STORE_NAME)) {
        const hashStore = db.createObjectStore(HASH_STORE_NAME, { keyPath: 'jid' })
        hashStore.createIndex('type', 'type', { unique: false })
      }
      // No-avatar JIDs store (v3) - negative cache
      if (!db.objectStoreNames.contains(NO_AVATAR_STORE_NAME)) {
        const noAvatarStore = db.createObjectStore(NO_AVATAR_STORE_NAME, { keyPath: 'jid' })
        noAvatarStore.createIndex('type', 'type', { unique: false })
      }
      // PEP-forbidden domains store (v4) - domain-level negative cache
      if (!db.objectStoreNames.contains(PEP_FORBIDDEN_STORE_NAME)) {
        db.createObjectStore(PEP_FORBIDDEN_STORE_NAME, { keyPath: 'domain' })
      }
    }
  })

  return dbPromise
}

/**
 * Get a cached avatar by hash
 * @returns Blob URL if cached, null otherwise
 */
export async function getCachedAvatar(hash: string): Promise<string | null> {
  // Return existing blob URL if already created for this hash
  const existing = blobUrlPool.get(hash)
  if (existing) return existing

  try {
    const db = await getDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.get(hash)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const result = request.result as CachedAvatar | undefined
        if (result) {
          const url = URL.createObjectURL(result.data)
          blobUrlPool.set(hash, url)
          resolve(url)
        } else {
          resolve(null)
        }
      }
    })
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get cached avatar:', error)
    }
    return null
  }
}

/**
 * Cache an avatar
 * @param hash - SHA-1 hash of the avatar
 * @param base64 - Base64-encoded image data
 * @param mimeType - MIME type (e.g., "image/png")
 * @returns Blob URL for immediate use
 */
export async function cacheAvatar(
  hash: string,
  base64: string,
  mimeType: string
): Promise<string> {
  // Revoke any existing blob URL for this hash before creating a new one
  const existingUrl = blobUrlPool.get(hash)
  if (existingUrl) {
    URL.revokeObjectURL(existingUrl)
    blobUrlPool.delete(hash)
  }

  // Convert base64 to blob
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  const blob = new Blob([bytes], { type: mimeType })

  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const avatar: CachedAvatar = {
        hash,
        data: blob,
        mimeType,
        timestamp: Date.now(),
      }
      const request = store.put(avatar)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to cache avatar:', error)
    }
  }

  // Create blob URL, track in pool, and return
  const url = URL.createObjectURL(blob)
  blobUrlPool.set(hash, url)
  return url
}

/**
 * Clear all cached avatars
 */
export async function clearAllAvatars(): Promise<void> {
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite')
      const store = transaction.objectStore(STORE_NAME)
      const request = store.clear()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to clear avatar cache:', error)
    }
  }
}

// =============================================================================
// Avatar Hash Mapping Functions (JID → hash)
// =============================================================================

/**
 * Save a JID → hash mapping for avatar restoration
 */
export async function saveAvatarHash(
  jid: string,
  hash: string,
  type: AvatarEntityType
): Promise<void> {
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(HASH_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(HASH_STORE_NAME)
      const mapping: AvatarHashMapping = { jid, hash, type }
      const request = store.put(mapping)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })

    if (type === 'occupant' && occupantMappingsByRoomPromise) {
      const parsed = parseOccupantHashMappingKey(jid)
      if (parsed) {
        const byRoom = await occupantMappingsByRoomPromise
        const roomMappings = byRoom.get(parsed.roomJid)
        const entry = { occupantId: parsed.occupantId, hash }
        if (!roomMappings) {
          byRoom.set(parsed.roomJid, [entry])
        } else {
          const existingIndex = roomMappings.findIndex(
            (mapping) => mapping.occupantId === parsed.occupantId
          )
          if (existingIndex >= 0) {
            roomMappings[existingIndex] = entry
          } else {
            roomMappings.push(entry)
          }
        }
      }
    }
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to save avatar hash mapping:', error)
    }
  }
}

/**
 * Get the avatar hash for a JID
 */
export async function getAvatarHash(jid: string): Promise<string | null> {
  try {
    const db = await getDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(HASH_STORE_NAME, 'readonly')
      const store = transaction.objectStore(HASH_STORE_NAME)
      const request = store.get(jid)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const result = request.result as AvatarHashMapping | undefined
        resolve(result?.hash ?? null)
      }
    })
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get avatar hash:', error)
    }
    return null
  }
}

/**
 * Get all avatar hash mappings, optionally filtered by type
 */
export async function getAllAvatarHashes(
  type?: AvatarEntityType
): Promise<AvatarHashMapping[]> {
  try {
    const db = await getDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(HASH_STORE_NAME, 'readonly')
      const store = transaction.objectStore(HASH_STORE_NAME)

      let request: IDBRequest
      if (type) {
        const index = store.index('type')
        request = index.getAll(type)
      } else {
        request = store.getAll()
      }

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        resolve(request.result as AvatarHashMapping[])
      }
    })
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to get avatar hash mappings:', error)
    }
    return []
  }
}

/**
 * Persist the avatar hash advertised for one XEP-0421 identity.
 *
 * This deliberately stores a room-scoped opaque key rather than treating the
 * occupant-id as a JID. The avatar blob itself remains globally deduplicated by
 * hash in the avatars store.
 */
export async function saveRoomOccupantAvatarHash(
  roomJid: string,
  occupantId: string,
  hash: string
): Promise<void> {
  await saveAvatarHash(
    occupantHashMappingKey(roomJid, occupantId),
    hash,
    'occupant'
  )
}

/** Return every persisted occupant-id→hash binding for one room. */
export async function getRoomOccupantAvatarHashes(
  roomJid: string
): Promise<RoomOccupantAvatarHashMapping[]> {
  if (!occupantMappingsByRoomPromise) {
    occupantMappingsByRoomPromise = getAllAvatarHashes('occupant')
      .then(groupRoomOccupantAvatarHashes)
  }
  const mappingsByRoom = await occupantMappingsByRoomPromise
  return [...(mappingsByRoom.get(getBareJid(roomJid)) ?? [])]
}

/**
 * Group persisted XEP-0421 avatar aliases from one hash-store read.
 *
 * Blob URL refresh runs across every joined room, so grouping once avoids one
 * full IndexedDB index read and one full scan per room.
 */
export function groupRoomOccupantAvatarHashes(
  mappings: readonly AvatarHashMapping[]
): RoomOccupantAvatarHashesByRoom {
  const byRoom: RoomOccupantAvatarHashesByRoom = new Map()
  for (const mapping of mappings) {
    if (mapping.type !== 'occupant') continue
    const parsed = parseOccupantHashMappingKey(mapping.jid)
    if (!parsed) continue
    const roomMappings = byRoom.get(parsed.roomJid)
    const entry = { occupantId: parsed.occupantId, hash: mapping.hash }
    if (roomMappings) {
      roomMappings.push(entry)
    } else {
      byRoom.set(parsed.roomJid, [entry])
    }
  }
  return byRoom
}

/**
 * Clear all avatar hash mappings
 */
export async function clearAllAvatarHashes(): Promise<void> {
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(HASH_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(HASH_STORE_NAME)
      const request = store.clear()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
    occupantMappingsByRoomPromise = null
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to clear avatar hash mappings:', error)
    }
  }
}

// =============================================================================
// No-Avatar Negative Cache Functions
// =============================================================================

/**
 * Check if a JID is known to have no avatar (negative cache)
 * Returns true if the JID was recently checked and found to have no avatar
 *
 * @param jid - The JID to check
 * @param ttlMs - Time-to-live in milliseconds (default: 24 hours)
 */
export async function hasNoAvatar(jid: string, ttlMs: number = NO_AVATAR_TTL_MS): Promise<boolean> {
  try {
    const db = await getDB()
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(NO_AVATAR_STORE_NAME, 'readonly')
      const store = transaction.objectStore(NO_AVATAR_STORE_NAME)
      const request = store.get(jid)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const result = request.result as NoAvatarEntry | undefined
        if (!result) {
          resolve(false)
          return
        }
        // Check if the entry is still valid (not expired)
        const age = Date.now() - result.timestamp
        if (age > ttlMs) {
          // Entry expired, delete it and return false
          const deleteTransaction = db.transaction(NO_AVATAR_STORE_NAME, 'readwrite')
          deleteTransaction.objectStore(NO_AVATAR_STORE_NAME).delete(jid)
          resolve(false)
        } else {
          resolve(true)
        }
      }
    })
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to check no-avatar cache:', error)
    }
    return false
  }
}

/**
 * Mark a JID as having no avatar (negative cache)
 * This prevents repeated queries for JIDs without avatars
 *
 * @param jid - The JID that has no avatar
 * @param type - Whether this is a 'contact' or 'room'
 */
export async function markNoAvatar(jid: string, type: AvatarEntityType): Promise<void> {
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(NO_AVATAR_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(NO_AVATAR_STORE_NAME)
      const entry: NoAvatarEntry = {
        jid,
        timestamp: Date.now(),
        type,
      }
      const request = store.put(entry)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to mark JID as no-avatar:', error)
    }
  }
}

/**
 * Remove a JID from the no-avatar cache
 * Call this when we discover the JID now has an avatar
 *
 * @param jid - The JID to remove from the cache
 */
export async function clearNoAvatar(jid: string): Promise<void> {
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(NO_AVATAR_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(NO_AVATAR_STORE_NAME)
      const request = store.delete(jid)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (error) {
    // Only log if IndexedDB is available (skip in test environments)
    if (isIndexedDBAvailable()) {
      console.warn('Failed to clear no-avatar entry:', error)
    }
  }
}

/**
 * Clear all no-avatar entries
 */
export async function clearAllNoAvatarEntries(): Promise<void> {
  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(NO_AVATAR_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(NO_AVATAR_STORE_NAME)
      const request = store.clear()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to clear no-avatar entries:', error)
    }
  }
}

// =============================================================================
// PEP-Forbidden Domain Cache Functions
// =============================================================================

/**
 * Check if a domain is known to block PEP avatar access (synchronous).
 * Returns true if the domain previously returned 'forbidden' or
 * 'service-unavailable' for PEP avatar requests.
 */
export function isPepForbiddenDomain(domain: string): boolean {
  return pepForbiddenDomains.has(domain)
}

/**
 * Mark a domain as blocking PEP avatar access.
 * Adds to in-memory Set and persists to IndexedDB.
 */
export async function markPepForbiddenDomain(domain: string): Promise<void> {
  pepForbiddenDomains.add(domain)

  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(PEP_FORBIDDEN_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(PEP_FORBIDDEN_STORE_NAME)
      const entry: PepForbiddenDomainEntry = {
        domain,
        timestamp: Date.now(),
      }
      const request = store.put(entry)

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to persist PEP-forbidden domain:', error)
    }
  }
}

/**
 * Load PEP-forbidden domains from IndexedDB into the in-memory Set.
 * Expired entries (older than TTL) are removed during load.
 * Call once at startup before avatar fetches begin.
 */
export async function loadPepForbiddenDomains(ttlMs: number = PEP_FORBIDDEN_TTL_MS): Promise<void> {
  try {
    const db = await getDB()
    const transaction = db.transaction(PEP_FORBIDDEN_STORE_NAME, 'readwrite')
    const store = transaction.objectStore(PEP_FORBIDDEN_STORE_NAME)
    const entries: PepForbiddenDomainEntry[] = await new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result as PepForbiddenDomainEntry[])
    })

    const cutoff = Date.now() - ttlMs
    for (const entry of entries) {
      if (entry.timestamp < cutoff) {
        // Expired — remove from IndexedDB
        store.delete(entry.domain)
      } else {
        pepForbiddenDomains.add(entry.domain)
      }
    }
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to load PEP-forbidden domains:', error)
    }
  }
}

/**
 * Clear all PEP-forbidden domain entries (in-memory and IndexedDB).
 */
export async function clearAllPepForbiddenDomains(): Promise<void> {
  pepForbiddenDomains.clear()

  try {
    const db = await getDB()
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(PEP_FORBIDDEN_STORE_NAME, 'readwrite')
      const store = transaction.objectStore(PEP_FORBIDDEN_STORE_NAME)
      const request = store.clear()

      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve()
    })
  } catch (error) {
    if (isIndexedDBAvailable()) {
      console.warn('Failed to clear PEP-forbidden domains:', error)
    }
  }
}

/**
 * Revoke all tracked avatar blob URLs.
 * Call on disconnect or when clearing all avatar data.
 */
export function revokeAllBlobUrls(): void {
  for (const url of blobUrlPool.values()) {
    URL.revokeObjectURL(url)
  }
  blobUrlPool.clear()
}

/**
 * Refresh all avatar blob URLs by re-creating them from IndexedDB.
 * Call after events that invalidate blob URLs (e.g., WebKit reclaiming
 * memory during sleep). Returns a map of hash → fresh blob URL.
 */
export async function refreshAllBlobUrls(): Promise<Map<string, string>> {
  // Revoke the existing blob URLs before recreating them. On a real OS
  // sleep-wake WebKit may already have reclaimed them, but on an ordinary SM
  // resumption (a network blip) they are still live — clearing without revoking
  // would orphan them and leak decoded-image memory on every resumption.
  revokeAllBlobUrls()

  const freshUrls = new Map<string, string>()
  try {
    const db = await getDB()
    const transaction = db.transaction(STORE_NAME, 'readonly')
    const store = transaction.objectStore(STORE_NAME)
    const allAvatars: CachedAvatar[] = await new Promise((resolve, reject) => {
      const request = store.getAll()
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result as CachedAvatar[])
    })

    for (const avatar of allAvatars) {
      const url = URL.createObjectURL(avatar.data)
      blobUrlPool.set(avatar.hash, url)
      freshUrls.set(avatar.hash, url)
    }
  } catch {
    // Silently fail — avatars will show fallback initials
  }
  return freshUrls
}

/**
 * Reset the blob URL pool without revoking URLs.
 * For test isolation only.
 */
export function _resetBlobUrlPoolForTesting(): void {
  blobUrlPool.clear()
}

/**
 * Diagnostic counter of SM resumptions that triggered an avatar blob-URL refresh.
 * Lets the opt-in memory probe correlate blob-pool growth against resume count —
 * a flat pool size across many resumes confirms the SM-resume leak class is gone.
 */
let avatarResumeCount = 0

/** Current number of live avatar blob URLs. Diagnostic only. */
export function getBlobUrlPoolSize(): number {
  return blobUrlPool.size
}

/** Record one SM resumption that triggered a blob-URL refresh. Diagnostic only. */
export function bumpAvatarResumeCount(): void {
  avatarResumeCount++
}

/** Number of SM resumptions seen this session. Diagnostic only. */
export function getAvatarResumeCount(): number {
  return avatarResumeCount
}

/**
 * Reset the PEP-forbidden domains set.
 * For test isolation only.
 * @internal
 */
export function _resetPepForbiddenDomainsForTesting(): void {
  pepForbiddenDomains.clear()
}

/**
 * Reset the database instance.
 * For test isolation only.
 * @internal
 */
export function _resetDBForTesting(): void {
  dbPromise = null
  occupantMappingsByRoomPromise = null
}

/**
 * Clear all avatar data (blobs, hash mappings, and no-avatar entries)
 */
export async function clearAllAvatarData(): Promise<void> {
  revokeAllBlobUrls()
  await Promise.all([
    clearAllAvatars(),
    clearAllAvatarHashes(),
    clearAllNoAvatarEntries(),
    clearAllPepForbiddenDomains(),
  ])
}
