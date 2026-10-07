import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RoomMessage, RoomOccupant } from '../core/types/room'
import { roomStore, roomReadTracker, _resetRoomReadStateForTesting } from './roomStore'
import { chatStore } from './chatStore'
import { ignoreStore } from './ignoreStore'
import { connectionStore } from './connectionStore'
import { createRoom, createMessage } from './roomStore.testHelpers'
import * as cache from '../utils/messageCache'
import { makeReadPointer } from './shared/readPointer'
import { transientCounts, _clearAllTransientForTesting } from './shared/transientUnread'
import { currentViewportGeneration, reportViewport } from './shared/viewportEvidence'
import { _resetStorageScopeForTesting } from '../utils/storageScope'

const ROOM = 'ignored-unread@conference.example.test'
const message = (id: string, nick: string, ts: number, mention = false) => ({
  ...createMessage(id, ROOM, nick, 'fixture', false, new Date(ts)), isMention: mention,
})
const ignoreAlice = () => ignoreStore.getState().addIgnored(ROOM, { identifier: 'alice', displayName: 'Alice' })
const meta = () => roomStore.getState().roomMeta.get(ROOM)!

beforeEach(async () => {
  ignoreStore.getState().reset()
  roomStore.getState().reset()
  chatStore.getState().reset()
  _resetRoomReadStateForTesting()
  _clearAllTransientForTesting()
  _resetStorageScopeForTesting()
  cache._resetDBForTesting()
  globalThis.indexedDB = new IDBFactory()
  connectionStore.getState().setWindowVisible(false)
  roomStore.getState().addRoom({ ...createRoom(ROOM), notifyAll: true })
  roomStore.getState().updateRoom(ROOM, { historyFloor: new Date(0) })
})

async function caughtUp() {
  const anchor = { ...message('anchor', 'me', 0), isOutgoing: true, stanzaId: 'archive-anchor' }
  await cache.saveRoomMessages([anchor])
  roomStore.getState().updateRoom(ROOM, { readPointer: makeReadPointer(anchor, 'room'), supportsMAM: true })
  roomStore.setState({
    mamQueryStates: new Map([[ROOM, { isLoading: false, error: null, hasQueried: true, isHistoryComplete: true, isCaughtUpToLive: true }]]),
    roomCoverage: new Map([[ROOM, { bottomId: 'archive-anchor' }]]),
  })
}

