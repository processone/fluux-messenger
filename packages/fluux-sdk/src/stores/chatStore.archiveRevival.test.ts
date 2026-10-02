/**
 * An archived 1:1 conversation comes back when an incoming message newer than
 * the archive lands, whatever path delivers it: a live stanza, an offline or
 * SM replay, a MAM catch-up page (active or background), or the archived
 * preview refresh. A conversation opened from a push notification is caught up
 * through MAM before the replayed stanza arrives as a duplicate, so the merge
 * path has to apply the rule itself.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chatStore, _resetChatArchiveSavesForTesting } from './chatStore'
import type { Message, Conversation } from '../core/types/chat'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { flush as flushThrottledStorage, _resetForTesting } from './shared/throttledStorage'
import { _clearAllTransientForTesting } from './shared/transientUnread'
import { _clearAllViewportEvidenceForTesting } from './shared/viewportEvidence'

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value }),
    removeItem: vi.fn((key: string) => { delete store[key] }),
    clear: vi.fn(() => { store = {} }),
    get _store() { return store },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessageWithResult: vi.fn().mockResolvedValue(true),
    saveMessages: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesAround: vi.fn().mockResolvedValue([]),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    updateMessageReactions: vi.fn().mockResolvedValue(true),
  }
})

const CONV = 'alice@example.com'
const ARCHIVED_AT = new Date('2026-03-01T12:00:00Z').getTime()
const MINUTE = 60_000

let seq = 0
function message(at: number, overrides: Partial<Message> = {}): Message {
  seq += 1
  return {
    type: 'chat',
    id: `m${seq}`,
    stanzaId: `s${seq}`,
    originId: undefined,
    conversationId: CONV,
    from: CONV,
    body: `message ${seq}`,
    timestamp: new Date(at),
    isOutgoing: false,
    ...overrides,
  }
}

function conversation(id: string): Conversation {
  return { id, name: id, type: 'chat', unreadCount: 0 }
}

function isArchived(): boolean {
  return chatStore.getState().isArchived(CONV)
}

/** A conversation whose newest known message is `lastAt`, archived at ARCHIVED_AT. */
function archiveWithHistory(lastAt = ARCHIVED_AT - 10 * MINUTE): Message {
  const last = message(lastAt)
  chatStore.getState().addConversation(conversation(CONV))
  chatStore.getState().addMessage(last)
  vi.setSystemTime(ARCHIVED_AT)
  chatStore.getState().archiveConversation(CONV)
  expect(isArchived()).toBe(true)
  return last
}

