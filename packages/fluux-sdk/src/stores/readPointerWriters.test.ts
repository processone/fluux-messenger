import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { chatStore } from './chatStore'
import { roomStore } from './roomStore'
import { createMessage as createRoomMessage, createRoom } from './roomStore.testHelpers'
import { makeReadPointer, type PointerSource, type ReadPointer } from './shared/readPointer'
import { onMarkAsRead } from './shared/notificationState'
import { localStorageMock } from '../core/sideEffects.testHelpers'
import type { Conversation, Message } from '../core/types/chat'
import * as messageCache from '../utils/messageCache'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import { resetDiagnosticsForTesting, subscribeDiagnostics, type UnreadRecountDiagnostic } from '../diagnostics/channel'
import {
  beginViewportGeneration,
  reportViewport,
  currentViewportGeneration,
  _clearAllViewportEvidenceForTesting,
} from './shared/viewportEvidence'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const CHAT = 'alice@example.com'
const ROOM = 'room@conference.example.com'
const tail = { id: 'm3', from: `${ROOM}/alice`, timestamp: new Date(3_000), stanzaId: 's3' }

function heldPointer(kind: 'chat' | 'room', role: 'exact' | 'floor', timestamp = 9_000): ReadPointer {
  const pointer = makeReadPointer({ ...tail, id: 'm9', stanzaId: 's9', timestamp: new Date(timestamp) }, kind)
  return role === 'floor' ? { ...pointer, order: { role, timestamp } } : pointer
}

function conversation(readPointer?: ReadPointer): Conversation {
  return { id: CHAT, name: 'Alice', type: 'chat', unreadCount: 3, readPointer }
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorageMock.clear()
  chatStore.getState().reset()
  roomStore.getState().reset()
  _clearAllViewportEvidenceForTesting()
})

afterEach(() => {
  chatStore.getState().reset()
  roomStore.getState().reset()
  _clearAllViewportEvidenceForTesting()
  vi.useRealTimers()
})

