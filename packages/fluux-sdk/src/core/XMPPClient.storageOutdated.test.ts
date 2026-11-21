import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from './XMPPClient'
import { openIndexedDB } from '../utils/idbConnection'

vi.mock('@xmpp/client', () => ({ client: vi.fn(), xml: vi.fn() }))
vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))

function openFromNewerClient(name: string, version: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
}

async function cacheReleasedToNewerClient(name: string): Promise<void> {
  await openIndexedDB(name, 1, { upgrade: (db) => db.createObjectStore('rows'), onClosed: vi.fn() })
  await openFromNewerClient(name, 2)
}

describe('XMPPClient storage:outdated', () => {
  let client: XMPPClient

  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    client = new XMPPClient({ debug: false })
  })

  afterEach(() => {
    client.destroy()
  })

  it('reports a cache database a newer client upgraded', async () => {
    const handler = vi.fn()
    client.subscribe('storage:outdated', handler)

    await cacheReleasedToNewerClient('cache-a')

    expect(handler).toHaveBeenCalledExactlyOnceWith({ database: 'cache-a' })
  })

  it('reports each database once', async () => {
    const handler = vi.fn()
    client.subscribe('storage:outdated', handler)

    await cacheReleasedToNewerClient('cache-a')
    await openIndexedDB('cache-a', 2, { upgrade: vi.fn(), onClosed: vi.fn() })
    await openFromNewerClient('cache-a', 3)
    await cacheReleasedToNewerClient('cache-b')

    expect(handler.mock.calls).toEqual([[{ database: 'cache-a' }], [{ database: 'cache-b' }]])
  })

  it('stops reporting once destroyed', async () => {
    const handler = vi.fn()
    client.subscribe('storage:outdated', handler)
    client.destroy()

    await cacheReleasedToNewerClient('cache-a')

    expect(handler).not.toHaveBeenCalled()
  })
})
