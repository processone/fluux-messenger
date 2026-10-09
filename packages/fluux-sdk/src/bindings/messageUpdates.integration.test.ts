import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage } from '../core/types'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import { createMockClientWithSDKEvents, createMockStoreRefs } from '../core/test-utils'
import { createStoreBindings, type StoreRefs } from './storeBindings'
import { chatStore } from '../stores/chatStore'
import { roomStore } from '../stores/roomStore'
import { createRoom } from '../stores/roomStore.testHelpers'
import * as cache from '../utils/messageCache'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

let holdSnapshot: (() => Promise<void>) | undefined
vi.mock('../utils/messageCache', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    getMessages: async (...args: Parameters<typeof actual.getMessages>) => {
      const rows = await actual.getMessages(...args)
      await holdSnapshot?.()
      return rows
    },
    getRoomMessages: async (...args: Parameters<typeof actual.getRoomMessages>) => {
      const rows = await actual.getRoomMessages(...args)
      await holdSnapshot?.()
      return rows
    },
  }
})

const CHAT = 'peer@example.com'
const ROOM = 'team@conference.example.com'
const preview = { url: 'https://example.com/', title: 'Retained card' }
let unbind: () => void
let client: ReturnType<typeof createMockClientWithSDKEvents>

beforeEach(() => {
  holdSnapshot = undefined
  globalThis.indexedDB = new IDBFactory()
  cache._resetDBForTesting()
  _resetStorageScopeForTesting()
  setStorageScopeJid('me@example.com')
  chatStore.getState().reset()
  roomStore.getState().reset()
  chatStore.getState().addConversation({ id: CHAT, name: 'Peer', type: 'chat', unreadCount: 0 })
  roomStore.getState().addRoom(createRoom(ROOM))
  client = createMockClientWithSDKEvents()
  unbind = createStoreBindings(client, () => ({
    ...createMockStoreRefs(), chat: chatStore.getState(), room: roomStore.getState(),
  }) as unknown as StoreRefs)
})
afterEach(() => { vi.restoreAllMocks(); unbind(); holdSnapshot = undefined; cache._resetDBForTesting() })

