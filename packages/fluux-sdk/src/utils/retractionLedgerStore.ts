/**
 * The IndexedDB carrier of the verified-retraction ledger
 * (`retractedIdentities.ts`): one scoped database per account, one store, no
 * indexes. The ledger is read whole when the account's cache opens and answered
 * from memory; this database only has to outlive a restart.
 *
 * Deliberately not a store inside `fluux-message-cache`: a version change there
 * re-walks every cached row.
 *
 * @module Utils/RetractionLedgerStore
 */

import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { VerifiedRetraction } from './retractedIdentities'

const DB_NAME = 'fluux-retraction-ledger'
const DB_VERSION = 1
const STORE = 'retractions'

interface RetractionLedgerSchema extends DBSchema {
  [STORE]: {
    key: string
    value: VerifiedRetraction
  }
}

let dbPromise: Promise<IDBPDatabase<RetractionLedgerSchema>> | null = null
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

function getDB(scopeJid: string | null): Promise<IDBPDatabase<RetractionLedgerSchema>> {
  if (!isIndexedDBAvailable()) {
    return Promise.reject(new Error('IndexedDB not available'))
  }
  const targetDbName = getScopedDbName(scopeJid)
  if (dbPromise && dbNameForPromise === targetDbName) return dbPromise

  if (dbPromise && dbNameForPromise && dbNameForPromise !== targetDbName) {
    const previousPromise = dbPromise
    dbPromise = null
    dbNameForPromise = null
    void previousPromise.then((db) => db.close()).catch(() => {})
  }

  dbNameForPromise = targetDbName
  const opening = openDB<RetractionLedgerSchema>(targetDbName, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' })
    },
  })
  dbPromise = opening
  void opening.catch(() => {
    // A failed open must be retryable, and must not invalidate a connection
    // opened for another account meanwhile.
    if (dbPromise === opening) {
      dbPromise = null
      dbNameForPromise = null
    }
  })
  return opening
}

/** Every stored record of the account; none when IndexedDB is unavailable. */
export async function loadRetractions(scopeJid: string | null): Promise<VerifiedRetraction[]> {
  if (!isIndexedDBAvailable()) return []
  const db = await getDB(scopeJid)
  return db.getAll(STORE)
}

/** Apply the puts and the deletes in one transaction. */
export async function persistRetractions(
  scopeJid: string | null,
  puts: readonly VerifiedRetraction[],
  deletes: readonly string[]
): Promise<void> {
  if (!isIndexedDBAvailable() || (puts.length === 0 && deletes.length === 0)) return
  const db = await getDB(scopeJid)
  const tx = db.transaction(STORE, 'readwrite')
  await Promise.all([
    ...puts.map((record) => tx.store.put(record)),
    ...deletes.map((key) => tx.store.delete(key)),
  ])
  await tx.done
}

/** Drop every stored record of the account. */
export async function clearRetractions(scopeJid: string | null): Promise<void> {
  if (!isIndexedDBAvailable()) return
  const db = await getDB(scopeJid)
  await db.clear(STORE)
}

/** @internal Drop the connection so the next call opens the current IndexedDB. */
export function _resetRetractionLedgerStoreForTesting(): void {
  dbPromise = null
  dbNameForPromise = null
}
