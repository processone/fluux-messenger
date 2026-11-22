/**
 * One scenario list, run against both entity kinds of the message cache.
 *
 * Why: the chat and room archive operations are twins, and a refactor that
 * merges their entry points could route a room call to the chat store (or drop
 * an optional argument) without any single-kind test noticing. Every case below
 * is written once, against a per-kind `ops` table, and runs for 'chat' and
 * 'room' alike, with a foreign entity of the same kind present so a leak across
 * entities fails too.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage } from '../core/types'
import { _resetStorageScopeForTesting } from './storageScope'
import { _clearRetractedIdentitiesForTesting } from './retractedIdentities'
import * as cache from './messageCache'

type Kind = 'chat' | 'room'
type Msg = Message | RoomMessage

const ENTITY: Record<Kind, [string, string]> = {
  chat: ['alice@example.com', 'bob@example.com'],
  room: ['team@conference.example.com', 'other@conference.example.com'],
}

function make(kind: Kind, entity: string, id: string, at: number, overrides: Partial<Msg> = {}): Msg {
  return kind === 'chat'
    ? {
        type: 'chat', id, conversationId: entity, from: 'user@example.com', body: `body ${id}`,
        timestamp: new Date(at), isOutgoing: false, stanzaId: undefined, originId: undefined,
        ...overrides,
      } as Message
    : {
        type: 'groupchat', id, roomJid: entity, from: `${entity}/user`, nick: 'user', body: `body ${id}`,
        timestamp: new Date(at), isOutgoing: false, stanzaId: undefined, originId: undefined, occupantId: undefined,
        ...overrides,
      } as RoomMessage
}

const ops = {
  chat: {
    save: (m: Msg) => cache.saveMessage('chat', m as Message),
    saveMany: (ms: Msg[]) => cache.saveMessages('chat', ms as Message[]),
    saveWithResult: (m: Msg) => cache.saveMessageWithResult('chat', m as Message),
    get: (e: string, id: string) => cache.getMessage('chat', e, id),
    byStanzaId: (e: string, stanzaId: string) => cache.getMessageByStanzaId('chat', e, stanzaId),
    byReference: (e: string, ref: string) => cache.getMessageByReference('chat', e, ref),
    list: (e: string, o?: cache.GetMessagesOptions) => cache.getMessages('chat', e, o),
    read: (e: string, o?: cache.GetMessagesOptions) => cache.readMessages('chat', e, o),
    around: (e: string, id: string, o?: cache.GetMessagesAroundOptions) => cache.getMessagesAround('chat', e, { id }, o),
    count: (e: string) => cache.getMessageCount('chat', e),
    total: () => cache.getTotalMessageCount('chat'),
    oldest: (e: string) => cache.getOldestMessageTimestamp('chat', e),
    update: (e: string, id: string, u: Partial<Msg>) => cache.updateMessage('chat', e, id, u as Partial<Message>, 'user@example.com'),
    react: (e: string, id: string, who: string, emojis: string[]) => cache.updateMessageReactions('chat', e, id, who, emojis),
    remove: (e: string, id: string) => cache.deleteMessage('chat', e, id, 'user@example.com'),
    removeAll: (e: string) => cache.deleteConversationMessages('chat', e),
    iterate: (n: number, cb: (ms: Msg[]) => Promise<void>) => cache.iterateAllMessages('chat', n, cb as (ms: Message[]) => Promise<void>),
  },
  room: {
    save: (m: Msg) => cache.saveMessage('room', m as RoomMessage),
    saveMany: (ms: Msg[]) => cache.saveMessages('room', ms as RoomMessage[]),
    saveWithResult: (m: Msg) => cache.saveMessageWithResult('room', m as RoomMessage),
    get: (e: string, id: string) => cache.getMessage('room', e, id),
    byStanzaId: (e: string, stanzaId: string) => cache.getMessageByStanzaId('room', e, stanzaId),
    byReference: (e: string, ref: string) => cache.getMessageByReference('room', e, ref, `${e}/user`),
    list: (e: string, o?: cache.GetMessagesOptions) => cache.getMessages('room', e, o),
    read: (e: string, o?: cache.GetMessagesOptions) => cache.readMessages('room', e, o),
    around: (e: string, id: string, o?: cache.GetMessagesAroundOptions) => cache.getMessagesAround('room', e, { id }, o),
    count: (e: string) => cache.getMessageCount('room', e),
    total: () => cache.getTotalMessageCount('room'),
    oldest: (e: string) => cache.getOldestMessageTimestamp('room', e),
    update: (e: string, id: string, u: Partial<Msg>) => cache.updateMessage('room', e, id, u as Partial<RoomMessage>, `${e}/user`),
    react: (e: string, id: string, who: string, emojis: string[]) => cache.updateMessageReactions('room', e, id, who, emojis),
    remove: (e: string, id: string) => cache.deleteMessage('room', e, id, `${e}/user`),
    removeAll: (e: string) => cache.deleteConversationMessages('room', e),
    iterate: (n: number, cb: (ms: Msg[]) => Promise<void>) => cache.iterateAllMessages('room', n, cb as (ms: RoomMessage[]) => Promise<void>),
  },
}

beforeEach(() => {
  _resetStorageScopeForTesting()
  _clearRetractedIdentitiesForTesting()
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
})

describe.each(['chat', 'room'] as const)('message cache, %s kind', (kind) => {
  const o = ops[kind]
  const [here, elsewhere] = ENTITY[kind]

  it('saves one message and reads it back by id, only inside its own entity', async () => {
    await o.save(make(kind, here, 'm1', 1000))
    expect((await o.get(here, 'm1'))?.body).toBe('body m1')
    expect(await o.get(elsewhere, 'm1')).toBeNull()
    expect(await o.get(here, 'missing')).toBeNull()
  })

  it('reports whether a single save committed', async () => {
    expect(await o.saveWithResult(make(kind, here, 'm1', 1000))).toBe(true)
  })

  it('saves a batch, reports the commit, and treats an empty batch as committed', async () => {
    expect(await o.saveMany([])).toBe(true)
    expect(await o.saveMany([make(kind, here, 'a', 1000), make(kind, here, 'b', 2000)])).toBe(true)
    expect((await o.list(here)).map(m => m.id)).toEqual(['a', 'b'])
  })

  it('finds a message by server stanza id only inside its own entity', async () => {
    await o.save(make(kind, here, 'm1', 1000, { stanzaId: 'srv-1' }))
    await o.save(make(kind, elsewhere, 'm2', 1000, { stanzaId: 'srv-1' }))
    expect((await o.byStanzaId(here, 'srv-1'))?.id).toBe('m1')
    expect((await o.byStanzaId(elsewhere, 'srv-1'))?.id).toBe('m2')
    expect(await o.byStanzaId(here, 'nope')).toBeNull()
  })

  it('resolves a reference by client id inside its own entity', async () => {
    await o.save(make(kind, here, 'm1', 1000))
    expect((await o.byReference(here, 'm1'))?.id).toBe('m1')
    expect(await o.byReference(elsewhere, 'm1')).toBeNull()
  })

  it('lists in chronological order and honours limit, before, after and latest', async () => {
    await o.saveMany([1, 2, 3, 4, 5].map(n => make(kind, here, `m${n}`, n * 1000)))
    await o.save(make(kind, elsewhere, 'x', 3000))
    const ids = async (opts?: cache.GetMessagesOptions) => (await o.list(here, opts)).map(m => m.id)
    expect(await ids()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
    expect(await ids({ limit: 2 })).toEqual(['m1', 'm2'])
    expect(await ids({ latest: true, limit: 2 })).toEqual(['m4', 'm5'])
    expect(await ids({ before: new Date(3000) })).toEqual(['m1', 'm2'])
    expect(await ids({ after: new Date(3000) })).toEqual(['m4', 'm5'])
  })

  it('reads with a status that tells an empty entity from an unreadable cache', async () => {
    await o.save(make(kind, here, 'm1', 1000))
    const read = await o.read(here)
    expect(read.status).toBe('ok')
    expect(read.status === 'ok' ? read.value.map(m => m.id) : []).toEqual(['m1'])
    expect(await o.read(elsewhere)).toEqual({ status: 'ok', value: [] })
  })

  it('loads a window around an anchor without crossing into another entity', async () => {
    await o.saveMany([1, 2, 3, 4, 5].map(n => make(kind, here, `m${n}`, n * 1000)))
    await o.save(make(kind, elsewhere, 'x', 3000))
    expect((await o.around(here, 'm3', { before: 1, after: 1 })).map(m => m.id)).toEqual(['m2', 'm3', 'm4'])
    expect(await o.around(here, 'x')).toEqual([])
  })

  it('counts per entity, in total, and finds the oldest timestamp per entity', async () => {
    await o.saveMany([make(kind, here, 'a', 2000), make(kind, here, 'b', 1000)])
    await o.save(make(kind, elsewhere, 'c', 500))
    expect(await o.count(here)).toBe(2)
    expect(await o.count(elsewhere)).toBe(1)
    expect(await o.total()).toBe(3)
    expect((await o.oldest(here))?.getTime()).toBe(1000)
    expect(await o.oldest('nobody@example.com')).toBeNull()
  })

  it('updates fields in place and leaves the other entity alone', async () => {
    await o.save(make(kind, here, 'm1', 1000))
    await o.save(make(kind, elsewhere, 'm1', 1000))
    await o.update(here, 'm1', { body: 'edited' })
    expect((await o.get(here, 'm1'))?.body).toBe('edited')
    expect((await o.get(elsewhere, 'm1'))?.body).toBe('body m1')
  })

  it('updates reactions and says whether a row was found', async () => {
    await o.save(make(kind, here, 'm1', 1000))
    expect(await o.react(here, 'm1', 'carol', ['👍'])).toBe(true)
    expect((await o.get(here, 'm1'))?.reactions).toEqual({ '👍': ['carol'] })
    expect(await o.react(here, 'm1', 'carol', [])).toBe(true)
    expect((await o.get(here, 'm1'))?.reactions).toBeUndefined()
    expect(await o.react(here, 'missing', 'carol', ['👍'])).toBe(false)
    expect(await o.react(elsewhere, 'm1', 'carol', ['👍'])).toBe(false)
  })

  it('deletes one message by id and every message of one entity', async () => {
    await o.saveMany([make(kind, here, 'a', 1000), make(kind, here, 'b', 2000)])
    await o.save(make(kind, elsewhere, 'a', 1000))
    await o.remove(here, 'a')
    expect((await o.list(here)).map(m => m.id)).toEqual(['b'])
    expect((await o.list(elsewhere)).map(m => m.id)).toEqual(['a'])
    await o.removeAll(here)
    expect(await o.list(here)).toEqual([])
    expect((await o.list(elsewhere)).map(m => m.id)).toEqual(['a'])
  })

  it('iterates every stored message in pages of the requested size', async () => {
    await o.saveMany([1, 2, 3, 4, 5].map(n => make(kind, n % 2 ? here : elsewhere, `m${n}`, n * 1000)))
    const pages: string[][] = []
    await o.iterate(2, async (ms) => { pages.push(ms.map(m => m.id).sort()) })
    expect(pages.map(p => p.length)).toEqual([2, 2, 1])
    expect(pages.flat().sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5'])
  })
})

describe('message cache, kinds side by side', () => {
  it('keeps chat and room rows in separate stores even when the ids and entities coincide', async () => {
    await ops.chat.save(make('chat', 'same@example.com', 'm1', 1000))
    await ops.room.save(make('room', 'same@example.com', 'm1', 1000))
    expect(await ops.chat.total()).toBe(1)
    expect(await ops.room.total()).toBe(1)
    await ops.chat.removeAll('same@example.com')
    expect(await ops.chat.count('same@example.com')).toBe(0)
    expect(await ops.room.count('same@example.com')).toBe(1)
  })
})
