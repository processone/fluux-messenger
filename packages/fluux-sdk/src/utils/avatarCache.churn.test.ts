import { beforeEach, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { Blob } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  cacheAvatar, clearNoAvatar, markNoAvatar, hasNoAvatar, getCachedAvatar,
  _resetBlobUrlPoolForTesting, _resetDBForTesting,
} from './avatarCache'

// Intent: presence repeats an unchanged avatar hash on every status change in every room,
// so re-caching a stored avatar and clearing an absent negative entry must not take write
// locks or replace the blob URL that mounted avatars show.

let urls = 0
vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:t-${++urls}`)
const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})

const modes: string[] = []
const transaction = IDBDatabase.prototype.transaction
IDBDatabase.prototype.transaction = function (this: IDBDatabase, stores: never, mode?: IDBTransactionMode, options?: never) {
  modes.push(`${[].concat(stores).join(',')}:${mode ?? 'readonly'}`)
  return transaction.call(this, stores, mode, options)
} as typeof transaction

const bytes = 'avatar-image-bytes'
const hash = createHash('sha1').update(bytes).digest('hex')
const base64 = Buffer.from(bytes).toString('base64')

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  vi.stubGlobal('Blob', Blob)
  _resetDBForTesting()
  _resetBlobUrlPoolForTesting()
  revoke.mockClear()
})

it('returns the pooled URL for an avatar that is already stored, with no write and no revoke', async () => {
  const first = await cacheAvatar(hash, base64, 'image/png')
  modes.length = 0
  const again = await cacheAvatar(hash, base64, 'image/png')
  expect(again).toBe(first)
  expect(revoke).not.toHaveBeenCalled()
  expect(modes.filter(m => m.endsWith(':readwrite'))).toEqual([])
})

it('still stores bytes for a pooled hash whose stored row is gone', async () => {
  const first = await cacheAvatar(hash, base64, 'image/png')
  const db = await new Promise<IDBDatabase>((resolve) => {
    const open = indexedDB.open('fluux-avatar-cache'); open.onsuccess = () => resolve(open.result)
  })
  await new Promise<void>((resolve) => {
    const tx = db.transaction('avatars', 'readwrite'); tx.objectStore('avatars').clear(); tx.oncomplete = () => resolve()
  })
  db.close()
  const again = await cacheAvatar(hash, base64, 'image/png')
  expect(again).not.toBe(first)
  expect(await getCachedAvatar(hash)).toBe(again)
})

it('clearing a negative entry that is not stored takes no write lock, and clears one that is stored', async () => {
  await clearNoAvatar('nobody@example.test')
  expect(modes.filter(m => m.startsWith('no-avatar-jids') && m.endsWith(':readwrite'))).toEqual([])

  await markNoAvatar('someone@example.test', 'contact', 'definitive', undefined, hash)
  expect(await hasNoAvatar('someone@example.test')).toBe(true)
  modes.length = 0
  await clearNoAvatar('someone@example.test')
  expect(modes.filter(m => m.startsWith('no-avatar-jids') && m.endsWith(':readwrite'))).toHaveLength(1)
  expect(await hasNoAvatar('someone@example.test')).toBe(false)
})
