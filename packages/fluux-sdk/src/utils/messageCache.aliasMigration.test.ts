import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB } from 'idb'
import * as cache from './messageCache'
import * as searchIndex from './searchIndex'
import { CHAT_SCOPE, correctionReferenceKeys, identityKeys, roomScope } from './messageIdentity'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import { _clearRetractedIdentitiesForTesting } from './retractedIdentities'
import { retractUnresidentChatTarget, retractUnresidentRoomTarget } from '../stores/shared/retractionStorage'
import { cacheMigrationStore } from '../stores/cacheMigrationStore'

const DB_NAME = 'fluux-message-cache'
const CHAT = 'peer@example.test'
const ROOM = 'room@conference.example.test'
const CHAT_STORE = 'messages-canonical'
const ROOM_STORE = 'room-messages-canonical'

function fixtures() {
  const common = { id: 'original', stanzaId: 'original-archive', body: 'saved current correction', originalBody: 'original text', timestamp: 1000, isOutgoing: false, isEdited: true, correctionStanzaIds: ['older-alias', 'current-alias'], reactions: { ok: ['peer'] }, ids: ['original', 'old-client-id'] }
  const chat: cache.StoredMessage = { ...common, type: 'chat', conversationId: CHAT, from: CHAT, cacheKey: 'preserved-chat-key', identityKeys: [] }
  const room: cache.StoredRoomMessage = { ...common, type: 'groupchat', roomJid: ROOM, from: `${ROOM}/Peer`, nick: 'Peer', occupantId: 'peer-occupant', cacheKey: 'preserved-room-key', identityKeys: [] }
  chat.identityKeys = identityKeys(CHAT_SCOPE, chat)
  room.identityKeys = identityKeys(roomScope(ROOM), room)
  return { chat, room }
}

async function seedV5() {
  const rows = fixtures()
  const db = await openDB(DB_NAME, 5, {
    upgrade(database) {
      const chat = database.createObjectStore(CHAT_STORE, { keyPath: 'cacheKey' })
      chat.createIndex('conversationId', 'conversationId')
      chat.createIndex('identityKeys', 'identityKeys', { multiEntry: true })
      chat.createIndex('ids', 'ids', { multiEntry: true })
      chat.createIndex('timestamp', 'timestamp')
      chat.createIndex('conv_timestamp', ['conversationId', 'timestamp'])
      chat.createIndex('encryptedPayload', 'encryptedPayload')
      const room = database.createObjectStore(ROOM_STORE, { keyPath: 'cacheKey' })
      room.createIndex('roomJid', 'roomJid')
      room.createIndex('identityKeys', 'identityKeys', { multiEntry: true })
      room.createIndex('ids', 'ids', { multiEntry: true })
      room.createIndex('timestamp', 'timestamp')
      room.createIndex('room_timestamp', ['roomJid', 'timestamp'])
      room.createIndex('room_ts_from_id', ['roomJid', 'timestamp', 'from', 'id'])
    },
  })
  const tx = db.transaction([CHAT_STORE, ROOM_STORE], 'readwrite')
  await tx.objectStore(CHAT_STORE).put(rows.chat)
  await tx.objectStore(ROOM_STORE).put(rows.room)
  await tx.done
  db.close()
  return rows
}

