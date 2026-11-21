import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openIndexedDB, StorageBlockedError } from './idbConnection'

/** A connection from a client that predates versionchange handling. */
function openUnguarded(name: string, version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onupgradeneeded = () => request.result.createObjectStore(`v${version}`)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function storeNames(db: IDBDatabase): string[] {
  return [...db.objectStoreNames].sort()
}

function eventually(check: () => void): Promise<void> {
  return vi.waitFor(check, { timeout: 1000, interval: 5 })
}

describe('openIndexedDB', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('releases its connection when a newer client upgrades the database', async () => {
    const onClosed = vi.fn()
    const older = await openIndexedDB('db', 1, {
      upgrade: (db) => db.createObjectStore('v1'),
      onClosed,
    })

    const newer = await openUnguarded('db', 2)

    expect(storeNames(newer)).toEqual(['v1', 'v2'])
    expect(onClosed).toHaveBeenCalledOnce()
    expect(() => older.transaction('v1')).toThrow()
    newer.close()
  })

  it('gives up on an open that another connection keeps blocked', async () => {
    const holder = await openUnguarded('db', 1)

    await expect(openIndexedDB('db', 2, {
      upgrade: (db) => db.createObjectStore('v2'),
      onClosed: vi.fn(),
      blockedTimeoutMs: 20,
    })).rejects.toBeInstanceOf(StorageBlockedError)
    holder.close()
  })

  it('never upgrades the database for an open it gave up on', async () => {
    const holder = await openUnguarded('db', 1)
    const upgrade = vi.fn()
    await expect(openIndexedDB('db', 2, { upgrade, onClosed: vi.fn(), blockedTimeoutMs: 20 }))
      .rejects.toBeInstanceOf(StorageBlockedError)

    holder.close()

    await eventually(async () => {
      const reopened = await openUnguarded('db', 1)
      const version = reopened.version
      reopened.close()
      expect(version).toBe(1)
    })
    expect(upgrade).not.toHaveBeenCalled()
  })

  it('closes a connection that arrives after the open was given up', async () => {
    const holder = await openUnguarded('db', 1)
    const close = vi.spyOn(Object.getPrototypeOf(holder) as IDBDatabase, 'close')
    // Queued behind an upgrade that the holder blocks, and needing none itself.
    const upgrading = openUnguarded('db', 2)
    const upgrade = vi.fn()
    await expect(openIndexedDB('db', 2, { upgrade, onClosed: vi.fn(), blockedTimeoutMs: 20 }))
      .rejects.toBeInstanceOf(StorageBlockedError)

    holder.close()
    const upgraded = await upgrading
    await eventually(() => expect(close).toHaveBeenCalledTimes(2))
    expect(upgrade).not.toHaveBeenCalled()
    upgraded.close()
  })

  it('gives up on an open queued behind another client upgrade', async () => {
    const holder = await openUnguarded('db', 1)
    const upgrading = openUnguarded('db', 2)
    await expect(openIndexedDB('db', 2, { upgrade: vi.fn(), onClosed: vi.fn(), blockedTimeoutMs: 20 }))
      .rejects.toBeInstanceOf(StorageBlockedError)
    holder.close()
    ;(await upgrading).close()
  })

  it('does not time out while an upgrade runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const db = await openIndexedDB('db', 1, {
        upgrade: (d) => {
          const request = d.createObjectStore('v1').put('value', 'key')
          // The deadline passes while the version-change transaction is still running.
          request.onsuccess = () => vi.advanceTimersByTime(60_000)
        },
        onClosed: vi.fn(),
        blockedTimeoutMs: 20,
      })
      expect(storeNames(db)).toEqual(['v1'])
      db.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets a later open succeed once the blocking connection is gone', async () => {
    const holder = await openUnguarded('db', 1)
    await expect(openIndexedDB('db', 2, { upgrade: vi.fn(), onClosed: vi.fn(), blockedTimeoutMs: 20 }))
      .rejects.toBeInstanceOf(StorageBlockedError)
    holder.close()

    const db = await openIndexedDB('db', 2, { upgrade: (d) => d.createObjectStore('v2'), onClosed: vi.fn() })
    expect(storeNames(db)).toEqual(['v1', 'v2'])
    db.close()
  })
})
