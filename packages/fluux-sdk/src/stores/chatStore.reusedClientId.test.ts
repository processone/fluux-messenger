/**
 * Two messages from one sender may share a client id — a restarted client can
 * re-issue one — while their archive ids prove them distinct. In a 1:1
 * conversation both must be held, persisted and indexed, and every mutation
 * that holds one of them must reach that one. See `docs/MESSAGE_IDENTIFIERS.md`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatStore, chatTimelineConfig } from './chatStore'
import { appendLive, mergeArchive } from './shared/messageTimeline'
import type { Message } from '../core/types'
import { _resetStorageScopeForTesting } from '../utils/storageScope'
import { _resetForTesting } from './shared/throttledStorage'
import { _clearAllTransientForTesting, transientCounts } from './shared/transientUnread'
import { getStorageScopeJid } from '../utils/storageScope'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessageWithResult: vi.fn().mockResolvedValue(true),
    saveMessages: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
  }
})
vi.mock('../utils/searchIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/searchIndex')>()
  return {
    ...actual,
    indexMessage: vi.fn().mockResolvedValue(undefined),
    indexMessages: vi.fn().mockResolvedValue(undefined),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    removeMessage: vi.fn().mockResolvedValue(undefined),
  }
})
import * as messageCache from '../utils/messageCache'
import * as searchIndex from '../utils/searchIndex'

const A = 'alice@example.test'
const LATER = new Date(1_700_000_001_000)

function msg(over: Partial<Message>): Message {
  return {
    type: 'chat', id: 'X', conversationId: A, from: A, originId: undefined, stanzaId: undefined,
    body: 'b', timestamp: new Date(1_700_000_000_000), isOutgoing: false, ...over,
  }
}

const first = () => msg({ stanzaId: 's1', body: 'first' })
const second = () => msg({ stanzaId: 's2', body: 'second', timestamp: LATER })
const resident = () => chatStore.getState().messages.get(A) ?? []

function resetStore(activeConversationId: string | null = A) {
  _resetStorageScopeForTesting()
  _clearAllTransientForTesting()
  localStorageMock.clear()
  chatStore.setState({
    conversationEntities: new Map(), conversationMeta: new Map(), conversations: new Map(),
    messages: new Map(), activeConversationId, archivedConversations: new Set(), mamQueryStates: new Map(),
    conversationGaps: new Map(), conversationCoverage: new Map(), pendingRetractions: new Map(),
    typingStates: new Map(), drafts: new Map(), windowAtLiveEdge: new Map(),
  })
  _resetForTesting()
  vi.clearAllMocks()
  vi.mocked(messageCache.saveMessageWithResult).mockResolvedValue(true)
  vi.mocked(messageCache.getMessages).mockResolvedValue([])
}

describe('chat timeline with a reused client id', () => {
  const config = chatTimelineConfig()

  it('appendLive accepts a live message whose archive id contradicts the resident one', () => {
    const result = appendLive([first()], second(), true, config)
    expect(result.kind).toBe('appended')
    if (result.kind !== 'appended') return
    expect(result.messages.map(m => m.stanzaId)).toEqual(['s1', 's2'])
  })

  it('appendLive still merges an archive copy of the resident message', () => {
    const live = msg({ body: 'first' })
    const result = appendLive([live], first(), true, config)
    expect(result.kind).toBe('duplicate-backfilled')
    if (result.kind !== 'duplicate-backfilled') return
    expect(result.messages.map(m => m.stanzaId)).toEqual(['s1'])
  })

  it('appendLive treats a copy sharing the stanza-id as the same message despite another origin-id', () => {
    const result = appendLive([msg({ id: 'A', stanzaId: 's9', originId: 'oA' })], msg({ id: 'B', stanzaId: 's9', originId: 'oB' }), true, config)
    expect(result.kind).not.toBe('appended')
  })

  it('mergeArchive keeps a page message whose archive id contradicts the resident one', () => {
    for (const direction of ['backward', 'forward'] as const) {
      const result = mergeArchive([first()], [second()], direction, config)
      expect(result.newMessages.map(m => m.stanzaId)).toEqual(['s2'])
      expect(result.patched).toEqual([])
      expect(result.resident.map(m => m.stanzaId)).toEqual(['s1', 's2'])
    }
  })

  it('mergeArchive backfills, and never onto a twin, the archive id of the resident copy', () => {
    const live = msg({ body: 'first' })
    const result = mergeArchive([live, second()], [first()], 'forward', config)
    expect(result.newMessages).toEqual([])
    expect(result.resident.map(m => m.stanzaId)).toEqual(['s1', 's2'])
  })
})

describe('resident chat window with a reused client id', () => {
  beforeEach(() => resetStore())

  it('holds, persists and indexes a live message sharing from+id with a resident row', () => {
    chatStore.getState().addMessage(first())
    chatStore.getState().addMessage(second())
    expect(resident().map(m => [m.stanzaId, m.body])).toEqual([['s1', 'first'], ['s2', 'second']])
    expect(vi.mocked(messageCache.saveMessageWithResult).mock.calls.map(c => c[0].stanzaId)).toEqual(['s1', 's2'])
    expect(vi.mocked(searchIndex.indexMessage).mock.calls.map(c => c[0].stanzaId)).toEqual(['s1', 's2'])
  })

  it('holds and persists a MAM page message sharing from+id with a resident row', () => {
    chatStore.getState().addMessage(first())
    chatStore.getState().mergeMAMMessages(A, [second()], { last: 's2' }, true, 'forward')
    expect(resident().map(m => [m.stanzaId, m.body])).toEqual([['s1', 'first'], ['s2', 'second']])
    expect(vi.mocked(messageCache.saveMessages).mock.calls.flatMap(c => c[0].map(m => m.stanzaId))).toEqual(['s2'])
  })

  it('persists both when the conversation is not resident', () => {
    resetStore(null)
    chatStore.getState().addMessage(first())
    chatStore.setState({ messages: new Map() })
    chatStore.getState().addMessage(second())
    expect(vi.mocked(messageCache.saveMessageWithResult).mock.calls.map(c => c[0].stanzaId)).toEqual(['s1', 's2'])
  })

  it('loads both cached rows into the window', async () => {
    vi.mocked(messageCache.getMessages).mockResolvedValueOnce([first(), second()])
    await chatStore.getState().loadMessagesFromCache(A, { limit: 100 })
    expect(resident().map(m => [m.id, m.stanzaId])).toEqual([['X', 's1'], ['X', 's2']])
  })
})

describe('resident mutators addressing one of two twins', () => {
  beforeEach(async () => {
    resetStore()
    vi.mocked(messageCache.getMessages).mockResolvedValueOnce([
      first(),
      msg({ stanzaId: 's2', body: '[encrypted]', encryptedPayload: 'CIPHERTEXT', timestamp: LATER }),
    ])
    await chatStore.getState().loadMessagesFromCache(A, { limit: 100 })
  })

  it('updateMessage by the archive reference writes onto the named twin, in memory and in the cache', () => {
    chatStore.getState().updateMessage(A, 's2', { body: 'decrypted second', encryptedPayload: undefined })
    expect(resident().map(m => [m.stanzaId, m.body])).toEqual([['s1', 'first'], ['s2', 'decrypted second']])
    const [call] = vi.mocked(messageCache.updateMessage).mock.calls
    expect(call[1]).toBe('X')
    expect(call[5]).toMatchObject({ stanzaId: 's2' })
  })

  it('getMessage and removeMessage by the archive reference pick the named twin', () => {
    expect(chatStore.getState().getMessage(A, 's2')?.body).toBe('[encrypted]')
    chatStore.getState().removeMessage(A, 's2')
    expect(resident().map(m => m.stanzaId)).toEqual(['s1'])
    const [call] = vi.mocked(messageCache.deleteMessage).mock.calls
    expect(call[1]).toBe('X')
    expect(call[4]).toMatchObject({ stanzaId: 's2' })
  })

  it('updateReactions naming the archive id lands on that twin, in memory and in the cache', () => {
    chatStore.getState().updateReactions(A, 's2', 'bob@example.test', ['👍'])
    expect(resident().map(m => [m.stanzaId, Object.keys(m.reactions ?? {})])).toEqual([['s1', []], ['s2', ['👍']]])
    const [call] = vi.mocked(messageCache.updateMessage).mock.calls
    expect(call[5]).toMatchObject({ stanzaId: 's2' })
  })

  it('a correction of the second twin, addressed by its archive reference, edits only that twin', () => {
    chatStore.getState().updateMessage(A, 's2', { body: 'edited', isEdited: true }, undefined, { actorJid: A })
    expect(resident().map(m => [m.stanzaId, m.body])).toEqual([['s1', 'first'], ['s2', 'edited']])
  })

  it('a retraction naming the archive id tombstones only that twin', () => {
    chatStore.getState().updateMessage(A, 's2', { isRetracted: true, retractedAt: LATER })
    expect(resident().map(m => [m.stanzaId, m.isRetracted ?? false])).toEqual([['s1', false], ['s2', true]])
  })
})


describe('unseen chat twins before durable settlement', () => {
  beforeEach(() => {
    resetStore(null)
    chatStore.getState().addConversation({ id: A, name: 'Alice', type: 'chat', unreadCount: 0 })
  })

  const overlayCount = () => transientCounts({ accountScope: getStorageScopeJid() ?? '', kind: 'chat', entityId: A }, undefined).unread

  it.each(['stanza', 'origin'] as const)('counts both %s twins and settles each write independently', async identity => {
    const writes: Array<(value: boolean) => void> = []
    vi.mocked(messageCache.saveMessageWithResult).mockImplementation(() => new Promise(resolve => { writes.push(resolve) }))
    const twins = identity === 'stanza'
      ? [first(), msg({ ...second(), timestamp: first().timestamp })]
      : [msg({ originId: 'o1' }), msg({ originId: 'o2' })]
    for (const twin of twins) chatStore.getState().addMessage(twin)
    expect(overlayCount()).toBe(2)
    expect(chatStore.getState().conversationMeta.get(A)?.unreadCount).toBe(2)
    writes[0](true)
    await vi.waitFor(() => expect(overlayCount()).toBe(1))
    writes[1](true)
    await vi.waitFor(() => expect(overlayCount()).toBe(0))
  })

  it('drops only the retracted twin from never-persisted unread arrivals', () => {
    for (const twin of [first(), second()]) chatStore.getState().addMessage({ ...twin, noLocalStore: true } as Message)
    expect(overlayCount()).toBe(2)
    chatStore.getState().updateMessage(A, second(), { isRetracted: true })
    expect(overlayCount()).toBe(1)
    chatStore.getState().removeMessage(A, 's1')
    expect(overlayCount()).toBe(0)
  })
})
