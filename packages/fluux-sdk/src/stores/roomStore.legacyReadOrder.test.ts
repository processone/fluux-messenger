import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { roomStore } from './roomStore'
import { createRoom } from './roomStore.testHelpers'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import type { RoomMessage } from '../core/types/room'
import { setStorageScopeJid } from '../utils/storageScope'
import { messageRowRef } from '../utils/messageIdentity'
import * as cache from '../utils/messageCache'
import { getRoomReadStateStorageKey, loadRoomReadState } from './shared/readStateStorage'
import { flush } from './shared/throttledStorage'

const ROOM = 'room@conference.example.com'
const ACCOUNT = 'reader@example.com'
const readMessage: RoomMessage = {
  type: 'groupchat', roomJid: ROOM, from: `${ROOM}/Peer`, nick: 'Peer',
  id: 'shared', stanzaId: 'archive-a', occupantId: 'peer',
  timestamp: new Date(1000), body: 'Already read', isOutgoing: false,
}

// Persisted before room order keys included an archive discriminator.
const savedPointer = {
  order: { role: 'exact', timestamp: 1000, tiebreak: { kind: 'room', from: `${ROOM}/Peer` } },
  identity: { state: 'addressable', messageId: 'shared', occupantId: 'peer', archiveId: 'archive-a' },
}

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

beforeEach(() => {
  cache._resetDBForTesting()
  globalThis.indexedDB = new IDBFactory()
  roomStore.getState().reset()
  localStorage.clear()
  setStorageScopeJid(ACCOUNT)
  localStorage.setItem(getRoomReadStateStorageKey(ACCOUNT), JSON.stringify([
    [ROOM, { readPointer: savedPointer, historyFloor: 0 }],
  ]))
  roomStore.getState().switchAccount(ACCOUNT)
  roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
})

afterEach(() => {
  flush()
  roomStore.getState().reset()
  cache._resetDBForTesting()
  setStorageScopeJid(null)
})

it.each([undefined, 1000, 2000])(
  'restores the read boundary before the first divider with next message at %s',
  async nextTimestamp => {
    const unread = nextTimestamp === undefined ? undefined : {
      ...readMessage, stanzaId: 'archive-b', timestamp: new Date(nextTimestamp), body: 'Still unread',
    }
    await cache.saveRoomMessages(unread ? [readMessage, unread] : [readMessage])
    const before = roomStore.getState().roomMeta.get(ROOM)!.readPointer!

    // No viewport report or new read: opening must honor the saved position.
    await roomStore.getState().activateRoom(ROOM)

    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toEqual(unread && messageRowRef(unread))
    const pointer = roomStore.getState().roomMeta.get(ROOM)!.readPointer!
    expect(pointer.identity).toBe(before.identity)
    expect(pointer.order.timestamp).toBe(before.order.timestamp)
    expect(await cache.countRoomUnreadInArchive(ROOM, {
      floor: new Date(0), pointer: pointer.order,
    })).toEqual({ unread: unread ? 1 : 0 })

    flush()
    expect(loadRoomReadState(ACCOUNT).get(ROOM)?.readPointer).toEqual(pointer)
    await roomStore.getState().activateRoom(null)
    await roomStore.getState().activateRoom(ROOM)
    expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toEqual(unread && messageRowRef(unread))
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBe(pointer)
  },
)

it('keeps the saved pointer when only another occurrence of its client ID is cached', async () => {
  const unread = { ...readMessage, stanzaId: 'archive-b', body: 'Another occurrence' }
  await cache.saveRoomMessage(unread)
  const before = roomStore.getState().roomMeta.get(ROOM)!.readPointer!

  await roomStore.getState().activateRoom(ROOM)

  expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBe(before)
  expect(roomStore.getState().firstNewMessageMarkers.get(ROOM)).toEqual(messageRowRef(unread))
})
