import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { openDB, deleteDB } from 'idb'
import { seedVersion5SearchHistory } from './fixtures/searchHistory'
import type { Message, RoomMessage } from '../core/types'
import { _resetStorageScopeForTesting, setStorageScopeJid } from './storageScope'
import * as messageCache from './messageCache'
import {
  _resetDBForTesting, closeSearchIndex, indexMessages, initSearchIndex, isFilterIndexReady,
  migrateSearchFilters, getFilterIndexState, search,
} from './searchIndex'
import { filterToken } from './searchFilters'

// Intent: from:, is:mine and has: are reserved tokens with time-sorted rows, so a
// filter drives a search with or without words; a database from before version 6
// gets them by a resumable background copy and answers nothing until it is done.

const SCOPE = 'tokens@example.test'
const DB_NAME = `fluux-search-index:${SCOPE}`
const ROOM = 'team@conference.example.test'
const T0 = Date.UTC(2024, 0, 1)

const chat = (i: number, body: string, extra: Partial<Message> = {}) => ({
  type: 'chat', id: `c${i}`, conversationId: 'alice@example.test', from: 'alice@example.test', body,
  timestamp: new Date(T0 + i * 60_000), isOutgoing: false, ...extra,
}) as Message

const room = (i: number, nick: string, occupantId: string | undefined, body: string) => ({
  type: 'groupchat', id: `r${i}`, roomJid: ROOM, from: `${ROOM}/${nick}`, nick, occupantId, body,
  timestamp: new Date(T0 + i * 60_000), isOutgoing: false,
}) as RoomMessage

const ids = async (query: string, options: Parameters<typeof search>[1] = {}) =>
  (await search(query, { limit: 100, ...options })).map(r => r.messageId)

