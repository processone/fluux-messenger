import { beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { roomStore, _resetRoomReadStateForTesting } from './roomStore'
import { connectionStore } from './connectionStore'
import { chatStore } from './chatStore'
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
    'backward', { isFetchLatest: true, preserveGapMarker: options.bounded ?? false,
      extras: { emptyRoomArchive: true } })
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

  it('does not attach room empty-archive proof to a chat merge', () => {
    chatStore.getState().reset()
    chatStore.getState().addConversation({ id: 'bob@example.com', name: 'Bob', type: 'chat', unreadCount: 0 })
    chatStore.getState().mergeMAMMessages('bob@example.com', [], { count: 0 }, true, 'backward', {
      isFetchLatest: true, extras: { emptyRoomArchive: true },
    })
    expect(chatStore.getState().getMAMQueryState('bob@example.com').emptyArchiveProof).toBeUndefined()
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

  it('revokes the empty baseline on a later catch-up even after caught-up state returns', async () => {
    emptyFetch()
    roomStore.getState().mergeRoomMAMMessages(ROOM, [], {}, false, 'forward')
    roomStore.getState().mergeRoomMAMMessages(ROOM, [], {}, true, 'forward', { preserveGapMarker: true })
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

  it.each(['first', 'later', 'migrated-floor'] as const)('resolves a stashed marker when the %s live cache write commits after closing', async which => {
    roomStore.getState().setActiveRoom(ROOM)
    emptyFetch()
    const floor = message('earlier-row', 0)
    if (which !== 'first') await receive(floor)
    if (which === 'migrated-floor') {
      roomStore.getState().updateRoom(ROOM, {
        readPointer: { order: { role: 'floor', timestamp: floor.timestamp.getTime() },
          identity: { state: 'local', messageId: floor.id } },
        unreadCount: 0,
      })
    }
    const finish = holdNextWrite()
    const row = message('evicted-before-commit', 1)
    await roomStore.getState().addMessage(ROOM, row)
    roomStore.getState().setActiveRoom(OTHER_ROOM)
    const lookup = vi.spyOn(messageCache, 'getMessageByStanzaId')
    roomStore.getState().applyRemoteDisplayed(ROOM, row.stanzaId!)
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith('room', ROOM, row.stanzaId))
    await expect(lookup.mock.results[0].value).resolves.toBeNull()
    expect(roomStore.getState().roomMeta.get(ROOM)?.pendingRemoteDisplayedStanzaId).toBe(row.stanzaId)
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBeGreaterThan(0)
    finish()
    await vi.waitFor(() => expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(0))
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe(row.id)
    expect(roomStore.getState().roomMeta.get(ROOM)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
    expect(roomStore.getState().activeRoomJid).toBe(OTHER_ROOM)
  })

  it('starts a fresh cache resolution when the pre-write miss is still in flight', async () => {
    roomStore.getState().setActiveRoom(ROOM)
    emptyFetch()
    const finishWrite = holdNextWrite()
    const row = message('in-flight-miss', 1)
    await roomStore.getState().addMessage(ROOM, row)
    roomStore.getState().setActiveRoom(OTHER_ROOM)
    const load = messageCache.getMessageByStanzaId
    let finishLookup!: () => void
    let sawMiss!: () => void
    const lookupHeld = new Promise<void>(resolve => { finishLookup = resolve })
    const missed = new Promise<void>(resolve => { sawMiss = resolve })
    const holdResult = async <T>(pending: Promise<T>): Promise<T> => {
      const result = await pending
      expect(result).toBeNull()
      sawMiss()
      await lookupHeld
      return result
    }
    vi.spyOn(messageCache, 'getMessageByStanzaId').mockImplementationOnce((kind, id, stanzaId) =>
      kind === 'room' ? holdResult(load('room', id, stanzaId)) : holdResult(load('chat', id, stanzaId)))
    roomStore.getState().applyRemoteDisplayed(ROOM, row.stanzaId!)
    await missed
    finishWrite()
    await vi.waitFor(async () => expect(await load('room', ROOM, row.stanzaId!)).not.toBeNull())
    finishLookup()
    await vi.waitFor(() => expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(0))
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.identity.messageId).toBe(row.id)
    expect(roomStore.getState().roomMeta.get(ROOM)?.pendingRemoteDisplayedStanzaId).toBeUndefined()
    expect(roomStore.getState().activeRoomJid).toBe(OTHER_ROOM)
  })

  it('does not retry an earlier marker after a different unresolved marker replaced its stash', async () => {
    roomStore.getState().setActiveRoom(ROOM)
    emptyFetch()
    const finish = holdNextWrite()
    const row = message('superseded-before-commit', 1)
    await roomStore.getState().addMessage(ROOM, row)
    roomStore.getState().setActiveRoom(OTHER_ROOM)
    const lookup = vi.spyOn(messageCache, 'getMessageByStanzaId')
    roomStore.getState().applyRemoteDisplayed(ROOM, row.stanzaId!)
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith('room', ROOM, row.stanzaId))
    await expect(lookup.mock.results[0].value).resolves.toBeNull()
    roomStore.getState().applyRemoteDisplayed(ROOM, 'archive-not-cached')
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledWith('room', ROOM, 'archive-not-cached'))
    await expect(lookup.mock.results.at(-1)!.value).resolves.toBeNull()
    finish()
    await vi.waitFor(async () => expect(await messageCache.getMessageByStanzaId('room', ROOM, row.stanzaId!)).not.toBeNull())
    expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBeUndefined()
    expect(roomStore.getState().roomMeta.get(ROOM)?.pendingRemoteDisplayedStanzaId).toBe('archive-not-cached')
    expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBeGreaterThan(0)
  })

  it('keeps archive proof when closing the room during its first live cache write', async () => {
    roomStore.getState().setActiveRoom(ROOM)
    emptyFetch()
    const baseline = roomStore.getState().getRoomMAMQueryState(ROOM)
    const finish = holdNextWrite()
    const row = message('closed-during-write', 1)
    await roomStore.getState().addMessage(ROOM, row)
    roomStore.getState().setActiveRoom(OTHER_ROOM)
    expect(roomStore.getState().getRoomMAMQueryState(ROOM)).not.toBe(baseline)
    finish()
    await vi.waitFor(() => expect(roomStore.getState().getRoomCoverage(ROOM)?.bottomId).toBe(row.stanzaId))
    await remoteRead(row)
    await vi.waitFor(() => expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBe(0))
    expect(roomStore.getState().activeRoomJid).toBe(OTHER_ROOM)
  })

  it.each(['remove', 'leave', 'membership-loss', 'session-membership-reset', 'room-replacement'] as const)(
    'revokes the empty baseline on %s before a pending or new membership write', async boundary => {
      emptyFetch()
      const finish = holdNextWrite()
      await roomStore.getState().addMessage(ROOM, message('old-membership', 1))
      if (boundary === 'remove') roomStore.getState().removeRoom(ROOM)
      else if (boundary === 'leave') roomStore.getState().setRoomJoined(ROOM, false)
      else if (boundary === 'membership-loss') roomStore.getState().updateRoom(ROOM, { joined: false })
      else if (boundary === 'room-replacement') roomStore.getState().addRoom({ ...room(ROOM), joined: false })
      else roomStore.getState().markAllRoomsNotJoined()
      if (boundary === 'remove') roomStore.getState().addRoom(room(ROOM))
      else roomStore.getState().setRoomJoined(ROOM, true)
      finish()
      await vi.waitFor(async () => expect(await messageCache.getMessageByStanzaId('room', ROOM, 'archive-old-membership')).not.toBeNull())
      expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
      const row = message('new-membership', 3)
      await receive(row)
      await remoteRead(row)
      expect(roomStore.getState().getRoomCoverage(ROOM)).toBeUndefined()
      expect(roomStore.getState().rooms.get(ROOM)?.unreadCount).toBeGreaterThan(0)
    },
  )

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