describe.each(['chat', 'room'] as const)('%s mark-read writers', (kind) => {
  it.each([
    ['window away', false, 'at-edge', 's3'],
    ['viewport away', true, 'away', 's3'],
    ['viewport unknown', true, undefined, 's3'],
    ['different archive ID', true, 'at-edge', 'another-archive-id'],
  ] as const)('store markAsRead retains the held pointer with %s', (_name, windowAtLiveEdge, viewport, archiveId) => {
    const readPointer: ReadPointer = {
      order: { role: 'floor', timestamp: 3_000 },
      identity: { ...makeReadPointer(tail, kind).identity, state: 'addressable', archiveId },
    }
    const key = { kind, entityId: kind === 'chat' ? CHAT : ROOM, accountScope: '' }
    beginViewportGeneration(key)
    if (viewport) reportViewport(key, currentViewportGeneration(key), viewport)

    if (kind === 'chat') {
      const message: Message = {
        ...tail, type: 'chat', conversationId: CHAT, from: CHAT, body: 'hello', isOutgoing: false,
      }
      chatStore.getState().addConversation(conversation(readPointer))
      chatStore.setState({
        messages: new Map([[CHAT, [message]]]),
        windowAtLiveEdge: new Map([[CHAT, windowAtLiveEdge]]),
      })
      chatStore.getState().markAsRead(CHAT)

      expect(chatStore.getState().conversationMeta.get(CHAT)?.readPointer).toBe(readPointer)
      expect(chatStore.getState().conversationMeta.get(CHAT)?.unreadCount).toBe(0)
    } else {
      const message = {
        ...createRoomMessage(tail.id, ROOM, 'alice', 'hello', false, tail.timestamp), stanzaId: tail.stanzaId,
      }
      roomStore.getState().addRoom(createRoom(ROOM, { readPointer, unreadCount: 3, mentionsCount: 2 }), [message])
      roomStore.setState({ windowAtLiveEdge: new Map([[ROOM, windowAtLiveEdge]]) })
      roomStore.getState().markAsRead(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBe(readPointer)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(0)
    }
  })

  describe.each(['exact', 'floor'] as const)('held %s pointer', (role) => {
    it('onMarkAsRead is a no-op when the pointer is ahead and counts are already clear', () => {
      const state = { unreadCount: 0, mentionsCount: 0, readPointer: heldPointer(kind, role) }

      expect(onMarkAsRead(state, [tail], kind, {
        windowAtLiveEdge: true, viewportAtLiveEdge: true,
      })).toBe(state)
    })

    it.each([9_000, 3_000])('onMarkAsRead retains a pointer at %i when the resident tail cannot advance it', (timestamp) => {
      const readPointer = heldPointer(kind, role, timestamp)
      const firstNewMessageRow = { id: 'm2' }
      const result = onMarkAsRead(
        { unreadCount: 3, mentionsCount: 2, readPointer, firstNewMessageRow },
        [tail],
        kind,
        { windowAtLiveEdge: true, viewportAtLiveEdge: true }
      )

      expect(result.readPointer).toBe(readPointer)
      expect(result.unreadCount).toBe(0)
      expect(result.mentionsCount).toBe(0)
      expect(result.firstNewMessageRow).toBe(firstNewMessageRow)
    })

    it.each([9_000, 3_000])('markReadToNewest retains a pointer at %i and clears counts and divider', (timestamp) => {
      const readPointer = heldPointer(kind, role, timestamp)
      if (kind === 'chat') {
        const message: Message = { ...tail, type: 'chat', conversationId: CHAT, from: CHAT, body: 'hello', isOutgoing: false }
        chatStore.getState().addConversation(conversation(readPointer))
        chatStore.setState({
          messages: new Map([[CHAT, [message]]]),
          firstNewMessageMarkers: new Map([[CHAT, { id: 'm2' }]]),
        })

        chatStore.getState().markReadToNewest(CHAT)

        expect(chatStore.getState().conversationMeta.get(CHAT)?.readPointer).toBe(readPointer)
        expect(chatStore.getState().conversations.get(CHAT)?.readPointer).toBe(readPointer)
        expect(chatStore.getState().conversationMeta.get(CHAT)?.unreadCount).toBe(0)
        expect(chatStore.getState().firstNewMessageMarkers.has(CHAT)).toBe(false)
        const cleared = chatStore.getState()
        chatStore.getState().markReadToNewest(CHAT)
        expect(chatStore.getState()).toBe(cleared)
      } else {
        roomStore.getState().addRoom(createRoom(ROOM, { readPointer, unreadCount: 3, mentionsCount: 2 }))
        roomStore.setState({
          messages: new Map([[ROOM, [{ ...createRoomMessage(tail.id, ROOM, 'alice', 'hello', false, tail.timestamp), stanzaId: tail.stanzaId }]]]),
          firstNewMessageMarkers: new Map([[ROOM, { id: 'm2' }]]),
        })

        roomStore.getState().markReadToNewest(ROOM)

        expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBe(readPointer)
        expect(roomStore.getState().rooms.get(ROOM)?.readPointer).toBe(readPointer)
        expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
        expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(0)
        expect(roomStore.getState().firstNewMessageMarkers.has(ROOM)).toBe(false)
        const cleared = roomStore.getState()
        roomStore.getState().markReadToNewest(ROOM)
        expect(roomStore.getState()).toBe(cleared)
      }
    })
  })

  it('onMarkAsRead still advances to a later resident tail', () => {
    const readPointer = heldPointer(kind, 'exact', 1_000)
    const result = onMarkAsRead(
      { unreadCount: 3, mentionsCount: 2, readPointer },
      [tail], kind, { windowAtLiveEdge: true, viewportAtLiveEdge: true }
    )
    expect(result.readPointer).toEqual(makeReadPointer(tail, kind))
  })

  it.each([
    { windowAtLiveEdge: false, viewportAtLiveEdge: true },
    { windowAtLiveEdge: true, viewportAtLiveEdge: false },
  ])('onMarkAsRead requires both live-edge facts to resolve a floor: %j', (options) => {
    const readPointer: ReadPointer = {
      order: { role: 'floor', timestamp: 3_000 },
      identity: makeReadPointer(tail, kind).identity,
    }

    const result = onMarkAsRead({ unreadCount: 1, mentionsCount: 1, readPointer }, [tail], kind, options)

    expect(result.readPointer).toBe(readPointer)
    expect(result.unreadCount).toBe(0)
    expect(result.mentionsCount).toBe(0)
  })

  describe('markReadToNewest lastMessage fallback', () => {
    const archiveIdentity = makeReadPointer(tail, kind).identity

    it.each([
      ['local identity with an archive preview', { state: 'local', messageId: tail.id }, tail, 3_000],
      ['local identity with a local preview', { state: 'local', messageId: tail.id }, { ...tail, stanzaId: undefined }, 3_000],
      ['different message at the same timestamp', archiveIdentity, { ...tail, id: 'm4' }, 3_000],
      ['different archive ID', archiveIdentity, { ...tail, stanzaId: 'another-archive-id' }, 3_000],
      ['missing archive ID', archiveIdentity, { ...tail, stanzaId: undefined }, 3_000],
      ['preview behind the floor', archiveIdentity, tail, 4_000],
      ['conflicting occupant', { ...archiveIdentity, occupantId: 'original' }, { ...tail, occupantId: 'replacement' }, 3_000],
    ] as const)('retains the floor for %s without resident evidence', (_name, identity, preview, timestamp) => {
      const readPointer: ReadPointer = { order: { role: 'floor', timestamp }, identity }

      if (kind === 'chat') {
        const message: Message = {
          ...preview, type: 'chat', conversationId: CHAT, from: CHAT, body: 'hello', isOutgoing: false,
        }
        chatStore.getState().addConversation({ ...conversation(readPointer), lastMessage: message })
        expect(chatStore.getState().messages.get(CHAT) ?? []).toHaveLength(0)

        chatStore.getState().markReadToNewest(CHAT)

        expect(chatStore.getState().conversationMeta.get(CHAT)?.readPointer).toBe(readPointer)
        expect(chatStore.getState().conversations.get(CHAT)?.readPointer).toBe(readPointer)
        expect(chatStore.getState().conversationMeta.get(CHAT)?.unreadCount).toBe(0)
      } else {
        const message = {
          ...createRoomMessage(preview.id, ROOM, 'alice', 'hello', false, preview.timestamp), ...preview,
        }
        roomStore.getState().addRoom(createRoom(ROOM, {
          joined: true, readPointer, lastMessage: message, unreadCount: 1, mentionsCount: 1,
        }))
        expect(roomStore.getState().messages.get(ROOM) ?? []).toHaveLength(0)

        roomStore.getState().markAllRoomsRead()

        expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBe(readPointer)
        expect(roomStore.getState().rooms.get(ROOM)?.readPointer).toBe(readPointer)
        expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
        expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(0)
      }
    })
  })

  describe.each(['onMarkAsRead', 'markReadToNewest'] as const)('%s floor resolution', (writer) => {
    function markRead(readPointer: ReadPointer | undefined, messages: PointerSource[], unreadCount = 1) {
      if (writer === 'onMarkAsRead') {
        const firstNewMessageRow = { id: 'm2' }
        const result = onMarkAsRead(
          { unreadCount, mentionsCount: 0, readPointer, firstNewMessageRow },
          messages, kind, { windowAtLiveEdge: true, viewportAtLiveEdge: true }
        )
        expect(result.unreadCount).toBe(0)
        expect(result.mentionsCount).toBe(0)
        expect(result.firstNewMessageRow).toBe(firstNewMessageRow)
        return result.readPointer
      }
      if (kind === 'chat') {
        chatStore.getState().addConversation({ ...conversation(readPointer), unreadCount })
        chatStore.setState({ messages: new Map([[CHAT, messages.map((message) => ({
          ...message, type: 'chat' as const, conversationId: CHAT,
          from: message.from ?? CHAT, body: 'hello', isOutgoing: false,
        }))]]) })

        chatStore.getState().markReadToNewest(CHAT)

        const meta = chatStore.getState().conversationMeta.get(CHAT)!
        expect(meta.unreadCount).toBe(0)
        expect(chatStore.getState().conversations.get(CHAT)?.readPointer).toBe(meta.readPointer)
        expect(chatStore.getState().firstNewMessageMarkers.has(CHAT)).toBe(false)
        return meta.readPointer
      }
      roomStore.getState().addRoom(createRoom(ROOM, { readPointer, unreadCount, mentionsCount: 0 }))
      roomStore.setState({ messages: new Map([[ROOM, messages.map((message) => ({
        ...createRoomMessage(message.id, ROOM, 'alice', 'hello', false, message.timestamp),
        ...message,
      }))]]) })

      roomStore.getState().markReadToNewest(ROOM)

      const meta = roomStore.getState().roomMeta.get(ROOM)!
      expect(meta.unreadCount).toBe(0)
      expect(meta.mentionsCount).toBe(0)
      expect(roomStore.getState().rooms.get(ROOM)?.readPointer).toBe(meta.readPointer)
      expect(roomStore.getState().firstNewMessageMarkers.has(ROOM)).toBe(false)
      return meta.readPointer
    }

    if (writer === 'markReadToNewest') {
      it.each([0, 1])('resolves the same archive message with an unread count of %i', (unreadCount) => {
        const readPointer: ReadPointer = {
          order: { role: 'floor', timestamp: 3_000 },
          identity: makeReadPointer(tail, kind).identity,
        }

        const result = markRead(readPointer, [tail], unreadCount)

        expect(result?.order).toEqual(makeReadPointer(tail, kind).order)
        expect(result?.identity).toBe(readPointer.identity)
      })
    }

    it.each([
      ['different message at the same timestamp', { ...tail, id: 'm4' }],
      ['different archive ID', { ...tail, stanzaId: 'another-archive-id' }],
      ['missing archive ID', { ...tail, stanzaId: undefined }],
      ['same message behind the floor', { ...tail, timestamp: new Date(2_000) }],
    ] as const)('retains the floor for %s', (_name, message) => {
      const readPointer: ReadPointer = {
        order: { role: 'floor', timestamp: 3_000 },
        identity: makeReadPointer(tail, kind).identity,
      }

      expect(markRead(readPointer, [message])).toBe(readPointer)
    })

    it('retains the floor for a conflicting occupant sharing the message and archive IDs', () => {
      const readPointer: ReadPointer = {
        order: { role: 'floor', timestamp: 3_000 },
        identity: makeReadPointer({ ...tail, occupantId: 'original' }, kind).identity,
      }

      expect(markRead(readPointer, [{ ...tail, occupantId: 'replacement' }])).toBe(readPointer)
    })

    it.each([2_000, 3_000])('preserves local identity when marking a unique chat tail read from %i', (timestamp) => {
      const readPointer: ReadPointer = {
        order: { role: 'floor', timestamp },
        identity: { state: 'local', messageId: tail.id },
      }
      const message = { ...tail, stanzaId: kind === 'chat' ? tail.stanzaId : undefined }

      const result = markRead(readPointer, [message])

      if (kind === 'chat') {
        if (writer === 'onMarkAsRead' && timestamp === 3_000) {
          expect(result).toBe(readPointer)
        } else {
          expect(result?.order).toEqual(makeReadPointer(message, kind).order)
        }
        expect(result?.identity).toBe(readPointer.identity)
      } else if (timestamp === 3_000) {
        expect(result).toBe(readPointer)
      } else {
        expect(result).toEqual(makeReadPointer(message, kind))
      }
    })

    it('retains a local floor when the tail ID is duplicated in the resident window', () => {
      const readPointer: ReadPointer = {
        order: { role: 'floor', timestamp: 3_000 },
        identity: { state: 'local', messageId: tail.id },
      }

      expect(markRead(readPointer, [
        { ...tail, timestamp: new Date(2_000), stanzaId: undefined }, tail,
      ])).toBe(readPointer)
    })

    it.each(['exact', 'floor'] as const)('advances a held %s pointer to a later different message', (role) => {
      expect(markRead(heldPointer(kind, role, 1_000), [tail])).toEqual(makeReadPointer(tail, kind))
    })

    it('initializes the pointer when none is held', () => {
      expect(markRead(undefined, [tail])).toEqual(makeReadPointer(tail, kind))
    })
  })
})

describe('mark-all-read followed by a coverage-complete recount', () => {
  beforeEach(() => {
    vi.useRealTimers()
    _resetStorageScopeForTesting()
    globalThis.indexedDB = new IDBFactory()
    messageCache._resetDBForTesting()
    resetDiagnosticsForTesting()
  })

  afterEach(() => {
    messageCache._resetDBForTesting()
    resetDiagnosticsForTesting()
  })

  it.each([
    ['chat', 0], ['chat', 1], ['room', 0], ['room', 1],
  ] as const)('store markAsRead keeps the %s read through a complete recount from %i unread', async (kind, unreadCount) => {
    const readPointer: ReadPointer = {
      order: { role: 'floor', timestamp: 3_000 },
      identity: makeReadPointer(tail, kind).identity,
    }
    const mam = {
      isLoading: false, error: null, hasQueried: true,
      isHistoryComplete: true, isCaughtUpToLive: true,
    }
    const verdicts: UnreadRecountDiagnostic['verdict'][] = []
    subscribeDiagnostics((event) => {
      if (event.kind === 'unread-recount') verdicts.push(event.verdict)
    })
    const key = { kind, entityId: kind === 'chat' ? CHAT : ROOM, accountScope: '' }
    beginViewportGeneration(key)
    reportViewport(key, currentViewportGeneration(key), 'at-edge')

    if (kind === 'chat') {
      const message: Message = {
        ...tail, type: 'chat', conversationId: CHAT, from: CHAT, body: 'hello', isOutgoing: false,
      }
      chatStore.getState().addConversation({
        ...conversation(readPointer), unreadCount, lastMessage: message,
      })
      expect(await messageCache.saveMessages([
        { ...message, id: 'm1', stanzaId: 's1', timestamp: new Date(1_000) }, message,
      ])).toBe(true)
      chatStore.setState({
        messages: new Map([[CHAT, [message]]]),
        mamQueryStates: new Map([[CHAT, mam]]),
        conversationCoverage: new Map([[CHAT, { bottomId: 's1' }]]),
      })

      chatStore.getState().markAsRead(CHAT)
      expect(chatStore.getState().conversationMeta.get(CHAT)?.unreadCount).toBe(0)

      await chatStore.getState().recomputeUnreadForConversation(CHAT)

      expect(chatStore.getState().conversationMeta.get(CHAT)?.unreadCount).toBe(0)
    } else {
      const message = {
        ...createRoomMessage(tail.id, ROOM, 'alice', 'hello', false, tail.timestamp),
        stanzaId: tail.stanzaId,
      }
      roomStore.getState().addRoom(createRoom(ROOM, {
        joined: true, readPointer, lastMessage: message, unreadCount, mentionsCount: 0,
      }), [message])
      expect(await messageCache.saveRoomMessages([
        { ...message, id: 'm1', stanzaId: 's1', timestamp: new Date(1_000) }, message,
      ])).toBe(true)
      roomStore.setState({
        mamQueryStates: new Map([[ROOM, mam]]),
        roomCoverage: new Map([[ROOM, { bottomId: 's1' }]]),
      })

      roomStore.getState().markAsRead(ROOM)
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)

      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
    }
    expect(verdicts).toEqual([{ status: 'counted', count: 0, previousCount: 0 }])
  })

  it.each([
    ['chat', 'resident'], ['room', 'resident'], ['chat', 'evicted'], ['room', 'evicted'],
  ] as const)('keeps the inactive %s read after resolving its newest-message floor with its window %s', async (kind, window) => {
    const readPointer: ReadPointer = {
      order: { role: 'floor', timestamp: 3_000 },
      identity: makeReadPointer(tail, kind).identity,
    }
    const mam = {
      isLoading: false, error: null, hasQueried: true,
      isHistoryComplete: true, isCaughtUpToLive: true,
    }
    const verdicts: UnreadRecountDiagnostic['verdict'][] = []
    const firstRecount = new Promise<void>((resolve) => {
      subscribeDiagnostics((event) => {
        if (event.kind === 'unread-recount') {
          verdicts.push(event.verdict)
          resolve()
        }
      })
    })

    if (kind === 'chat') {
      const message: Message = {
        ...tail, type: 'chat', conversationId: CHAT, from: CHAT, body: 'hello', isOutgoing: false,
      }
      chatStore.getState().addConversation({ ...conversation(readPointer), lastMessage: message, unreadCount: 1 })
      expect(await messageCache.saveMessages([
        { ...message, id: 'm1', stanzaId: 's1', timestamp: new Date(1_000) }, message,
      ])).toBe(true)
      chatStore.setState({
        activeConversationId: window === 'evicted' ? CHAT : null,
        messages: new Map([[CHAT, [message]]]),
        mamQueryStates: new Map([[CHAT, mam]]),
        conversationCoverage: new Map([[CHAT, { bottomId: 's1' }]]),
      })
      if (window === 'evicted') {
        expect(chatStore.getState().messages.get(CHAT)).toEqual([message])
        chatStore.getState().setActiveConversation(null)
        expect(chatStore.getState().activeConversationId).toBeNull()
        expect(chatStore.getState().messages.get(CHAT) ?? []).toHaveLength(0)
        expect(chatStore.getState().conversationMeta.get(CHAT)?.lastMessage).toBe(message)
        expect(chatStore.getState().conversations.get(CHAT)?.lastMessage).toBe(message)
        await firstRecount
      } else {
        await chatStore.getState().recomputeUnreadForConversation(CHAT)
      }
      expect(verdicts).toEqual([{ status: 'counted', count: 1, previousCount: 1 }])
      expect(chatStore.getState().conversationMeta.get(CHAT)?.readPointer).toBe(readPointer)

      chatStore.getState().markReadToNewest(CHAT)
      expect(chatStore.getState().conversationMeta.get(CHAT)?.unreadCount).toBe(0)
      await chatStore.getState().recomputeUnreadForConversation(CHAT)

      expect(chatStore.getState().conversationMeta.get(CHAT)?.unreadCount).toBe(0)
      expect(chatStore.getState().conversationMeta.get(CHAT)?.readPointer?.order.role).toBe('exact')
    } else {
      const message = {
        ...createRoomMessage(tail.id, ROOM, 'alice', 'hello', false, tail.timestamp),
        stanzaId: tail.stanzaId, isMention: true,
      }
      roomStore.getState().addRoom(createRoom(ROOM, {
        joined: true, readPointer, lastMessage: message, unreadCount: 1, mentionsCount: 1,
      }), [message])
      expect(await messageCache.saveRoomMessages([
        { ...message, id: 'm1', stanzaId: 's1', timestamp: new Date(1_000) }, message,
      ])).toBe(true)
      roomStore.setState({
        activeRoomJid: window === 'evicted' ? ROOM : null,
        mamQueryStates: new Map([[ROOM, mam]]),
        roomCoverage: new Map([[ROOM, { bottomId: 's1' }]]),
      })
      if (window === 'evicted') {
        expect(roomStore.getState().messages.get(ROOM)).toEqual([message])
        roomStore.getState().setActiveRoom(null)
        expect(roomStore.getState().activeRoomJid).toBeNull()
        expect(roomStore.getState().messages.get(ROOM) ?? []).toHaveLength(0)
        expect(roomStore.getState().roomMeta.get(ROOM)?.lastMessage).toBe(message)
        expect(roomStore.getState().rooms.get(ROOM)?.lastMessage).toBe(message)
        await firstRecount
      } else {
        await roomStore.getState().recomputeUnreadForRoom(ROOM)
      }
      expect(verdicts).toEqual([{ status: 'counted', count: 1, previousCount: 1 }])
      expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer).toBe(readPointer)

      roomStore.getState().markAllRoomsRead()
      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(0)
      await roomStore.getState().recomputeUnreadForRoom(ROOM)

      expect(roomStore.getState().roomMeta.get(ROOM)?.unreadCount).toBe(0)
      expect(roomStore.getState().roomMeta.get(ROOM)?.mentionsCount).toBe(0)
      expect(roomStore.getState().roomMeta.get(ROOM)?.readPointer?.order.role).toBe('exact')
    }
    expect(verdicts).toEqual([
      { status: 'counted', count: 1, previousCount: 1 },
      { status: 'counted', count: 0, previousCount: 0 },
    ])
  })
})

describe('addConversation preserves the held read pointer on re-add', () => {
  it.each(['older', 'newer', 'missing'] as const)('retains the held pointer with a %s supplied pointer', (candidate) => {
    const readPointer = heldPointer('chat', 'exact')
    chatStore.getState().addConversation(conversation(readPointer))
    const supplied = candidate === 'missing'
      ? undefined
      : makeReadPointer({ ...tail, timestamp: new Date(candidate === 'older' ? 3_000 : 12_000) }, 'chat')

    chatStore.getState().addConversation({ ...conversation(supplied), name: 'Alice renamed' })

    expect(chatStore.getState().conversationMeta.get(CHAT)?.readPointer).toBe(readPointer)
    expect(chatStore.getState().conversations.get(CHAT)?.readPointer).toBe(readPointer)
    expect(chatStore.getState().conversations.get(CHAT)?.name).toBe('Alice renamed')
  })

  it('accepts the supplied pointer when the existing conversation has none', () => {
    chatStore.getState().addConversation(conversation())
    const readPointer = heldPointer('chat', 'exact')

    chatStore.getState().addConversation(conversation(readPointer))

    expect(chatStore.getState().conversationMeta.get(CHAT)?.readPointer).toBe(readPointer)
  })
})
