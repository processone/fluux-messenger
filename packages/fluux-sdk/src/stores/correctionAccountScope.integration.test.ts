import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import type { Message, RoomMessage } from '../core/types'
import { createMockRoom } from '../core/test-utils'
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'
import { _clearRetractedIdentitiesForTesting } from '../utils/retractedIdentities'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'

const ACCOUNT_A = 'account-a@example.test'
const ACCOUNT_B = 'account-b@example.test'
const PEER = 'peer@example.test'
const ROOM = 'room@conference.example.test'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  messageCache._resetDBForTesting()
  searchIndex._resetDBForTesting()
  _resetStorageScopeForTesting()
  _clearRetractedIdentitiesForTesting()
  localStorage.clear()
  chatStore.setState({ messages: new Map() })
  roomStore.setState({ messages: new Map(), rooms: new Map([[ROOM, createMockRoom(ROOM)]]) })
})

afterEach(async () => {
  vi.restoreAllMocks()
  await searchIndex.closeSearchIndex()
  messageCache._resetDBForTesting()
  _resetStorageScopeForTesting()
})

describe.each(['chat', 'room'] as const)('%s cache-only correction account scope', kind => {
  it.each([ACCOUNT_A, null])('keeps deferred cache and search writes in initiating scope %s', async initiatingScope => {
    const common = {
      id: 'original', stanzaId: 'archive-original', body: 'initial text',
      timestamp: new Date('2026-09-01T10:00:00.000Z'), isOutgoing: false,
    }
    const message: Message | RoomMessage = kind === 'chat'
      ? { ...common, type: 'chat', conversationId: PEER, from: PEER }
      : { ...common, type: 'groupchat', roomJid: ROOM, from: `${ROOM}/Peer`, nick: 'Peer', occupantId: 'peer-occupant' }
    const otherMessage = { ...message, body: 'unchanged text' }
    const save = async (row: Message | RoomMessage) => {
      if (row.type === 'chat') await messageCache.saveMessages([row])
      else await messageCache.saveRoomMessages([row])
      await searchIndex.indexMessage(row)
    }
    const read = () => kind === 'chat' ? messageCache.getMessages(PEER) : messageCache.getRoomMessages(ROOM, {})

    setStorageScopeJid(ACCOUNT_B)
    await save(otherMessage)
    setStorageScopeJid(initiatingScope)
    await save(message)
    expect(kind === 'chat' ? chatStore.getState().getMessage(PEER, message.id) : roomStore.getState().getMessage(ROOM, message.id)).toBeUndefined()

    const completion = deferred()
    const writes: Promise<unknown>[] = []
    const operations = {
      chat: messageCache.applyChatCorrection,
      room: messageCache.applyRoomCorrection,
      search: searchIndex.updateMessage,
    }
    const track = <A extends unknown[], R>(operation: (...args: A) => Promise<R>, wait = Promise.resolve()) => (...args: A) => {
      const pending = Promise.all([operation(...args), wait]).then(([result]) => result)
      writes.push(pending)
      return pending
    }
    if (kind === 'chat') {
      vi.spyOn(messageCache, 'applyChatCorrection').mockImplementation(track(operations.chat, completion.promise))
    } else {
      vi.spyOn(messageCache, 'applyRoomCorrection').mockImplementation(track(operations.room, completion.promise))
    }
    vi.spyOn(searchIndex, 'updateMessage').mockImplementation(track(operations.search))

    const updates = {
      body: 'confidential correction', isEdited: true,
      correctionRevision: { ids: ['correction-1'], supersedes: [], archiveTimestamp: Date.parse('2026-09-01T10:01:00.000Z') },
    }
    try {
      if (kind === 'chat') {
        chatStore.getState().updateMessage(PEER, message.id, updates, undefined, { actorJid: message.from })
      } else {
        roomStore.getState().updateMessage(ROOM, message.id, updates, undefined, undefined, { actorJid: message.from, actorOccupantId: 'peer-occupant' })
      }
      setStorageScopeJid(ACCOUNT_B)
    } finally {
      completion.resolve()
      let cursor = 0
      while (cursor < writes.length) {
        const batch = writes.slice(cursor)
        cursor = writes.length
        await Promise.all(batch)
      }
    }

    await searchIndex.closeSearchIndex()
    messageCache._resetDBForTesting()
    expect(await searchIndex.search('confidential')).toEqual([])
    expect(await searchIndex.search('unchanged')).toMatchObject([{ messageId: message.id, body: otherMessage.body }])
    expect(await read()).toMatchObject([{ id: message.id, body: otherMessage.body }])

    setStorageScopeJid(initiatingScope)
    expect(await searchIndex.search('confidential')).toMatchObject([{
      messageId: message.id, body: updates.body, from: message.from,
      conversationId: kind === 'chat' ? PEER : ROOM, isRoom: kind === 'room',
    }])
    expect(await searchIndex.search('initial')).toEqual([])
    expect(await read()).toMatchObject([{ id: message.id, body: updates.body, originalBody: message.body }])
  })
})