describe('room unread respects hidden ignored messages', () => {
  it.each(['MAM room', 'local room', 'Quick Chat'] as const)(
    'excludes ignored arrivals and alerts in a %s', async (kind) => {
      if (kind === 'MAM room') await caughtUp()
      if (kind === 'Quick Chat') roomStore.getState().updateRoom(ROOM, { isQuickChat: true })
      ignoreAlice()
      for (const whisper of [false, true]) {
        await roomStore.getState().addMessage(ROOM, { ...message(`hidden-${whisper}`, 'alice', whisper ? 20 : 10, !whisper),
          isPrivate: whisper }, { incrementMentions: true })
      }
      expect(meta()).toMatchObject({ unreadCount: 0, mentionsCount: 0 })
      await roomStore.getState().addMessage(ROOM, { ...message('visible-whisper', 'bob', 30), isPrivate: true },
        { incrementMentions: true })
      const outgoing = { ...message('outgoing-whisper', 'me', 40), isOutgoing: true, isPrivate: true }
      await roomStore.getState().addMessage(ROOM, outgoing)
      expect(meta()).toMatchObject({ unreadCount: 1, mentionsCount: 1 })
      expect(roomStore.getState().rooms.get(ROOM)).toMatchObject({ unreadCount: 1, mentionsCount: 1 })
    },
  )

  it('counts only visible MAM catch-up rows without a resident window', async () => {
    await caughtUp()
    ignoreAlice()
    roomStore.getState().mergeRoomMAMMessages(ROOM, [
      { ...message('hidden', 'alice', 10), isDelayed: true },
      { ...message('visible', 'bob', 20), isDelayed: true },
    ], {}, true, 'forward')
    await vi.waitFor(async () => expect(await cache.countRoomUnreadInArchive(ROOM, { floor: new Date(0) })).toEqual({ unread: 2 }))
    await roomStore.getState().recomputeUnreadForRoom(ROOM)
    expect(meta().unreadCount).toBe(1)
    roomStore.getState().updateRoom(ROOM, { readPointer: makeReadPointer(message('visible', 'bob', 20), 'room') })
    await roomStore.getState().recomputeUnreadForRoom(ROOM)
    expect(meta().unreadCount).toBe(0)
  })

  it('clears an existing ignored-only badge through the MAM recount without moving the pointer', async () => {
    await caughtUp()
    await cache.saveRoomMessages([message('hidden-1', 'alice', 10), message('hidden-2', 'alice', 20)])
    roomStore.getState().updateRoom(ROOM, { unreadCount: 2, mentionsCount: 1 })
    const pointer = meta().readPointer
    ignoreAlice()
    expect(meta()).toMatchObject({ unreadCount: 2, mentionsCount: 1 })
    await vi.waitFor(() => expect(meta()).toMatchObject({ unreadCount: 0, mentionsCount: 0 }))
    expect(meta().readPointer).toBe(pointer)
    expect(roomStore.getState().rooms.get(ROOM)).toMatchObject({ unreadCount: 0, mentionsCount: 0 })
  })

  it.each(['local room', 'Quick Chat'] as const)('leaves an existing %s badge until read', async (kind) => {
    if (kind === 'Quick Chat') roomStore.getState().updateRoom(ROOM, { isQuickChat: true })
    await roomStore.getState().addMessage(ROOM, message('previous-alert', 'alice', 10, true), { incrementMentions: true })
    const pointer = meta().readPointer
    const recount = vi.spyOn(roomReadTracker, 'scheduleRecount')
    try {
      ignoreAlice()
      expect(meta()).toMatchObject({ unreadCount: 1, mentionsCount: 1 })
      expect(meta().readPointer).toBe(pointer)
      expect(recount).not.toHaveBeenCalled()
      await roomStore.getState().addMessage(ROOM, message('new-hidden', 'alice', 20, true), { incrementMentions: true })
      expect(meta()).toMatchObject({ unreadCount: 1, mentionsCount: 1 })
      roomStore.getState().markReadToNewest(ROOM)
      expect(meta()).toMatchObject({ unreadCount: 0, mentionsCount: 0 })
    } finally {
      recount.mockRestore()
    }
  })

  it('preserves live alerts when a filtered mixed MAM recount remains nonzero', async () => {
    await caughtUp()
    await roomStore.getState().addMessage(ROOM, { ...message('visible-whisper', 'bob', 10), isPrivate: true },
      { incrementMentions: true })
    await roomStore.getState().addMessage(ROOM, message('hidden', 'alice', 20))
    await vi.waitFor(() => expect(transientCounts(roomReadTracker.scopeKey(ROOM), undefined).unread).toBe(0))
    roomStore.setState({ messages: new Map(), lastArrivedMessage: new Map() })
    ignoreAlice()
    await vi.waitFor(() => expect(meta()).toMatchObject({ unreadCount: 1, mentionsCount: 1 }))
    expect(await cache.countRoomUnreadInArchive(ROOM, { floor: new Date(0) }, row => row.nick !== 'alice'))
      .toEqual({ unread: 1 })
  })

  it('filters ignored transient arrivals in the MAM recount', async () => {
    await caughtUp()
    ignoreAlice()
    for (const [nick, ts] of [['alice', 10], ['bob', 20]] as const) {
      const whisper = { ...message(`transient-${nick}`, nick, ts), isPrivate: true, noLocalStore: true }
      await roomStore.getState().addMessage(ROOM, whisper, { incrementMentions: true })
    }
    roomStore.setState({ messages: new Map(), lastArrivedMessage: new Map() })
    await roomStore.getState().recomputeUnreadForRoom(ROOM)
    expect(meta()).toMatchObject({ unreadCount: 1, mentionsCount: 1 })
  })

  it('preserves ordinary live-edge read behavior for ignored Quick Chat arrivals', async () => {
    roomStore.getState().updateRoom(ROOM, { isQuickChat: true })
    ignoreAlice()
    roomStore.getState().setActiveRoom(ROOM)
    connectionStore.getState().setWindowVisible(true)
    const key = roomReadTracker.scopeKey(ROOM)
    reportViewport(key, currentViewportGeneration(key), 'at-edge')
    const pointer = meta().readPointer
    await roomStore.getState().addMessage(ROOM, { ...message('hidden-focused-whisper', 'alice', 10), isPrivate: true },
      { incrementMentions: true })
    expect(meta()).toMatchObject({ unreadCount: 0, mentionsCount: 0 })
    expect(meta().readPointer?.identity.messageId).toBe('hidden-focused-whisper')
    expect(transientCounts(key, pointer?.order)).toEqual({ unread: 0 })
  })

  it.each(['single', 'batched'] as const)('keeps an in-flight recount valid during routine %s presence updates', async (kind) => {
    await caughtUp()
    const bob: RoomOccupant = { nick: 'bob', jid: 'bob@example.test/desktop', affiliation: 'member', role: 'participant' }
    const carol: RoomOccupant = { nick: 'carol', jid: 'carol@example.test/desktop', affiliation: 'member', role: 'participant' }
    roomStore.getState().batchAddOccupants(ROOM, [bob, carol])
    await cache.saveRoomMessages([message('evicted-alice', 'alice', 10)])
    roomStore.getState().updateRoom(ROOM, { unreadCount: 1 })
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const count = cache.countRoomUnreadInArchive
    const spy = vi.spyOn(cache, 'countRoomUnreadInArchive').mockImplementation(async (...args) => {
      const result = await count(...args)
      await held
      return result
    })
    try {
      ignoreAlice()
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
      const inputsCurrent = roomReadTracker.captureUnreadInputs(ROOM)
      for (const show of ['away', undefined] as const) {
        const updatedBob = { ...bob, jid: 'bob@example.test/mobile', show }
        if (kind === 'single') roomStore.getState().addOccupant(ROOM, updatedBob)
        else roomStore.getState().batchAddOccupants(ROOM, [{ ...carol, show }, updatedBob])
        expect(roomStore.getState().roomRuntime.get(ROOM)?.occupants.get('bob')?.show).toBe(show)
        expect(inputsCurrent()).toBe(true)
      }
      roomStore.getState().updateRoom(ROOM, {
        nickToJidCache: new Map([['carol', 'carol@example.test'], ['bob', 'bob@example.test']]),
      })
      expect(inputsCurrent()).toBe(true)
      release()
      await vi.waitFor(() => expect(meta().unreadCount).toBe(0))
      expect(spy).toHaveBeenCalledTimes(1)
    } finally {
      release()
      spy.mockRestore()
    }
  })

  it('refreshes a MAM badge when presence supplies an ignored sender JID', async () => {
    await caughtUp()
    ignoreStore.getState().addIgnored(ROOM, { identifier: 'alice@example.test', displayName: 'Alice' })
    await roomStore.getState().addMessage(ROOM, message('history', 'renamed', 10))
    expect(meta().unreadCount).toBe(1)
    roomStore.getState().updateRoom(ROOM, { nickToJidCache: new Map([['renamed', 'alice@example.test']]) })
    await vi.waitFor(() => expect(meta().unreadCount).toBe(0))
  })

  it.each(['single', 'batched', 'cache replacement'] as const)('refreshes a MAM badge when a %s update changes sender mappings', async (kind) => {
    await caughtUp()
    roomStore.getState().addOccupant(ROOM, {
      nick: 'renamed', jid: 'bob@example.test', affiliation: 'member', role: 'participant',
    })
    ignoreStore.getState().addIgnored(ROOM, { identifier: 'alice@example.test', displayName: 'Alice' })
    await roomStore.getState().addMessage(ROOM, message('history', 'renamed', 10))
    expect(meta().unreadCount).toBe(1)
    const occupant: RoomOccupant = {
      nick: 'renamed', jid: 'alice@example.test', affiliation: 'member', role: 'participant',
    }
    if (kind === 'single') roomStore.getState().addOccupant(ROOM, occupant)
    else if (kind === 'batched') roomStore.getState().batchAddOccupants(ROOM, [occupant])
    else roomStore.getState().updateRoom(ROOM, { nickToJidCache: new Map([['renamed', occupant.jid!]]) })
    await vi.waitFor(() => expect(meta().unreadCount).toBe(0))
    roomStore.getState().updateRoom(ROOM, { nickToJidCache: new Map() })
    await vi.waitFor(() => expect(meta().unreadCount).toBe(1))
  })

  it('stops the filtered archive walk at the unread cap', async () => {
    await cache.saveRoomMessages(Array.from({ length: 8 }, (_, index) =>
      message(`row-${index}`, index < 3 ? 'alice' : 'bob', index + 1)))
    const visible = vi.fn((row: RoomMessage) => row.nick !== 'alice')
    expect(await cache.countRoomUnreadInArchive(ROOM, { floor: new Date(0), unreadCap: 2 }, visible))
      .toEqual({ unread: 2 })
    expect(visible).toHaveBeenCalledTimes(5)
  })

  it('matches occupant IDs and JID aliases, including hidden replies', async () => {
    roomStore.getState().updateRoom(ROOM, { nickToJidCache: new Map([['renamed', 'alice@example.test']]) })
    ignoreStore.getState().setIgnoredForRoom(ROOM, [{ identifier: 'occupant-a', displayName: 'Alice', jid: 'alice@example.test' }])
    await roomStore.getState().addMessage(ROOM, { ...message('occupant', 'old', 10), occupantId: 'occupant-a' })
    await roomStore.getState().addMessage(ROOM, message('alias', 'renamed', 20))
    await roomStore.getState().addMessage(ROOM, { ...message('reply', 'bob', 30), replyTo: { id: 'alias', to: `${ROOM}/renamed` } })
    expect(meta().unreadCount).toBe(0)
  })

  it('accepts an ordinary remote read marker on an ignored row', async () => {
    await caughtUp()
    const hidden = { ...message('hidden', 'alice', 10), stanzaId: 'sid-hidden' }
    const visible = message('visible', 'bob', 20)
    await roomStore.getState().addMessage(ROOM, hidden)
    await roomStore.getState().addMessage(ROOM, visible)
    ignoreAlice()
    roomStore.getState().setActiveRoom(ROOM)
    roomStore.getState().applyRemoteDisplayed(ROOM, 'sid-hidden')
    expect(meta().readPointer?.identity.messageId).toBe('hidden')
  })

  it('finishes a visibility recount after repeated in-flight presence invalidations', async () => {
    await caughtUp()
    await cache.saveRoomMessages([message('evicted-alice', 'alice', 10)])
    roomStore.getState().updateRoom(ROOM, { unreadCount: 1 })
    const count = cache.countRoomUnreadInArchive
    const releases: Array<() => void> = []
    const spy = vi.spyOn(cache, 'countRoomUnreadInArchive').mockImplementation(async (...args) => {
      const result = await count(...args)
      if (releases.length < 2) await new Promise<void>(resolve => { releases.push(resolve) })
      return result
    })
    try {
      ignoreAlice()
      await vi.waitFor(() => expect(releases).toHaveLength(1))
      roomStore.getState().updateRoom(ROOM, { nickToJidCache: new Map([['other', 'other@example.test']]) })
      releases[0]()
      await vi.waitFor(() => expect(releases).toHaveLength(2))
      roomStore.getState().updateRoom(ROOM, { nickToJidCache: new Map([['other', 'renamed@example.test']]) })
      releases[1]()
      await vi.waitFor(() => expect(meta().unreadCount).toBe(0))
      expect(spy).toHaveBeenCalledTimes(3)
    } finally {
      releases.forEach(release => release())
      spy.mockRestore()
    }
  })

  it('does not change 1:1 unread behavior for the same sender', () => {
    ignoreAlice()
    chatStore.getState().addConversation({ id: 'alice@example.test', name: 'Alice', type: 'chat', unreadCount: 0 })
    chatStore.getState().addMessage({
      type: 'chat', id: 'dm', conversationId: 'alice@example.test', from: 'alice@example.test',
      body: 'fixture', timestamp: new Date(10), isOutgoing: false, stanzaId: undefined, originId: undefined,
    })
    expect(chatStore.getState().conversations.get('alice@example.test')?.unreadCount).toBe(1)
  })
})
