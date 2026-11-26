import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { roomStore, _resetRoomReadStateForTesting } from './roomStore'
import { connectionStore } from './connectionStore'
import * as messageCache from '../utils/messageCache'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import type { Room, RoomMessage } from '../core/types'

const ROOM = 'lounge@conference.example.com'
const OTHER_ROOM = 'workshop@conference.example.com'

function room(jid: string): Room {
  return {
    jid, name: jid, nickname: 'alice', joined: true, isBookmarked: false,
    occupants: new Map(), unreadCount: 0, mentionsCount: 0, typingUsers: new Set(),
  }
}

function message(id: string, seconds: number): RoomMessage {
  return {
    type: 'groupchat', roomJid: ROOM, from: `${ROOM}/bob`, nick: 'bob',
    originId: undefined, occupantId: undefined,
    id: `message-${id}`, stanzaId: `archive-${id}`, body: 'See you in the lounge',
    timestamp: new Date(Date.UTC(2026, 10, 26, 12, 0, seconds)), isOutgoing: false,
  }
}

function emptyFetch(options: { complete?: boolean; bounded?: boolean } = {}): void {
  roomStore.getState().mergeRoomMAMMessages(ROOM, [], { count: 0 }, options.complete ?? true,
    'backward', { isFetchLatest: true, preserveGapMarker: options.bounded ?? false })
}

async function receive(row: RoomMessage): Promise<void> {
  await roomStore.getState().addMessage(ROOM, row)
  await vi.waitFor(async () => expect(await messageCache.getMessage('room', ROOM, row.id, row.from)).not.toBeNull())
}

function holdNextWrite(): () => void {
  const save = messageCache.saveMessageWithResult
  let finish!: () => void
  const pending = new Promise<void>(resolve => { finish = resolve })
  vi.spyOn(messageCache, 'saveMessageWithResult').mockImplementationOnce(async (_kind, row) => {
    await pending
    return 'roomJid' in row ? save('room', row) : save('chat', row)
  })
  return finish
}

async function remoteRead(row: RoomMessage): Promise<void> {
  roomStore.getState().applyRemoteDisplayed(ROOM, row.stanzaId!)
  await vi.waitFor(() => expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe(row.id))
  await roomStore.getState().recomputeUnreadForRoom(ROOM)
}

// Intent: the fresh-room remote-read defect must be fixed without weakening
// the task's forward-only, unresolved-marker or archive-gap protections.
describe('empty initial room archive followed by an inactive remote read', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    messageCache._resetDBForTesting()
    localStorage.clear()
    roomStore.getState().reset()
    _resetRoomReadStateForTesting()
    connectionStore.getState().setWindowVisible(true)
    roomStore.getState().addRoom(room(ROOM))
    roomStore.getState().addRoom(room(OTHER_ROOM))
    roomStore.getState().setActiveRoom(OTHER_ROOM)
  })

  it('materializes coverage from a durable live row and clears only the remotely read prefix', async () => {
    emptyFetch()
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
    const read = message('read', 1)
    const unread = message('unread', 2)
    await receive(read)
    await receive(unread)
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(2)

    await remoteRead(read)
    await vi.waitFor(() => expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1))
    await remoteRead(unread)
    await vi.waitFor(() => expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(0))
    expect(roomStore.getState().getRoomCoverage(ROOM)?.bottomId).toBe(read.stanzaId)
    const pointer = roomStore.getState().roomMeta.get(ROOM)?.readPointer
    roomStore.getState().applyRemoteDisplayed(ROOM, read.stanzaId!, [read])
    await roomStore.getState().recomputeUnreadForRoom(ROOM)
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBe(pointer)
    expect(roomStore.getState().activeRoomJid).toBe(OTHER_ROOM)
  })

  it('keeps unread for a marker with no resolvable room archive row', async () => {
    emptyFetch()
    await receive(message('unread', 1))
    roomStore.getState().applyRemoteDisplayed(ROOM, 'archive-not-cached')
    await roomStore.getState().recomputeUnreadForRoom(ROOM)
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBeUndefined()
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1)
  })

  it('does not turn a live row without a room archive ID into coverage', async () => {
    emptyFetch()
    const row = { ...message('unassigned', 1), stanzaId: undefined }
    await receive(row)
    roomStore.getState().applyRemoteDisplayed(ROOM, row.id)
    await roomStore.getState().recomputeUnreadForRoom(ROOM)
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1)
  })

  it.each([
    { name: 'incomplete', complete: false, bounded: false },
    { name: 'bounded', complete: true, bounded: true },
  ])('does not bootstrap from an empty $name query', async ({ complete, bounded }) => {
    emptyFetch({ complete, bounded })
    const row = message('unread', 1)
    await receive(row)
    await remoteRead(row)
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1)
  })

  it('revokes the empty baseline after a later incomplete catch-up', async () => {
    emptyFetch()
    roomStore.getState().mergeRoomMAMMessages(ROOM, [], {}, false, 'forward')
    const row = message('after-gap', 3)
    await receive(row)
    await remoteRead(row)
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1)
  })

  it('does not bootstrap across a recorded gap even with an empty baseline', async () => {
    emptyFetch()
    roomStore.setState({ roomGaps: new Map([[ROOM, [{ start: message('before', 1).timestamp.getTime() }]]]) })
    const row = message('after-gap', 3)
    await receive(row)
    await remoteRead(row)
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1)
  })

  it('does not certify an unsuccessful live cache write', async () => {
    emptyFetch()
    vi.spyOn(messageCache, 'saveMessageWithResult').mockResolvedValueOnce(false)
    await roomStore.getState().addMessage(ROOM, message('not-stored', 1))
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1)
  })

  it('recounts a remote read that arrived before its live row became durable', async () => {
    emptyFetch()
    const finish = holdNextWrite()
    const row = message('pending-write', 1)
    await roomStore.getState().addMessage(ROOM, row)
    roomStore.getState().applyRemoteDisplayed(ROOM, row.stanzaId!, [row])
    await roomStore.getState().recomputeUnreadForRoom(ROOM)
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1)
    finish()
    await vi.waitFor(async () => expect(await messageCache.getMessageByStanzaId('room', ROOM, row.stanzaId!)).not.toBeNull())
    await vi.waitFor(() => expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(0))
  })

  it('does not resurrect the empty baseline when a live write finishes after a session reset', async () => {
    emptyFetch()
    const finish = holdNextWrite()
    roomStore.getState().addMessage(ROOM, message('late-write', 1))
    roomStore.getState().resetRoomMAMStates()
    finish()
    await vi.waitFor(async () => expect(await messageCache.getMessageByStanzaId('room', ROOM, 'archive-late-write')).not.toBeNull())
    expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(1)
  })
})
