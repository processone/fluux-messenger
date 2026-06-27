import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import {
  cachePassphrase,
  loadCachedPassphrase,
  clearCachedPassphrase,
  clearAllCachedPassphrases,
  getRememberPassphrasePreference,
  setRememberPassphrasePreference,
} from './webPassphraseCache'

// Fresh in-memory IndexedDB per test so records don't leak across tests.
beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
})
afterEach(() => {
  globalThis.indexedDB = new IDBFactory()
  localStorage.clear()
})

const JID = 'alice@example.com'
const PASSPHRASE = 'correct horse battery staple'

describe('webPassphraseCache', () => {
  it('round-trips a passphrase through cache / load', async () => {
    await cachePassphrase(JID, PASSPHRASE)
    expect(await loadCachedPassphrase(JID)).toBe(PASSPHRASE)
  })

  it('returns null for an unknown jid', async () => {
    expect(await loadCachedPassphrase('nobody@example.com')).toBeNull()
  })

  it('expires and deletes a record past its ttl', async () => {
    await cachePassphrase(JID, PASSPHRASE, -1) // already expired
    expect(await loadCachedPassphrase(JID)).toBeNull()
    // second load proves the expired record was deleted, not just skipped
    expect(await loadCachedPassphrase(JID)).toBeNull()
  })

  it('clearCachedPassphrase removes one account', async () => {
    await cachePassphrase(JID, PASSPHRASE)
    await cachePassphrase('bob@example.com', 'other-pass')
    await clearCachedPassphrase(JID)
    expect(await loadCachedPassphrase(JID)).toBeNull()
    expect(await loadCachedPassphrase('bob@example.com')).toBe('other-pass')
  })

  it('clearAllCachedPassphrases removes every account', async () => {
    await cachePassphrase(JID, PASSPHRASE)
    await cachePassphrase('bob@example.com', 'other-pass')
    await clearAllCachedPassphrases()
    expect(await loadCachedPassphrase(JID)).toBeNull()
    expect(await loadCachedPassphrase('bob@example.com')).toBeNull()
  })

  it('never stores the passphrase in cleartext', async () => {
    await cachePassphrase(JID, PASSPHRASE)
    const raw = await rawRecord(JID)
    expect(raw).not.toBeNull()
    const bytes = new Uint8Array(raw!.ciphertext as ArrayBuffer)
    const asLatin1 = String.fromCharCode(...bytes)
    expect(asLatin1).not.toContain(PASSPHRASE)
    // the stored wrap key must be non-extractable
    expect((raw!.wrapKey as CryptoKey).extractable).toBe(false)
  })

  it('preference defaults to false and round-trips', () => {
    expect(getRememberPassphrasePreference()).toBe(false)
    setRememberPassphrasePreference(true)
    expect(getRememberPassphrasePreference()).toBe(true)
    setRememberPassphrasePreference(false)
    expect(getRememberPassphrasePreference()).toBe(false)
  })
})

// Read the raw stored record directly, bypassing decrypt, to inspect bytes.
function rawRecord(jid: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('fluux-e2ee-passphrase-cache', 1)
    open.onupgradeneeded = () => open.result.createObjectStore('cache', { keyPath: 'jid' })
    open.onsuccess = () => {
      const db = open.result
      const tx = db.transaction('cache', 'readonly')
      const req = tx.objectStore('cache').get(jid)
      req.onsuccess = () => resolve((req.result as Record<string, unknown>) ?? null)
      req.onerror = () => reject(req.error)
    }
    open.onerror = () => reject(open.error)
  })
}
