import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message } from '../core/types'
import * as cache from './messageCache'
import { setStorageScopeJid } from './storageScope'
import { _clearRetractedIdentitiesForTesting } from './retractedIdentities'

const OWN = 'self@example.test'
const PEER = 'peer@example.test'
const DB = `fluux-message-cache:${OWN}`

function row(id: string): Message {
  return { type: 'chat', conversationId: PEER, id, stanzaId: `archive-${id}`, originId: undefined, from: PEER,
    isOutgoing: false, body: 'fixture', timestamp: new Date('2026-10-16T10:00:00Z') }
}

function currentVersion(): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB)
    request.onsuccess = () => {
      const { version } = request.result
      request.result.close()
      resolve(version)
    }
    request.onerror = () => reject(request.error)
  })
}

/** What a newer client does on start: open the database at a higher version. */
function upgradeFromAnotherTab(version: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, version)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

describe('message cache under another client upgrade', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    cache._resetDBForTesting()
    _clearRetractedIdentitiesForTesting()
    setStorageScopeJid(OWN)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('lets a newer client upgrade instead of blocking it', async () => {
    await cache.saveMessages([row('a')])
    const version = await currentVersion()

    const newer = await upgradeFromAnotherTab(version + 1)

    expect(newer.version).toBe(version + 1)
    newer.close()
    // The released connection is not reused; a read settles instead of hanging.
    await expect(cache.getMessages(PEER)).resolves.toEqual([])
  })

  it('reopens after another tab deletes the database', async () => {
    await cache.saveMessages([row('a')])
    const version = await currentVersion()
    // Another tab clearing local data deletes the database, which this
    // client's open connection must not block.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DB)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
    })

    expect(await cache.getMessages(PEER)).toEqual([])
    expect(await currentVersion()).toBe(version)
  })
})
