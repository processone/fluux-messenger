import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'

// Must import after fake-indexeddb/auto
import { markNoAvatar, _resetDBForTesting } from './avatarCache'

const DB_NAME = 'fluux-avatar-cache'
const JID = 'nobody@example.test'

async function indexNames(): Promise<Record<string, string[]>> {
  const db = await openDB(DB_NAME)
  try {
    const tx = db.transaction(['avatar-hashes', 'no-avatar-jids'])
    return {
      'avatar-hashes': [...tx.objectStore('avatar-hashes').indexNames],
      'no-avatar-jids': [...tx.objectStore('no-avatar-jids').indexNames],
    }
  } finally { db.close() }
}

// The negative cache is only ever read by JID, so a `type` index on it costs a
// write per entry and serves nothing. The hash store's `type` index stays: the
// room-occupant restore reads it.
const expected = { 'avatar-hashes': ['type'], 'no-avatar-jids': [] }

describe('avatar cache schema', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    _resetDBForTesting()
  })

  it('drops the unused type index from an existing negative cache, keeping its entries', async () => {
    const legacy = await openDB(DB_NAME, 4, {
      upgrade(db) {
        db.createObjectStore('avatars', { keyPath: 'hash' })
        db.createObjectStore('avatar-hashes', { keyPath: 'jid' }).createIndex('type', 'type')
        db.createObjectStore('no-avatar-jids', { keyPath: 'jid' }).createIndex('type', 'type')
        db.createObjectStore('pep-forbidden-domains', { keyPath: 'domain' })
      },
    })
    await legacy.put('no-avatar-jids', { jid: JID, timestamp: Date.now(), type: 'contact' })
    legacy.close()

    await markNoAvatar('other@example.test', 'contact', 'definitive')

    expect(await indexNames()).toEqual(expected)
    const db = await openDB(DB_NAME)
    try {
      expect(await db.get('no-avatar-jids', JID)).toMatchObject({ jid: JID, type: 'contact' })
    } finally { db.close() }
  })

  it('creates no type index on a fresh negative cache', async () => {
    await markNoAvatar(JID, 'contact', 'definitive')
    expect(await indexNames()).toEqual(expected)
  })
})