async function seedManyV5(chatCount: number, roomCount: number) {
  const base = await seedV5()
  function rows<T extends cache.StoredMessage | cache.StoredRoomMessage>(template: T, count: number): T[] {
    return Array.from({ length: count }, (_, i) => {
      const id = `message-${String(i).padStart(4, '0')}`
      const row = {
        ...template, id, stanzaId: `archive-${id}`, cacheKey: `preserved-${id}`,
        ids: [id, `absorbed-${id}`], timestamp: 1000 + i,
        correctionStanzaIds: i % 3 === 0 ? [] : [`correction-${id}`],
      }
      const scope = row.type === 'chat' ? CHAT_SCOPE : roomScope((row as cache.StoredRoomMessage).roomJid)
      row.identityKeys = identityKeys(scope, row)
      // Include already-indexed corrections as well as rows needing backfill.
      if (i % 3 === 1) row.identityKeys.push(...correctionReferenceKeys(scope, row))
      return row
    })
  }
  const chat = rows(base.chat, chatCount)
  const room = rows(base.room, roomCount)
  const db = await openDB(DB_NAME)
  const tx = db.transaction([CHAT_STORE, ROOM_STORE], 'readwrite')
  await tx.objectStore(CHAT_STORE).clear()
  await tx.objectStore(ROOM_STORE).clear()
  await Promise.all([
    ...chat.map(row => tx.objectStore(CHAT_STORE).put(row)),
    ...room.map(row => tx.objectStore(ROOM_STORE).put(row)),
  ])
  await tx.done
  db.close()
  return { chat, room }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  searchIndex._resetDBForTesting()
  _resetStorageScopeForTesting()
  _clearRetractedIdentitiesForTesting()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await searchIndex.closeSearchIndex()
  cache._resetDBForTesting()
})