describe('chatStore: archived conversation revival', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(ARCHIVED_AT - 60 * MINUTE)
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    chatStore.setState({
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      conversations: new Map(),
      messages: new Map(),
      activeConversationId: null,
      archivedConversations: new Set(),
      mamQueryStates: new Map(),
      conversationGaps: new Map(),
      conversationCoverage: new Map(),
      pendingRetractions: new Map(),
      typingStates: new Map(),
      drafts: new Map(),
      windowAtLiveEdge: new Map(),
    })
    _resetForTesting()
    _resetChatArchiveSavesForTesting()
    _clearAllTransientForTesting()
    _clearAllViewportEvidenceForTesting()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('MAM merge', () => {
    it('unarchives the conversation opened from a notification when catch-up merges the new message', () => {
      archiveWithHistory()
      vi.setSystemTime(ARCHIVED_AT + 60 * MINUTE)
      // Tapping the push notification activates the conversation before the
      // reconnect catches it up.
      chatStore.getState().setActiveConversation(CONV)

      const fresh = message(ARCHIVED_AT + 30 * MINUTE)
      chatStore.getState().mergeMAMMessages(CONV, [fresh], { first: fresh.stanzaId, last: fresh.stanzaId, count: 1 }, true, 'forward')

      expect(isArchived()).toBe(false)
    })

    it('does not unarchive on the replayed copy of a message read before archiving again', () => {
      archiveWithHistory()
      chatStore.getState().setActiveConversation(CONV)
      const fresh = message(ARCHIVED_AT + 30 * MINUTE)
      chatStore.getState().mergeMAMMessages(CONV, [fresh], { first: fresh.stanzaId, last: fresh.stanzaId, count: 1 }, true, 'forward')
      chatStore.getState().archiveConversation(CONV)

      // The user archived it again after reading it; the replayed copy is not news.
      chatStore.getState().addMessage({ ...fresh, isDelayed: true }, { isLiveArrival: false })

      expect(isArchived()).toBe(true)
    })

    it('unarchives on a background (non-active) forward merge', () => {
      archiveWithHistory()
      const fresh = message(ARCHIVED_AT + 30 * MINUTE)
      chatStore.getState().mergeMAMMessages(CONV, [fresh], { first: fresh.stanzaId, last: fresh.stanzaId, count: 1 }, true, 'forward')

      expect(isArchived()).toBe(false)
    })

    it('keeps the conversation archived when paging back through history older than the archive', () => {
      archiveWithHistory()
      chatStore.getState().setActiveConversation(CONV)
      const older = [message(ARCHIVED_AT - 50 * MINUTE), message(ARCHIVED_AT - 40 * MINUTE)]
      chatStore.getState().mergeMAMMessages(CONV, older, { first: older[0].stanzaId, last: older[1].stanzaId, count: 2 }, false, 'backward')

      expect(isArchived()).toBe(true)
    })

    it('keeps the conversation archived when only our own messages are newer', () => {
      archiveWithHistory()
      const own = message(ARCHIVED_AT + 30 * MINUTE, { isOutgoing: true, from: 'me@example.com' })
      chatStore.getState().mergeMAMMessages(CONV, [own], { first: own.stanzaId, last: own.stanzaId, count: 1 }, true, 'forward')

      expect(isArchived()).toBe(true)
    })
  })

  describe('live and replayed delivery', () => {
    it('unarchives on an offline-delivered message sent after the archive', () => {
      archiveWithHistory()
      vi.setSystemTime(ARCHIVED_AT + 60 * MINUTE)
      chatStore.getState().addMessage(message(ARCHIVED_AT + 30 * MINUTE, { isDelayed: true }), { isLiveArrival: false })

      expect(isArchived()).toBe(false)
    })

    it('keeps the conversation archived when a message known before archiving is re-delivered', () => {
      // The sender's clock runs ahead of ours: the last message is stamped after
      // the local archive moment, yet the user saw it before archiving.
      const seen = archiveWithHistory(ARCHIVED_AT + 5 * MINUTE)
      // A backgrounded conversation keeps no resident messages to dedupe against.
      chatStore.setState({ messages: new Map() })
      chatStore.getState().addMessage({ ...seen, id: 'redelivered', isDelayed: true }, { isLiveArrival: false })

      expect(isArchived()).toBe(true)
    })
  })

  describe('archived preview refresh', () => {
    it('unarchives when the refreshed preview is newer than the archive, even after a merge advanced the local preview', () => {
      archiveWithHistory()
      const fresh = message(ARCHIVED_AT + 30 * MINUTE)
      // Some path already recorded the message as the preview without reviving.
      chatStore.setState((state) => {
        const meta = new Map(state.conversationMeta)
        meta.set(CONV, { ...meta.get(CONV)!, lastMessage: fresh })
        return { conversationMeta: meta }
      })

      chatStore.getState().updateLastMessagePreview(CONV, fresh)

      expect(isArchived()).toBe(false)
    })

    it('keeps the conversation archived when the preview predates the archive', () => {
      archiveWithHistory()
      chatStore.getState().updateLastMessagePreview(CONV, message(ARCHIVED_AT - 5 * MINUTE))

      expect(isArchived()).toBe(true)
    })
  })

  describe('server conversation list', () => {
    it('keeps the original archive moment when the server list re-asserts the archived flag', () => {
      archiveWithHistory()
      vi.setSystemTime(ARCHIVED_AT + 120 * MINUTE)
      chatStore.getState().mergeServerConversations([{ id: CONV, name: CONV, type: 'chat', archived: true }])

      chatStore.getState().addMessage(message(ARCHIVED_AT + 30 * MINUTE, { isDelayed: true }), { isLiveArrival: false })

      expect(isArchived()).toBe(false)
    })

    it('keeps a conversation archived by the server on a cold profile when older history is previewed', () => {
      vi.setSystemTime(ARCHIVED_AT)
      chatStore.getState().mergeServerConversations([{ id: CONV, name: CONV, type: 'chat', archived: true }])

      chatStore.getState().updateLastMessagePreview(CONV, message(ARCHIVED_AT - 24 * 60 * MINUTE))

      expect(isArchived()).toBe(true)
    })

    it('clears the archive moment when the server list unarchives', () => {
      archiveWithHistory()
      chatStore.getState().mergeServerConversations([{ id: CONV, name: CONV, type: 'chat', archived: false }])

      expect(isArchived()).toBe(false)
      expect(chatStore.getState().conversationMeta.get(CONV)?.archivedAt).toBeUndefined()
    })
  })

  describe('persistence', () => {
    it('restores the archive moment as a Date', () => {
      setStorageScopeJid('me@example.com')
      chatStore.getState().switchAccount('me@example.com')
      archiveWithHistory()
      flushThrottledStorage()

      _resetForTesting()
      chatStore.getState().switchAccount('me@example.com')

      expect(chatStore.getState().conversationMeta.get(CONV)?.archivedAt).toEqual(new Date(ARCHIVED_AT))
      expect(chatStore.getState().conversations.get(CONV)?.archivedAt).toEqual(new Date(ARCHIVED_AT))
    })

    it('derives the archive moment of a conversation archived before it was recorded from its last message', () => {
      const lastAt = ARCHIVED_AT - 10 * MINUTE
      localStorageMock._store['xmpp-chat-storage:me@example.com'] = JSON.stringify({
        state: {
          conversationEntities: [[CONV, { id: CONV, name: 'Alice', type: 'chat' }]],
          conversationMeta: [[CONV, { unreadCount: 0, lastMessage: message(lastAt) }]],
          archivedConversations: [CONV],
        },
      })
      setStorageScopeJid('me@example.com')
      chatStore.getState().switchAccount('me@example.com')

      expect(chatStore.getState().conversationMeta.get(CONV)?.archivedAt).toEqual(new Date(lastAt))
      chatStore.getState().updateLastMessagePreview(CONV, message(lastAt - MINUTE))
      expect(isArchived()).toBe(true)
      chatStore.getState().addMessage(message(lastAt + MINUTE, { isDelayed: true }), { isLiveArrival: false })
      expect(isArchived()).toBe(false)
    })
  })
})