describe('filter tokens on the search index', () => {
  beforeEach(() => {
    globalThis.indexedDB = new IDBFactory()
    _resetStorageScopeForTesting()
    _resetDBForTesting()
    messageCache._resetDBForTesting()
    setStorageScopeJid(SCOPE)
  })
  afterEach(async () => {
    await closeSearchIndex()
    vi.restoreAllMocks()
  })

  it('answers has: with words and without, and narrows by date as well', async () => {
    await initSearchIndex(SCOPE)
    await indexMessages([
      chat(1, 'holiday photo', { attachment: { url: 'https://up.example/a.jpg' } }),
      chat(2, 'holiday plans'),
      chat(3, 'see https://example.org'),
      chat(4, 'budget', { attachment: { url: 'https://up.example/b.pdf', mediaType: 'application/pdf' } }),
      chat(5, 'mine', { isOutgoing: true, from: 'me@example.test' }),
    ], {}, SCOPE)
    const image = [[filterToken.has('image')]]
    expect(await ids('', { filterGroups: image })).toEqual(['c1'])
    expect(await ids('holiday', { filterGroups: image })).toEqual(['c1'])
    expect(await ids('budget', { filterGroups: image })).toEqual([])
    expect(await ids('', { filterGroups: [[filterToken.has('file')]] })).toEqual(['c4', 'c1'])
    expect(await ids('', { filterGroups: [[filterToken.has('link')]] })).toEqual(['c3'])
    expect(await ids('', { filterGroups: [[filterToken.mine]] })).toEqual(['c5'])
    expect(await ids('', { filterGroups: [[filterToken.has('file')]], after: T0 + 2 * 60_000 })).toEqual(['c4'])
    // The same on the in-memory path of a small conversation
    expect(await ids('', { filterGroups: [[filterToken.has('file')]], conversationId: 'alice@example.test' })).toEqual(['c4', 'c1'])
  })

  it('finds a one-to-one sender by bare JID and a room sender under every nick of one occupant id', async () => {
    await initSearchIndex(SCOPE)
    await indexMessages([
      chat(1, 'from alice'),
      chat(2, 'from me', { isOutgoing: true, from: 'me@example.test' }),
      room(3, 'bob', 'occ-bob', 'hello there'),
      room(4, 'robert', 'occ-bob', 'hello again'),
      room(5, 'carol', 'occ-carol', 'hello too'),
      room(6, 'bob', undefined, 'hello from an old client'),
    ], {}, SCOPE)
    expect(await ids('', { filterGroups: [[filterToken.from('alice@example.test')]] })).toEqual(['c1'])
    // `from:bob` stands for the nick and the occupant ids that nick has now
    const bob = [[filterToken.nick('bob', ROOM), filterToken.occupant('occ-bob', ROOM)]]
    expect(await ids('hello', { filterGroups: bob, conversationId: ROOM })).toEqual(['r6', 'r4', 'r3'])
    expect(await ids('hello', { filterGroups: bob })).toEqual(['r6', 'r4', 'r3'])
    expect(await ids('hello', { filterGroups: [[filterToken.occupant('occ-carol', ROOM)]] })).toEqual(['r5'])
  })

  it('keeps filter tokens out of the old token lists', async () => {
    await initSearchIndex(SCOPE)
    await indexMessages([chat(1, 'see https://example.org')], {}, SCOPE)
    const db = await openDB(DB_NAME)
    expect((await db.getAllKeys('search-tokens')).filter(key => String(key).startsWith('\u0001'))).toEqual([])
    db.close()
  })

  describe('upgrading a version 5 database', () => {
    async function downgradeToV5() {
      const db = await openDB(DB_NAME)
      const docs = await db.getAll('search-docs')
      db.close()
      await closeSearchIndex()
      await deleteDB(DB_NAME)
      const messages = docs.map((doc): Message | RoomMessage => {
        const common = { id: doc.messageId, from: doc.from, body: doc.body, timestamp: new Date(doc.timestamp),
          isOutgoing: doc.isOutgoing === true, isDelayed: doc.isDelayed,
          stanzaId: doc.stanzaId, originId: doc.originId }
        return doc.isRoom ? { ...common, type: 'groupchat', roomJid: doc.conversationId, nick: doc.nick ?? '', occupantId: doc.occupantId }
          : { ...common, type: 'chat', conversationId: doc.conversationId }
      })
      await seedVersion5SearchHistory(SCOPE, messages)
      _resetDBForTesting()
    }

    it('answers nothing for a filter until the copy is done, then what a fresh index answers', async () => {
      const photo = chat(1, 'holiday photo', { attachment: { url: 'https://up.example/a.jpg' }, stanzaId: 's1' })
      const messages = [photo, chat(2, 'holiday plans', { stanzaId: 's2' }), room(3, 'bob', 'occ-bob', 'holiday room')]
      await messageCache.saveMessages('chat', messages.filter((m): m is Message => m.type === 'chat'))
      await initSearchIndex(SCOPE)
      await indexMessages(messages, { fromCache: true }, SCOPE)
      const image = [[filterToken.has('image')]]
      const bob = [[filterToken.occupant('occ-bob', ROOM)]]
      const fresh = [await ids('', { filterGroups: image }), await ids('holiday', { filterGroups: bob })]

      await downgradeToV5()
      await initSearchIndex(SCOPE)
      expect(await isFilterIndexReady(SCOPE)).toBe(false)
      expect(await ids('', { filterGroups: image })).toEqual([])
      // Words alone keep working meanwhile
      expect(await ids('holiday')).toEqual(['r3', 'c2', 'c1'])

      await migrateSearchFilters()
      expect(await isFilterIndexReady(SCOPE)).toBe(true)
      // The attachment came from the message cache: a stored document has none
      expect([await ids('', { filterGroups: image }), await ids('holiday', { filterGroups: bob })]).toEqual(fresh)
      expect(fresh).toEqual([['c1'], ['r3']])
    })

    it('resumes from its cursor after an interruption', async () => {
      await initSearchIndex(SCOPE)
      const messages = Array.from({ length: 250 }, (_, i) => chat(i, `note ${i} https://x.example/${i}`))
      await messageCache.saveMessages('chat', messages)
      await indexMessages(messages, {}, SCOPE)
      await downgradeToV5()
      await initSearchIndex(SCOPE)
      const original = messageCache.resolveMessagesForIndex
      // The first batch succeeds, the second fails: the loop stops with the cursor after batch one
      const resolve = vi.spyOn(messageCache, 'resolveMessagesForIndex')
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new Error('quit'))
      await migrateSearchFilters()
      expect(await getFilterIndexState()).toEqual({ status: 'unavailable', reason: 'quit' })
      const db = await openDB(DB_NAME)
      expect((await db.get('search-meta', 'filters-cursor'))?.value).toBeDefined()
      expect((await db.getAll('search-docs')).filter(doc => doc.filterTokens).length).toBe(100)
      db.close()
      resolve.mockRestore()

      await migrateSearchFilters()
      expect(await isFilterIndexReady(SCOPE)).toBe(true)
      expect(await ids('', { filterGroups: [[filterToken.has('link')]] })).toHaveLength(100)
      expect((await search('', { filterGroups: [[filterToken.has('link')]], limit: 1000 }))).toHaveLength(250)
    })
  })
})