describe('version-5 correction alias migration', () => {
  it('backfills a large archive with bounded reads and preserves rows across batch boundaries', async () => {
    const original = await seedManyV5(513, 512)
    let readRequests = 0
    const batchLengths: number[] = []
    const writes: string[] = []
    const openCursor = IDBObjectStore.prototype.openCursor
    vi.spyOn(IDBObjectStore.prototype, 'openCursor').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = openCursor.apply(this, args)
      if (this.transaction.mode === 'versionchange') {
        // Observe cursor results without replacing continue(): idb recognizes it by identity.
        request.addEventListener('success', () => { readRequests++ })
      }
      return request
    })
    const getAll = IDBObjectStore.prototype.getAll
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
      const request = getAll.apply(this, args)
      if (this.transaction.mode === 'versionchange') {
        expect(args[1]).toBeGreaterThan(0)
        expect(args[1]).toBeLessThanOrEqual(256)
        readRequests++
        request.addEventListener('success', () => { batchLengths.push(request.result.length) })
      }
      return request
    })
    const put = IDBObjectStore.prototype.put
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.transaction.mode === 'versionchange') writes.push(`${this.name}:${value.cacheKey}`)
      return put.call(this, value, key)
    })

    await cache.getMessages(CHAT)
    const db = await openDB(DB_NAME)
    expect(db.version).toBe(6)
    const expectedWrites: string[] = []
    for (const [name, rows, scope] of [[CHAT_STORE, original.chat, CHAT_SCOPE], [ROOM_STORE, original.room, roomScope(ROOM)]] as const) {
      const expected = rows.map(row => {
        const aliases = correctionReferenceKeys(scope, row)
        if (!aliases.some(key => !row.identityKeys.includes(key))) return row
        expectedWrites.push(`${name}:${row.cacheKey}`)
        return { ...row, identityKeys: [...new Set([...row.identityKeys, ...aliases])].sort() }
      })
      expect(await db.getAll(name)).toEqual(expected)
      // A correction beyond the first page must be findable through its index.
      const alias = correctionReferenceKeys(scope, rows[257])[0]
      expect(await db.getAllFromIndex(name, 'identityKeys', alias)).toEqual([expected[257]])
    }
    db.close()
    expect(readRequests).toBeLessThanOrEqual(10)
    expect(batchLengths.reduce((sum, count) => sum + count, 0)).toBe(1025)
    expect(writes).toEqual(expectedWrites)
  })

  it('reports real migration progress until commit, then stays idle on subsequent opens', async () => {
    await seedV5()
    const progress: Array<number | null | 'idle'> = []
    const unsubscribe = cacheMigrationStore.subscribe(({ progress: value }) => {
      progress.push(value ? value.percent : 'idle')
    })
    try {
      await cache.getMessages(CHAT)
      expect(progress).toEqual([null, 0, 50, 99, 'idle'])
      const db = await openDB(DB_NAME)
      expect(db.version).toBe(6)
      db.close()
      progress.length = 0
      cache._resetDBForTesting()
      await cache.getRoomMessages(ROOM)
      expect(progress).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it('does not announce migration when creating an empty cache', async () => {
    const states: unknown[] = []
    const unsubscribe = cacheMigrationStore.subscribe(state => { states.push(state.progress) })
    try {
      await cache.getMessages(CHAT)
      expect(states).toEqual([])
    } finally {
      unsubscribe()
    }
  })

  it('backfills room batches when the chat archive is empty', async () => {
    const rows = await seedManyV5(0, 258)
    const alias = rows.room[257].correctionStanzaIds![0]
    expect((await cache.findRoomRetractionTargets(ROOM, alias))?.candidates).toHaveLength(1)
    const db = await openDB(DB_NAME)
    expect(db.version).toBe(6)
    expect(await db.count(CHAT_STORE)).toBe(0)
    expect(await db.count(ROOM_STORE)).toBe(258)
    db.close()
    expect(cacheMigrationStore.getState().progress).toBeNull()
  })

  it('stops publishing an old account migration after the storage scope changes', async () => {
    await seedV5()
    const progress: Array<number | null | 'idle'> = []
    const unsubscribe = cacheMigrationStore.subscribe(({ progress: value }) => {
      progress.push(value ? value.percent : 'idle')
      if (value?.percent === 0) setStorageScopeJid('other@example.test')
    })
    try {
      await cache.getMessages(CHAT)
      expect(progress).toEqual([null, 0, 'idle'])
      expect(cacheMigrationStore.getState().progress).toBeNull()
    } finally {
      unsubscribe()
    }
  })

  it('preserves every row and key, then resolves and retracts cached correction aliases', async () => {
    const rows = await seedV5()
    expect((await cache.findChatRetractionTargets(CHAT, 'older-alias'))?.candidates).toHaveLength(1)
    expect((await cache.findRoomRetractionTargets(ROOM, 'older-alias'))?.candidates).toHaveLength(1)
    expect(await cache.findChatRetractionTargets('other@example.test', 'older-alias')).toBeUndefined()
    expect(await cache.findRoomRetractionTargets('other@conference.example.test', 'older-alias')).toBeUndefined()
    const db = await openDB(DB_NAME)
    expect(db.version).toBe(6)
    for (const [store, row, scope] of [[CHAT_STORE, rows.chat, CHAT_SCOPE], [ROOM_STORE, rows.room, roomScope(ROOM)]] as const) {
      const saved = await db.getAll(store)
      expect(saved).toEqual([{ ...row, identityKeys: [...new Set([...row.identityKeys, ...correctionReferenceKeys(scope, row)])].sort() }])
    }
    db.close()
    await retractUnresidentChatTarget(CHAT, { targetId: 'older-alias', actorJid: 'other@example.test', retractedAt: 2000 })
    await retractUnresidentRoomTarget(ROOM, { targetId: 'older-alias', actorJid: rows.room.from, actorOccupantId: 'other-occupant', retractedAt: 2000 })
    expect((await cache.getMessages(CHAT))[0].body).toBe(rows.chat.body)
    expect((await cache.getRoomMessages(ROOM))[0].body).toBe(rows.room.body)
    await retractUnresidentChatTarget(CHAT, { targetId: 'older-alias', actorJid: rows.chat.from, retractedAt: 2000 })
    await retractUnresidentRoomTarget(ROOM, { targetId: 'older-alias', actorJid: rows.room.from, actorOccupantId: rows.room.occupantId, retractedAt: 2000 })
    expect((await cache.getMessages(CHAT))[0]).toMatchObject({ isRetracted: true, body: '' })
    expect((await cache.getRoomMessages(ROOM))[0]).toMatchObject({ isRetracted: true, body: '' })
  })

  it('performs ordinary correction lookups without reading whole histories after upgrading', async () => {
    const rows = await seedV5()
    await cache.findChatRetractionTargets(CHAT, 'older-alias')
    const getAll = IDBIndex.prototype.getAll
    vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function (this: IDBIndex, ...args) {
      if (this.name === 'conversationId' || this.name === 'roomJid') throw new Error('whole history read')
      return getAll.apply(this, args)
    })
    vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(() => { throw new Error('whole store read') })
    const updates = { isEdited: true, body: 'new correction', correctionRevision: { ids: ['stanza:new-alias'], supersedes: [], archiveTimestamp: 3000 }, correctionStanzaIds: ['new-alias'] }
    expect(await cache.applyChatCorrection(CHAT, 'original', updates, { actorJid: rows.chat.from })).toMatchObject({ body: 'new correction' })
    expect(await cache.applyRoomCorrection(ROOM, 'original', updates, { actorJid: rows.room.from, actorOccupantId: rows.room.occupantId })).toMatchObject({ body: 'new correction' })
    expect((await cache.findChatRetractionTargets(CHAT, 'older-alias'))?.candidates[0].body).toBe('new correction')
    expect((await cache.findRoomRetractionTargets(ROOM, 'older-alias'))?.candidates[0].body).toBe('new correction')
  })

  it('rolls back completed batches in both stores when a write request fails', async () => {
    const rows = await seedManyV5(258, 258)
    const progress: unknown[] = []
    const unsubscribe = cacheMigrationStore.subscribe(state => { progress.push(state.progress) })
    const put = IDBObjectStore.prototype.put
    let updates = 0
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      // 86 chat updates span two batches; fail after one room update too.
      // add() on an existing key produces a real asynchronous ConstraintError.
      if (++updates === 88) return this.add(value, key)
      return put.call(this, value, key)
    })
    await cache.findChatRetractionTargets(CHAT, 'older-alias')
    unsubscribe()
    expect(progress).toContainEqual({ percent: 0 })
    expect(progress.at(-1)).toBeNull()
    expect(cacheMigrationStore.getState().progress).toBeNull()
    fault.mockRestore()
    const db = await openDB(DB_NAME)
    expect(db.version).toBe(5)
    expect(updates).toBe(88)
    expect(await db.getAll(CHAT_STORE)).toEqual(rows.chat)
    expect(await db.getAll(ROOM_STORE)).toEqual(rows.room)
    db.close()
  })

  it('rolls back prior batches and retries when a later batch cannot be read', async () => {
    const rows = await seedManyV5(258, 0)
    const getAll = IDBObjectStore.prototype.getAll
    let reads = 0
    const fault = vi.spyOn(IDBObjectStore.prototype, 'getAll').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.transaction.mode === 'versionchange' && ++reads === 2) throw new Error('batch read interrupted')
      return getAll.apply(this, args)
    })
    expect(await cache.getMessages(CHAT)).toEqual([])
    fault.mockRestore()
    expect(cacheMigrationStore.getState().progress).toBeNull()
    const db = await openDB(DB_NAME)
    expect(db.version).toBe(5)
    expect(await db.getAll(CHAT_STORE)).toEqual(rows.chat)
    expect(await db.count(ROOM_STORE)).toBe(0)
    db.close()
    // The final partial batch contains a correction needing backfill.
    const alias = rows.chat[257].correctionStanzaIds![0]
    expect((await cache.findChatRetractionTargets(CHAT, alias))?.candidates).toHaveLength(1)
  })

  it('retries an interrupted upgrade on the next cache read without reloading the app', async () => {
    const rows = await seedV5()
    const put = IDBObjectStore.prototype.put
    const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementationOnce(() => {
      throw new Error('backfill interrupted')
    })

    expect(await cache.getMessages(CHAT)).toEqual([])
    fault.mockRestore()
    expect(IDBObjectStore.prototype.put).toBe(put)

    expect(await cache.getMessages(CHAT)).toMatchObject([{ body: rows.chat.body }])
    expect(await cache.getRoomMessages(ROOM)).toMatchObject([{ body: rows.room.body }])
  })
})
