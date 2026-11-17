/**
 * Optional 24h on-device cache for the web OpenPGP session passphrase.
 *
 * The passphrase is encrypted with a NON-EXTRACTABLE AES-GCM CryptoKey and
 * stored (with its IV, ciphertext, and a fixed expiry) in a dedicated
 * IndexedDB database, keyed per bare JID. The CryptoKey object persists via
 * structured clone, but its raw bytes cannot be read back by JS, so a passive
 * storage dump yields only ciphertext it cannot decrypt. A live-JS (XSS)
 * attacker on the page is NOT mitigated; the fixed expiry bounds exposure.
 *
 * Every operation is best-effort: failures are swallowed so the cache can
 * never block login or logout. The plaintext passphrase still lives only in
 * module memory (see webPassphraseStore.ts) once unlocked; this cache only
 * shortcuts re-entry across page reloads within the expiry window.
 *
 * Only the user's checkbox PREFERENCE (a boolean) is stored in localStorage,
 * never the passphrase.
 */

const DB_NAME = 'fluux-e2ee-passphrase-cache'
const STORE_NAME = 'cache'
const DB_VERSION = 1
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const REMEMBER_PREF_KEY = 'fluux:openpgp:remember-passphrase'

interface CacheRecord {
  jid: string
  wrapKey: CryptoKey
  iv: Uint8Array<ArrayBuffer>
  ciphertext: ArrayBuffer
  expiresAt: number
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'jid' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function readRecord(jid: string): Promise<CacheRecord | null> {
  const db = await openDb()
  try {
    return await new Promise<CacheRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(jid)
      req.onsuccess = () => resolve((req.result as CacheRecord | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function writeRecord(record: CacheRecord): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put(record)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function deleteRecord(jid: string): Promise<void> {
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(jid)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

/** Encrypt and cache the passphrase for `jid`, expiring `ttlMs` from now. */
export async function cachePassphrase(
  jid: string,
  passphrase: string,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<void> {
  try {
    const wrapKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false, // non-extractable
      ['encrypt', 'decrypt'],
    )
    const iv = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)))
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      wrapKey,
      new TextEncoder().encode(passphrase),
    )
    await writeRecord({ jid, wrapKey, iv, ciphertext, expiresAt: Date.now() + ttlMs })
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: cache failed', err)
  }
}

/** Load and decrypt the cached passphrase for `jid`, or null if absent/expired/invalid. */
export async function loadCachedPassphrase(jid: string): Promise<string | null> {
  try {
    const record = await readRecord(jid)
    if (!record) return null
    if (Date.now() > record.expiresAt) {
      await deleteRecord(jid)
      return null
    }
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv },
      record.wrapKey,
      record.ciphertext,
    )
    return new TextDecoder().decode(plain)
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: load failed', err)
    await deleteRecord(jid).catch(() => {})
    return null
  }
}

/** Remove the cached passphrase for one account. */
export async function clearCachedPassphrase(jid: string): Promise<void> {
  try {
    await deleteRecord(jid)
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: clear failed', err)
  }
}

/** Delete every cached passphrase whose expiry has passed (best-effort sweep). */
export async function sweepExpiredPassphrases(): Promise<void> {
  try {
    const db = await openDb()
    try {
      const now = Date.now()
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const req = tx.objectStore(STORE_NAME).openCursor()
        req.onsuccess = () => {
          const cursor = req.result
          if (!cursor) return
          const record = cursor.value as CacheRecord
          if (now > record.expiresAt) cursor.delete()
          cursor.continue()
        }
        req.onerror = () => reject(req.error)
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: sweep failed', err)
  }
}

/** Remove all cached passphrases (full local-data wipe). */
export async function clearAllCachedPassphrases(): Promise<void> {
  try {
    const db = await openDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        tx.objectStore(STORE_NAME).clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    } finally {
      db.close()
    }
  } catch (err) {
    console.warn('[Fluux] webPassphraseCache: clearAll failed', err)
  }
}

/** Whether the user last opted to remember the passphrase. Defaults to false. */
export function getRememberPassphrasePreference(): boolean {
  try {
    return localStorage.getItem(REMEMBER_PREF_KEY) === 'true'
  } catch {
    return false
  }
}

/** Persist the user's remember-passphrase checkbox choice (boolean only). */
export function setRememberPassphrasePreference(value: boolean): void {
  try {
    localStorage.setItem(REMEMBER_PREF_KEY, value ? 'true' : 'false')
  } catch {
    // ignore storage failures
  }
}
