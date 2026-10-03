import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chatStore, migrateReadPointer } from './chatStore'
import { connectionStore } from './connectionStore'
import type { Message } from '../core/types/chat'
import { isAhead, makeReadPointer, type ReadPointer } from './shared/readPointer'
import { _clearAllTransientForTesting } from './shared/transientUnread'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesAround: vi.fn().mockResolvedValue([]),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(true),
  }
})
import * as messageCache from '../utils/messageCache'

const CID = 'resident-floor@example.invalid'
const ARCHIVE_TOP = Date.parse('2026-09-04T06:54:00Z')
const FLOOR_TIME = ARCHIVE_TOP + 947_243

function message(id: string, timestamp: number): Message {
  return {
    type: 'chat', id, stanzaId: `s-${id}`, originId: undefined, conversationId: CID,
    from: CID, body: id, timestamp: new Date(timestamp), isOutgoing: false,
  }
}

const older = message('older', ARCHIVE_TOP - 1000)
const tail = message('tail', ARCHIVE_TOP)
const middle = message('middle', ARCHIVE_TOP + 1000)

function seed(pointer: ReadPointer, pending?: string): void {
  const entity = { id: CID, name: 'Resident floor', type: 'chat' as const }
  const meta = { unreadCount: 0, readPointer: pointer, pendingRemoteDisplayedStanzaId: pending }
  chatStore.setState({
    conversationEntities: new Map([[CID, entity]]),
    conversationMeta: new Map([[CID, meta]]),
    conversations: new Map([[CID, { ...entity, ...meta }]]),
    messages: new Map(), activeConversationId: null,
    firstNewMessageMarkers: new Map(), windowAtLiveEdge: new Map(),
  })
}

async function migratedFloor(messageId = older.id): Promise<ReadPointer> {
  // Legacy activation can pair a seen row's ID with a later lastReadAt (#1381).
  const pointer = await migrateReadPointer(CID, {
    lastSeenMessageId: messageId, lastReadAt: new Date(FLOOR_TIME),
  })
  expect(pointer).toEqual({
    order: { role: 'floor', timestamp: FLOOR_TIME },
    identity: { state: 'local', messageId },
  })
  return pointer!
}

const sources = ['pending MDS', 'live MDS', 'viewport'] as const
type Source = typeof sources[number]

async function report(source: Source, pointer: ReadPointer, candidate = tail): Promise<void> {
  seed(pointer, source === 'pending MDS' ? candidate.stanzaId : undefined)
  connectionStore.setState({ windowVisible: false })
  connectionStore.setState({ windowVisible: true })
  await vi.advanceTimersByTimeAsync(34)
  await chatStore.getState().activateConversation(CID)

  expect(chatStore.getState().messages.get(CID)?.map(m => m.id)).toContain(candidate.id)
  if (source === 'pending MDS') return

  expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBe(pointer)
  await vi.advanceTimersByTimeAsync(4858)
  if (source === 'live MDS') {
    chatStore.getState().applyRemoteDisplayed(CID, candidate.stanzaId!)
  } else {
    chatStore.getState().advanceReadPointer(CID, { id: candidate.id })
  }
}

describe('chatStore — a resident floor stays forward-only across activation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    chatStore.getState().reset()
    _clearAllTransientForTesting()
    connectionStore.setState({ windowVisible: true })
    vi.mocked(messageCache.getMessages).mockResolvedValue([older, tail, middle])
    vi.mocked(messageCache.getMessagesAround).mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
    chatStore.getState().reset()
    _clearAllTransientForTesting()
  })

  it.each(sources)('rejects an older position from %s', async (source) => {
    const pointer = await migratedFloor()
    await report(source, pointer)

    expect(chatStore.getState().messages.get(CID)?.map(m => m.id)).toContain(older.id)
    const after = chatStore.getState().conversationMeta.get(CID)?.readPointer
    expect(after!.order.timestamp).toBeGreaterThanOrEqual(pointer.order.timestamp)
    expect(isAhead(pointer, after)).toBe(false)
    expect(after).toBe(pointer)
    expect(chatStore.getState().firstNewMessageMarkers.get(CID)).toBeUndefined()
  })

  it.each(sources)('rejects a shared-millisecond position from %s', async (source) => {
    const pointer = await migratedFloor()
    const candidate = message('equal', FLOOR_TIME)
    vi.mocked(messageCache.getMessages).mockResolvedValue([older, candidate])
    await report(source, pointer, candidate)
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBe(pointer)
  })

  it.each(sources)('advances to a strictly newer position from %s', async (source) => {
    const pointer = await migratedFloor()
    const candidate = message('newer', FLOOR_TIME + 1)
    vi.mocked(messageCache.getMessages).mockResolvedValue([older, candidate])
    await report(source, pointer, candidate)
    const after = chatStore.getState().conversationMeta.get(CID)?.readPointer
    expect(after).toEqual(makeReadPointer(candidate, 'chat'))
    expect(isAhead(after!, pointer)).toBe(true)
  })

  it('preserves an absent floor through pending MDS and a viewport report', async () => {
    const pointer = await migratedFloor('absent')
    await report('pending MDS', pointer)
    chatStore.getState().advanceReadPointer(CID, { id: tail.id })
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBe(pointer)
  })

  it('rejects an older pending marker against an exact pointer', async () => {
    const pointer = makeReadPointer(message('newer', FLOOR_TIME), 'chat')
    await report('pending MDS', pointer)
    expect(chatStore.getState().conversationMeta.get(CID)?.readPointer).toBe(pointer)
  })
})
