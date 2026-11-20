import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB, deleteDB } from 'idb'

// Must import after fake-indexeddb/auto
import { markNoAvatar, _resetDBForTesting } from './avatarCache'

const JID = 'nobody@example.test'
const NO_AVATAR_STORE = 'no-avatar-jids'

describe('avatar cache open failure', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    _resetDBForTesting()
  })

  it('retries the open after a failed one instead of staying disabled', async () => {
    // A newer schema left by another build makes the open fail with VersionError.
    const newer = await openDB('fluux-avatar-cache', 99)
    newer.close()
    await markNoAvatar(JID, 'contact', 'definitive').catch(() => {})

    await deleteDB('fluux-avatar-cache')
    await markNoAvatar(JID, 'contact', 'definitive')

    // Read the database itself: the in-memory retry map would answer otherwise.
    const db = await openDB('fluux-avatar-cache')
    try {
      expect(await db.get(NO_AVATAR_STORE, JID)).toMatchObject({ jid: JID })
    } finally { db.close() }
  })
})
