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

  it('rolls back both stores if alias backfill fails after its first update', async () => {
    const rows = await seedV5()
    const progress: unknown[] = []
    const unsubscribe = cacheMigrationStore.subscribe(state => { progress.push(state.progress) })
    const update = IDBCursor.prototype.update
    let updates = 0
    const fault = vi.spyOn(IDBCursor.prototype, 'update').mockImplementation(function (this: IDBCursor, value) {
      if (++updates === 2) throw new Error('backfill interrupted')
      return update.call(this, value)
    })
    await cache.findChatRetractionTargets(CHAT, 'older-alias')
    unsubscribe()
    expect(progress).toContainEqual({ percent: 0 })
    expect(progress.at(-1)).toBeNull()
    expect(cacheMigrationStore.getState().progress).toBeNull()
    fault.mockRestore()
    const db = await openDB(DB_NAME)
    expect(db.version).toBe(5)
    expect(await db.getAll(CHAT_STORE)).toEqual([rows.chat])
    expect(await db.getAll(ROOM_STORE)).toEqual([rows.room])
    db.close()
  })

  it('retries an interrupted upgrade on the next cache read without reloading the app', async () => {
    const rows = await seedV5()
    const update = IDBCursor.prototype.update
    const fault = vi.spyOn(IDBCursor.prototype, 'update').mockImplementationOnce(() => {
      throw new Error('backfill interrupted')
    })

    expect(await cache.getMessages(CHAT)).toEqual([])
    fault.mockRestore()
    expect(IDBCursor.prototype.update).toBe(update)

    expect(await cache.getMessages(CHAT)).toMatchObject([{ body: rows.chat.body }])
    expect(await cache.getRoomMessages(ROOM)).toMatchObject([{ body: rows.room.body }])
  })
})
