/**
 * Reconnect catch-up must count durable history before either entity is opened.
 * Runs the MAM query lifecycle, SDK bindings, stores and IndexedDB cache together;
 * only the transport, session events and clock are simulated.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { xml, type Client, type Element } from '@xmpp/client'
import { MAM } from './modules/MAM'
import type { ModuleDependencies } from './modules/BaseModule'
import { createPresenceReader } from './presenceReader'
import { createDefaultStoreBindings } from './defaultStoreBindings'
import { createStoreBindings } from '../bindings/storeBindings'
import { setupBackgroundSyncSideEffects } from './backgroundSync'
import { createMockClient, localStorageMock, simulateFreshSession } from './sideEffects.testHelpers'
import { roomStore, _resetRoomReadStateForTesting } from '../stores/roomStore'
import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { rosterStore } from '../stores/rosterStore'
import { consoleStore } from '../stores/consoleStore'
import { eventsStore } from '../stores/eventsStore'
import { adminStore } from '../stores/adminStore'
import { blockingStore } from '../stores/blockingStore'
import { ignoreStore } from '../stores/ignoreStore'
import * as cache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { makeReadPointer } from '../stores/shared/readPointer'
import { messageRowRef } from '../utils/messageIdentity'
import { subscribeDiagnostics, resetDiagnosticsForTesting, type UnreadRecountVerdict } from '../diagnostics/channel'
import type { RoomMessage, Message } from './types'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const ROOM = 'lab@conference.example.test'
const CHAT = 'alice@example.test'
const OWN = 'me@example.test'
const NS_MAM = 'urn:xmpp:mam:2'
const NS_RSM = 'http://jabber.org/protocol/rsm'
const BASE = new Date('2026-09-27T20:00:00Z').getTime()

function chatRow(id: string, offset: number): Message & { stanzaId: string } {
  return {
    type: 'chat', id, stanzaId: `s-${id}`, originId: undefined,
    timestamp: new Date(BASE + offset), body: id, isOutgoing: false,
    from: CHAT, conversationId: CHAT,
  }
}
function roomRow(id: string, offset: number): RoomMessage & { stanzaId: string } {
  return {
    type: 'groupchat', id, stanzaId: `s-${id}`, originId: undefined, occupantId: undefined,
    timestamp: new Date(BASE + offset), body: id, isOutgoing: false,
    from: `${ROOM}/alice`, roomJid: ROOM, nick: 'alice',
  }
}
const ROOM_ROWS = [roomRow('r0', 0), roomRow('r1', 1000), roomRow('r2', 2000)]
const CHAT_ROWS = [chatRow('c0', 0), chatRow('c1', 1000), chatRow('c2', 2000)]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

// fake-indexeddb uses real task turns while MAM and recount timers use the fake clock.
async function settle(ms = 1000): Promise<void> {
  for (let i = 0; i < Math.ceil(ms / 100); i++) {
    await vi.advanceTimersByTimeAsync(100)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}
function counts() {
  return {
    room: roomStore.getState().roomMeta.get(ROOM)?.unreadCount,
    chat: chatStore.getState().conversationMeta.get(CHAT)?.unreadCount,
  }
}
function expectQueriesFinished() {
  expect(roomStore.getState().getRoomMAMQueryState(ROOM)).toMatchObject({ isLoading: false, isCaughtUpToLive: true })
  expect(chatStore.getState().getMAMQueryState(CHAT)).toMatchObject({ isLoading: false, isCaughtUpToLive: true })
}

describe('unread recount after reconnect MAM', () => {
  let host: ReturnType<typeof createMockClient>
  let mam: MAM
  let cleanups: Array<() => void>
  let queries: Array<{ kind: string; after?: string; before?: string }>
  let verdicts: Array<{ kind: string; verdict: UnreadRecountVerdict }>
  let pageSize: number
  let beforeReply: (() => Promise<void>) | undefined

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2026-09-28T08:00:00Z'))
    globalThis.indexedDB = new IDBFactory()
    cache._resetDBForTesting()
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    connectionStore.getState().reset()
    chatStore.getState().reset()
    roomStore.getState().reset()
    _resetRoomReadStateForTesting()
    rosterStore.getState().reset()
    setStorageScopeJid(OWN)
    connectionStore.setState({ jid: `${OWN}/lab`, status: 'disconnected' })
    queries = []
    verdicts = []
    cleanups = []
    pageSize = 100
    beforeReply = undefined
    resetDiagnosticsForTesting()
    cleanups.push(subscribeDiagnostics(event => {
      if (event.kind === 'unread-recount') verdicts.push({ kind: event.entityKind, verdict: event.verdict })
    }))
    host = createMockClient()
    cleanups.push(createStoreBindings(host, () => ({
      connection: connectionStore.getState(), chat: chatStore.getState(), room: roomStore.getState(),
      roster: rosterStore.getState(), console: consoleStore.getState(), events: eventsStore.getState(),
      admin: adminStore.getState(), blocking: blockingStore.getState(), ignore: ignoreStore.getState(),
    })))
    const collectors = new Map<string, (stanza: Element) => void>()
    const transport = {} as Client
    const deps: ModuleDependencies = {
      stores: createDefaultStoreBindings(), presence: createPresenceReader(),
      getXmpp: () => transport, getCurrentJid: () => connectionStore.getState().jid,
      emit: host._emit, emitSDK: host._emitSDK, sendStanza: vi.fn().mockResolvedValue(undefined),
      registerMAMCollector: (id, handler) => {
        collectors.set(id, handler)
        return () => { collectors.delete(id) }
      },
      sendIQ: async (iq) => {
        const query = iq.getChild('query', NS_MAM)!
        const set = query.getChild('set', NS_RSM)!
        const kind = iq.attrs.to === ROOM ? 'room' : 'chat'
        const after = set.getChildText('after') || undefined
        const before = set.getChild('before') ? set.getChildText('before') ?? '' : undefined
        queries.push({ kind, after, before })
        await beforeReply?.()
        const all = kind === 'room' ? ROOM_ROWS : CHAT_ROWS
        const remaining = after
          ? all.slice(all.findIndex(row => row.stanzaId === after) + 1)
          : before ? all.slice(0, all.findIndex(row => row.stanzaId === before)) : all
        const page = remaining.slice(0, pageSize)
        for (const row of page) {
          collectors.get(query.attrs.queryid)?.(xml('message', kind === 'room' ? { from: ROOM } : {},
            xml('result', { xmlns: NS_MAM, queryid: query.attrs.queryid, id: row.stanzaId },
              xml('forwarded', { xmlns: 'urn:xmpp:forward:0' },
                xml('delay', { xmlns: 'urn:xmpp:delay', stamp: row.timestamp.toISOString() }),
                xml('message', { from: row.from, to: OWN, type: row.type, id: row.id }, xml('body', {}, row.body))))))
        }
        return xml('iq', { type: 'result' }, xml('fin', { xmlns: NS_MAM, complete: String(page.length === remaining.length) },
          xml('set', { xmlns: NS_RSM },
            ...(page.length ? [xml('first', {}, page[0].stanzaId), xml('last', {}, page.at(-1)!.stanzaId)] : []),
            xml('count', {}, String(all.length)))))
      },
    }
    mam = new MAM(deps)
    host.internal.mam.catchUpAllConversations.mockImplementation(mam.catchUpAllConversations.bind(mam))
    host.internal.mam.catchUpRoomHistory.mockImplementation(mam.catchUpRoomHistory.bind(mam))
    roomStore.getState().addRoom({
      jid: ROOM, name: 'lab', nickname: 'me', joined: false, isBookmarked: true,
      supportsMAM: true, unreadCount: 0, mentionsCount: 0, occupants: new Map(), typingUsers: new Set(),
    })
    chatStore.getState().addConversation({ id: CHAT, name: 'alice', type: 'chat', unreadCount: 0 })
    await cache.saveRoomMessages([ROOM_ROWS[0]])
    await cache.saveMessages([CHAT_ROWS[0]])
    roomStore.setState(state => ({
      roomMeta: new Map(state.roomMeta).set(ROOM, { ...state.roomMeta.get(ROOM)!, readPointer: makeReadPointer(ROOM_ROWS[0], 'room') }),
      roomCoverage: new Map([[ROOM, { bottomId: 's-r0', countBottomId: 's-r0' }]]),
    }))
    chatStore.setState(state => ({
      conversationMeta: new Map(state.conversationMeta).set(CHAT, { ...state.conversationMeta.get(CHAT)!, readPointer: makeReadPointer(CHAT_ROWS[0], 'chat') }),
      conversationCoverage: new Map([[CHAT, { bottomId: 's-c0', countBottomId: 's-c0' }]]),
    }))
    cleanups.push(setupBackgroundSyncSideEffects(host))
  })

  afterEach(async () => {
    cleanups.reverse().forEach(cleanup => cleanup())
    chatStore.getState().reset()
    roomStore.getState().reset()
    await settle(200)
    cache._resetDBForTesting()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  async function reconnect() {
    connectionStore.getState().setServerInfo({ identities: [], domain: 'example.test', features: [NS_MAM] })
    simulateFreshSession(host)
    host._emitSDK('room:joined', { roomJid: ROOM, joined: true })
    await settle(13000)
  }

  it('updates both unopened badges after catching up an existing archive', async () => {
    await reconnect()
    expectQueriesFinished()
    expect(await cache.getRoomMessages(ROOM)).toHaveLength(3)
    expect(await cache.getMessages(CHAT)).toHaveLength(3)
    await vi.waitFor(() => expect(counts()).toEqual({ room: 2, chat: 2 }))
    expect(roomStore.getState().activeRoomJid).toBeNull()
    expect(chatStore.getState().activeConversationId).toBeNull()
    expect(roomStore.getState().messages.get(ROOM) ?? []).toHaveLength(0)
    expect(chatStore.getState().messages.get(CHAT) ?? []).toHaveLength(0)
    expect(queries).toEqual([
      { kind: 'chat', after: 's-c0', before: undefined },
      { kind: 'room', after: 's-r0', before: undefined },
    ])
    expect(roomStore.getState().getRoomCoverage(ROOM)).toEqual({ bottomId: 's-r0', countBottomId: 's-r0' })
  })

  function holdArchiveWrites() {
    const gate = deferred<void>()
    const saveRooms = cache.saveRoomMessages
    const saveChats = cache.saveMessages
    vi.spyOn(cache, 'saveRoomMessages').mockImplementation(async rows => {
      const saved = await saveRooms(rows)
      await gate.promise
      return saved
    })
    vi.spyOn(cache, 'saveMessages').mockImplementation(async rows => {
      const saved = await saveChats(rows)
      await gate.promise
      return saved
    })
    return () => gate.resolve()
  }

  it('waits for durable write acknowledgements after the queries finish and does not poll', async () => {
    const releaseWrites = holdArchiveWrites()
    await reconnect()
    expectQueriesFinished()
    expect(counts()).toEqual({ room: 0, chat: 0 })
    expect(verdicts).toEqual([])
    await settle(60000)
    expect(counts()).toEqual({ room: 0, chat: 0 })
    expect(verdicts).toEqual([])

    releaseWrites()
    await settle()
    await vi.waitFor(() => expect(counts()).toEqual({ room: 2, chat: 2 }))
    expect(verdicts).toHaveLength(2)
    await settle(60000)
    expect(verdicts).toHaveLength(2)
  })

  it('retries initial recounts invalidated by live arrivals for both unopened entities', async () => {
    const gate = deferred<void>()
    const countRooms = cache.countRoomUnreadInArchive
    const countChats = cache.countUnreadInArchive
    const rooms = vi.spyOn(cache, 'countRoomUnreadInArchive').mockImplementationOnce(async (...args) => {
      const result = await countRooms(...args)
      await gate.promise
      return result
    })
    const chats = vi.spyOn(cache, 'countUnreadInArchive').mockImplementationOnce(async (...args) => {
      const result = await countChats(...args)
      await gate.promise
      return result
    })
    await reconnect()
    expectQueriesFinished()
    await vi.waitFor(() => {
      expect(rooms).toHaveBeenCalledTimes(1)
      expect(chats).toHaveBeenCalledTimes(1)
    })
    expect(counts()).toEqual({ room: 0, chat: 0 })

    host._emitSDK('room:message', {
      roomJid: ROOM, message: roomRow('r3', 3000), isLiveArrival: true, incrementUnread: true,
    })
    host._emitSDK('chat:message', { message: chatRow('c3', 3000), isLiveArrival: true })
    await settle()
    expect(counts()).toEqual({ room: 1, chat: 1 })
    gate.resolve()
    await settle()
    await vi.waitFor(() => expect(counts()).toEqual({ room: 3, chat: 3 }))
    const deferredVerdicts = verdicts.filter(({ verdict }) => verdict.status === 'deferred')
    expect(deferredVerdicts).toHaveLength(2)
    expect(deferredVerdicts).toEqual(expect.arrayContaining([
      { kind: 'room', verdict: { status: 'deferred', reason: 'input-version-changed' } },
      { kind: 'chat', verdict: { status: 'deferred', reason: 'input-version-changed' } },
    ]))
    expect(roomStore.getState().activeRoomJid).toBeNull()
    expect(chatStore.getState().activeConversationId).toBeNull()
    await settle(60000)
    expect(rooms).toHaveBeenCalledTimes(2)
    expect(chats).toHaveBeenCalledTimes(2)
  })

  it('keeps failed archive writes uncounted even after the loading flag clears', async () => {
    vi.spyOn(cache, 'saveRoomMessages').mockResolvedValue(false)
    vi.spyOn(cache, 'saveMessages').mockResolvedValue(false)
    await reconnect()
    expectQueriesFinished()
    expect(await cache.getRoomMessages(ROOM)).toHaveLength(1)
    expect(await cache.getMessages(CHAT)).toHaveLength(1)
    expect(counts()).toEqual({ room: 0, chat: 0 })
    expect(verdicts).toEqual([])
    await settle(60000)
    expect(verdicts).toEqual([])
  })

  it('coalesces multiple pages and counts only after the final page completes', async () => {
    pageSize = 1
    const lastPage = deferred<void>()
    beforeReply = async () => {
      if (['s-c1', 's-r1'].includes(queries.at(-1)?.after ?? '')) await lastPage.promise
    }
    await reconnect()
    expect(queries).toHaveLength(4)
    expect(counts()).toEqual({ room: 0, chat: 0 })
    expect(verdicts).toEqual([])
    lastPage.resolve()
    await settle()
    expectQueriesFinished()
    await vi.waitFor(() => expect(counts()).toEqual({ room: 2, chat: 2 }))
    expect(verdicts).toHaveLength(2)
  })

  it('does not double-count duplicate or empty catch-up pages', async () => {
    await reconnect()
    await vi.waitFor(() => expect(counts()).toEqual({ room: 2, chat: 2 }))
    // Re-fetch the same two archive entries, then query after the newest one.
    for (const edge of [0, 2]) {
      const caughtUp = Promise.all([
        mam.catchUpRoomHistory(ROOM, [ROOM_ROWS[edge]]),
        mam.catchUpConversationHistory(CHAT, [CHAT_ROWS[edge]]),
      ])
      await settle()
      await caughtUp
      expectQueriesFinished()
      await vi.waitFor(() => expect(counts()).toEqual({ room: 2, chat: 2 }))
    }
    expect(await cache.getRoomMessages(ROOM)).toHaveLength(3)
    expect(await cache.getMessages(CHAT)).toHaveLength(3)
  })

  it('does not let an older request completion unlock a replacement request', async () => {
    const originalReply = deferred<void>()
    beforeReply = () => originalReply.promise
    await reconnect()
    expect(queries).toHaveLength(2)

    const replacementReply = deferred<void>()
    beforeReply = () => replacementReply.promise
    const replaced = Promise.all([
      mam.catchUpRoomHistory(ROOM, [ROOM_ROWS[0]]),
      mam.catchUpConversationHistory(CHAT, [CHAT_ROWS[0]]),
    ])
    await settle()
    expect(queries).toHaveLength(4)
    const roomRequest = roomStore.getState().getRoomMAMQueryState(ROOM).loadingRequestId
    const chatRequest = chatStore.getState().getMAMQueryState(CHAT).loadingRequestId
    expect(roomRequest).toBeDefined()
    expect(chatRequest).toBeDefined()

    originalReply.resolve()
    await settle()
    expect(roomStore.getState().getRoomMAMQueryState(ROOM)).toMatchObject({ isLoading: true, loadingRequestId: roomRequest })
    expect(chatStore.getState().getMAMQueryState(CHAT)).toMatchObject({ isLoading: true, loadingRequestId: chatRequest })
    expect(counts()).toEqual({ room: 0, chat: 0 })
    expect(verdicts).toEqual([])

    replacementReply.resolve()
    await settle()
    await replaced
    expectQueriesFinished()
    await vi.waitFor(() => expect(counts()).toEqual({ room: 2, chat: 2 }))
    expect(verdicts).toHaveLength(2)
  })

  it('drops pending recounts when an account reset recreates the same entity ids', async () => {
    const releaseWrites = holdArchiveWrites()
    await reconnect()
    expectQueriesFinished()
    expect(counts()).toEqual({ room: 0, chat: 0 })

    connectionStore.getState().setStatus('disconnected')
    chatStore.getState().reset()
    roomStore.getState().reset()
    setStorageScopeJid('other@example.test')
    connectionStore.setState({ jid: 'other@example.test/lab' })
    roomStore.getState().addRoom({
      jid: ROOM, name: 'other account', nickname: 'other', joined: true, isBookmarked: true,
      unreadCount: 7, mentionsCount: 0, occupants: new Map(), typingUsers: new Set(),
    })
    chatStore.getState().addConversation({ id: CHAT, name: 'other account', type: 'chat', unreadCount: 7 })
    expect(counts()).toEqual({ room: 7, chat: 7 })
    releaseWrites()
    await settle()
    expect(counts()).toEqual({ room: 7, chat: 7 })
    expect(verdicts).toEqual([])
  })

  it('waits for the next session catch-up when the previous session closes before writes settle', async () => {
    const releaseWrites = holdArchiveWrites()
    await reconnect()
    connectionStore.getState().setStatus('disconnected')
    roomStore.getState().resetRoomMAMStates()
    chatStore.getState().resetMAMStates()
    releaseWrites()
    await settle()
    expect(counts()).toEqual({ room: 0, chat: 0 })
    expect(verdicts).toEqual([])

    await reconnect()
    expectQueriesFinished()
    await vi.waitFor(() => expect(counts()).toEqual({ room: 2, chat: 2 }))
  })

  it('keeps the coverage guard when a pending recount becomes runnable', async () => {
    const releaseWrites = holdArchiveWrites()
    await reconnect()
    roomStore.setState({ roomCoverage: new Map([[ROOM, { bottomId: 's-r2', countBottomId: 's-r2' }]]) })
    chatStore.setState({ conversationCoverage: new Map([[CHAT, { bottomId: 's-c2', countBottomId: 's-c2' }]]) })
    releaseWrites()
    await settle()
    expect(counts()).toEqual({ room: 0, chat: 0 })
    expect(verdicts).toHaveLength(2)
    expect(verdicts.every(({ verdict }) => verdict.status === 'deferred' && verdict.reason === 'coverage-short-of-floor')).toBe(true)
    await settle(60000)
    expect(verdicts).toHaveLength(2)
  })

  it('counts from a read pointer advanced while the archive write was pending', async () => {
    const releaseWrites = holdArchiveWrites()
    await reconnect()
    await roomStore.getState().activateRoom(ROOM)
    await chatStore.getState().activateConversation(CHAT)
    roomStore.getState().advanceReadPointer(ROOM, messageRowRef(ROOM_ROWS[1]))
    chatStore.getState().advanceReadPointer(CHAT, messageRowRef(CHAT_ROWS[1]))
    releaseWrites()
    await settle()
    await vi.waitFor(() => expect(counts()).toEqual({ room: 1, chat: 1 }))
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe('r1')
    expect(chatStore.getState().conversationMeta.get(CHAT)?.readPointer?.identity.messageId).toBe('c1')
  })

})