for (const kind of ['chat', 'room'] as const) {
  describe(`${kind} message updates across hydration`, () => {
    const jid = kind === 'chat' ? CHAT : ROOM
    const message = {
      id: 'updated-row', stanzaId: 'archive-row', from: kind === 'chat' ? CHAT : `${ROOM}/Peer`,
      body: 'Original', timestamp: new Date(1000), isOutgoing: false,
      ...(kind === 'chat' ? { type: 'chat', conversationId: CHAT } : { type: 'groupchat', roomJid: ROOM, nick: 'Peer' }),
    } as Message | RoomMessage
    const seed = () => kind === 'chat' ? cache.saveMessages([message as Message]) : cache.saveRoomMessages([message as RoomMessage])
    const read = () => kind === 'chat' ? cache.getMessage(jid, message.id) : cache.getRoomMessage(jid, message.id)
    const hydrate = () => kind === 'chat' ? chatStore.getState().loadMessagesFromCache(jid) : roomStore.getState().loadMessagesFromCache(jid)
    const resident = () => (kind === 'chat' ? chatStore : roomStore).getState().messages.get(jid)?.find(row => row.id === message.id)
    const emit = (id = message.id) => {
      const updates = { linkPreview: preview }
      if (kind === 'chat') client.emit('chat:message-updated', { conversationId: jid, messageId: id, updates })
      else client.emit('room:message-updated', { roomJid: jid, messageId: id, updates })
    }

    it.each(['updated-row', 'archive-row'])('persists an inactive update referenced by %s and restores the preview', async id => {
      await seed()
      expect(await read()).toMatchObject({ body: 'Original' })
      emit(id)
      await vi.waitFor(async () => expect(await read()).toMatchObject({ linkPreview: preview, body: 'Original' }))
      await hydrate()
      expect(resident()).toMatchObject({ linkPreview: preview, body: 'Original' })
    })

    it('hands off an update accepted during a stale activation read', async () => {
      await seed()
      expect(await read()).toMatchObject({ body: 'Original' })
      let captured!: () => void
      const snapshotCaptured = new Promise<void>(resolve => { captured = resolve })
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      holdSnapshot = () => { captured(); return gate }
      const activation = hydrate()
      await snapshotCaptured
      emit()
      holdSnapshot = undefined
      release()
      await activation
      await vi.waitFor(async () => expect(await read()).toMatchObject({ linkPreview: preview }))
      await vi.waitFor(() => expect(resident()).toMatchObject({ linkPreview: preview }))
      expect(resident()).toMatchObject({ linkPreview: preview, body: 'Original' })
    })

    it('keeps a retracted target free of preview content', async () => {
      const retracted = { ...message, body: '', isRetracted: true }
      if (kind === 'chat') await cache.saveMessages([retracted as Message])
      else await cache.saveRoomMessages([retracted as RoomMessage])
      await hydrate()
      emit()
      await (kind === 'chat' ? chatStore : roomStore).getState().loadMessagesFromCache(jid, { peek: true })
      expect(resident()).toMatchObject({ body: '', isRetracted: true })
      expect(resident()?.linkPreview).toBeUndefined()
      expect((await read())?.linkPreview).toBeUndefined()
    })

    it('preserves a newer resident preview while an older write is pending', async () => {
      await seed()
      let captured!: () => void
      const snapshotCaptured = new Promise<void>(resolve => { captured = resolve })
      let releaseSnapshot!: () => void
      const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve })
      holdSnapshot = () => { captured(); return snapshotGate }
      const activation = hydrate()
      await snapshotCaptured

      let writing!: () => void
      const writeStarted = new Promise<void>(resolve => { writing = resolve })
      let releaseWrite!: () => void
      const writeGate = new Promise<void>(resolve => { releaseWrite = resolve })
      if (kind === 'chat') {
        const original = cache.updateMessage
        vi.spyOn(cache, 'updateMessage').mockImplementationOnce(async (...args) => {
          writing()
          await writeGate
          return original(...args)
        })
      } else {
        const original = cache.updateRoomMessage
        vi.spyOn(cache, 'updateRoomMessage').mockImplementationOnce(async (...args) => {
          writing()
          await writeGate
          return original(...args)
        })
      }
      const newerPreview = { ...preview, title: 'Newer card' }
      const send = (newer: boolean) => {
        const updates = { linkPreview: newer ? newerPreview : preview }
        if (kind === 'chat') client.emit('chat:message-updated', { conversationId: jid, messageId: message.id, updates })
        else client.emit('room:message-updated', { roomJid: jid, messageId: message.id, updates })
      }
      send(false)
      holdSnapshot = undefined
      releaseSnapshot()
      await activation
      await writeStarted
      expect(resident()).toBeDefined()
      send(true)
      releaseWrite()
      await (kind === 'chat' ? chatStore : roomStore).getState().loadMessagesFromCache(jid, { peek: true })
      const expected = { linkPreview: newerPreview }
      expect(resident()).toMatchObject(expected)
      expect(await read()).toMatchObject(expected)
    })

    if (kind === 'room') {
      it('completes preview persistence during a delayed arrival before subsequent previews and cache loads', async () => {
        await seed()
        let captured!: () => void
        const snapshotCaptured = new Promise<void>(resolve => { captured = resolve })
        let releaseSnapshot!: () => void
        const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve })
        holdSnapshot = () => { captured(); return snapshotGate }
        const activation = hydrate()
        await snapshotCaptured
        const newerPreview = { ...preview, title: 'Latest after arrival' }
        const olderUpdate = roomStore.getState().updateMessage(jid, message.id, { linkPreview: preview })

        let reconciling!: () => void
        const reconciliationStarted = new Promise<void>(resolve => { reconciling = resolve })
        let releaseArrival!: () => void
        const arrivalGate = new Promise<void>(resolve => { releaseArrival = resolve })
        const reconcile = cache.reconcileRoomHistoryMessages
        vi.spyOn(cache, 'reconcileRoomHistoryMessages').mockImplementationOnce(async (...args) => {
          reconciling()
          await arrivalGate
          return reconcile(...args)
        })
        const arrival = roomStore.getState().addMessage(jid, {
          ...message, id: 'delayed-arrival', stanzaId: 'delayed-archive', isDelayed: true, timestamp: new Date(2000),
        } as RoomMessage)
        await reconciliationStarted
        holdSnapshot = undefined
        releaseSnapshot()
        await activation
        const newerUpdate = roomStore.getState().updateMessage(jid, message.id, { linkPreview: newerPreview })
        const cacheLoad = roomStore.getState().loadMessagesFromCache(jid, { peek: true })
        releaseArrival()
        const [, , , rows] = await Promise.all([arrival, olderUpdate, newerUpdate, cacheLoad])
        expect(rows.find(row => row.id === message.id)).toMatchObject({ linkPreview: newerPreview })
        expect(resident()).toMatchObject({ linkPreview: newerPreview })
        expect(await read()).toMatchObject({ linkPreview: newerPreview })
      })
    }

    it.each(['reset', 'account switch'] as const)('cancels queued updates after %s', async change => {
      await seed()
      let captured!: () => void
      const snapshotCaptured = new Promise<void>(resolve => { captured = resolve })
      let release!: () => void
      const gate = new Promise<void>(resolve => { release = resolve })
      holdSnapshot = () => { captured(); return gate }
      const activation = hydrate()
      await snapshotCaptured
      emit()
      if (change === 'reset') {
        if (kind === 'chat') chatStore.getState().reset()
        else roomStore.getState().reset()
      } else setStorageScopeJid('other@example.com')
      holdSnapshot = undefined
      release()
      await activation
      expect(resident()).toBeUndefined()
      setStorageScopeJid('me@example.com')
      // A subsequent cache read also waits until the canceled update leaves the queue.
      const rows = await (kind === 'chat' ? chatStore : roomStore).getState().loadMessagesFromCache(jid, { peek: true })
      if (kind === 'chat' && change === 'reset') expect(rows).toEqual([])
      else {
        expect(rows[0]).toMatchObject({ body: 'Original' })
        expect(rows[0].linkPreview).toBeUndefined()
      }
    })

  })
}
