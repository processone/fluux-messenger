/**
 * IndexedDB-backed implementation of the SDK's {@link StorageBackend}
 * interface. Used on web (browser) where the Rust/native keychain is
 * unavailable and `InMemoryStorageBackend` would lose key material on
 * page reload.
 *
 * One database per account JID: `fluux-e2ee-<sanitizedJid>`. This
 * prevents cross-account key collision since `createPluginStorage`
 * namespaces keys by plugin ID only (not by JID).
 */

import type { StorageBackend } from '@fluux/sdk'

const DB_VERSION = 1
const STORE_NAME = 'kv'

function sanitizeJid(jid: string): string {
  return jid.replace(/[^a-zA-Z0-9@._-]/g, '_')
}

export class IndexedDBStorageBackend implements StorageBackend {
  private readonly dbName: string
  private db: IDBDatabase | null = null

  constructor(accountJid: string) {
    this.dbName = `fluux-e2ee-${sanitizeJid(accountJid)}`
  }

  async open(): Promise<void> {
    if (this.db) return
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(this.dbName, DB_VERSION)
      req.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME)
        }
      }
      req.onsuccess = (e) => resolve((e.target as IDBOpenDBRequest).result)
      req.onerror = () => reject(req.error)
    })
  }

  async get(key: string): Promise<Uint8Array | null> {
    const db = await this.requireDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(key)
      req.onsuccess = () => {
        const v = req.result as Uint8Array | undefined
        resolve(v ?? null)
      }
      req.onerror = () => reject(req.error)
    })
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    const db = await this.requireDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const req = tx.objectStore(STORE_NAME).put(value, key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  async delete(key: string): Promise<void> {
    const db = await this.requireDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      const req = tx.objectStore(STORE_NAME).delete(key)
      req.onsuccess = () => resolve()
      req.onerror = () => reject(req.error)
    })
  }

  async list(prefix: string): Promise<string[]> {
    const db = await this.requireDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAllKeys()
      req.onsuccess = () => {
        const keys = (req.result as IDBValidKey[])
          .filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))
        resolve(keys)
      }
      req.onerror = () => reject(req.error)
    })
  }

  private async requireDb(): Promise<IDBDatabase> {
    if (!this.db) await this.open()
    if (!this.db) throw new Error('IndexedDBStorageBackend: database not open')
    return this.db
  }
}
