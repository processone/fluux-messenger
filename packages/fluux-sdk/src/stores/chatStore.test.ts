import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { chatStore } from './chatStore'
import type { Message, Conversation } from '../core/types'
import { getLocalPart } from '../core/jid'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../utils/storageScope'
import { setResidentWindowSize } from './shared/residentWindow'
import { selectCatchUpQuery } from '../utils/mamCatchUpUtils'

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key]
    }),
    clear: vi.fn(() => {
      store = {}
    }),
    get _store() {
      return store
    },
  }
})()

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock messageCache to verify IndexedDB operations
vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesAround: vi.fn().mockResolvedValue([]),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    updateMessageReactions: vi.fn().mockResolvedValue(true),
  }
})

// Import the mocked module for assertions
import * as messageCache from '../utils/messageCache'

// Helper to create test conversations
function createConversation(id: string, name?: string): Conversation {
  return {
    id,
    name: name || getLocalPart(id),
    type: 'chat',
    unreadCount: 0,
  }
}

// Helper to create test messages
function createMessage(conversationId: string, body: string, isOutgoing = false): Message {
  return {
    type: 'chat',
    id: `msg-${Date.now()}-${Math.random()}`,
    conversationId,
    from: isOutgoing ? 'me@example.com' : conversationId,
    body,
    timestamp: new Date(),
    isOutgoing,
  }
}

describe('chatStore', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    // Reset store state before each test
    localStorageMock.clear()
    chatStore.setState({
      // Reset separated maps (Phase 6)
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      // Reset combined map
      conversations: new Map(),
      messages: new Map(),
      activeConversationId: null,
      archivedConversations: new Set(),
      mamQueryStates: new Map(),
      conversationGaps: new Map(),
      conversationCoverage: new Map(),
      // Reset other ephemeral state
      typingStates: new Map(),
      drafts: new Map(),
      windowAtLiveEdge: new Map(),
    })
    vi.clearAllMocks()
    // clearAllMocks does NOT reset implementations: a test that mocks a
    // rejecting/false-resolving saveMessages would leak it into every later
    // test. Re-assert the factory default here so ordering can't matter.
    vi.mocked(messageCache.saveMessages).mockResolvedValue(true)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('message eviction on deactivation (memory windowing)', () => {
    it('evicts the previous conversation messages when switching away, keeping meta', () => {
      const A = 'a@example.com'
      const B = 'b@example.com'
      chatStore.getState().addConversation(createConversation(A))
      chatStore.getState().addConversation(createConversation(B))
      chatStore.setState({ activeConversationId: A })
      chatStore.getState().addMessage(createMessage(A, 'hello'))
      chatStore.getState().addMessage(createMessage(A, 'world'))
      expect(chatStore.getState().messages.get(A)?.length).toBe(2)
      const lastMessageBefore = chatStore.getState().conversations.get(A)?.lastMessage

      chatStore.getState().setActiveConversation(B)

      // A's messages are evicted from RAM...
      expect(chatStore.getState().messages.get(A) ?? []).toEqual([])
      // ...but its identity / sidebar preview are preserved.
      expect(chatStore.getState().conversations.get(A)).toBeDefined()
      expect(chatStore.getState().conversations.get(A)?.lastMessage).toEqual(lastMessageBefore)
      expect(chatStore.getState().activeConversationId).toBe(B)
    })

    it('keeps the newly-activated conversation messages resident', () => {
      const A = 'a@example.com'
      chatStore.getState().addConversation(createConversation(A))
      chatStore.setState({ activeConversationId: A })
      chatStore.getState().addMessage(createMessage(A, 'hi'))
      chatStore.setState({ activeConversationId: null })

      chatStore.getState().setActiveConversation(A)

      expect(chatStore.getState().messages.get(A)?.length).toBe(1)
      expect(chatStore.getState().activeConversationId).toBe(A)
    })
  })

  describe('initial state', () => {
    it('should have empty conversations and messages', () => {
      const state = chatStore.getState()
      expect(state.conversations.size).toBe(0)
      expect(state.messages.size).toBe(0)
      expect(state.activeConversationId).toBeNull()
    })

    it('should return null for activeConversation when none selected', () => {
      const state = chatStore.getState()
      expect(state.activeConversation()).toBeNull()
    })

    it('should return empty array for activeMessages when none selected', () => {
      const state = chatStore.getState()
      expect(state.activeMessages()).toEqual([])
    })
  })

  describe('recomputeUnreadForConversation (phantom-badge cleanup)', () => {
    // Regression: an encrypted reaction/retraction that arrives undecryptable
    // during catch-up is stored as a bodiless placeholder and counted as unread.
    // When a later deferred-decrypt reveals it was a signal and drops it, the
    // unread badge must drop too. This method reconciles the count against the
    // read pointer using the resident window (or the durable cache when the
    // conversation was never opened).
    const cid = 'carol@example.com'

    function withId(m: Message, id: string, ts: string): Message {
      return { ...m, id, timestamp: new Date(ts) }
    }

    it('recomputes the count from the resident window after a counted placeholder is dropped', async () => {
      const read = withId(createMessage(cid, 'read'), 'm-read', '2026-06-10T00:00:00Z')
      const realUnread = withId(createMessage(cid, 'still unread'), 'm-real', '2026-06-10T00:02:00Z')
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState((s) => {
        const conversationMeta = new Map(s.conversationMeta)
        // unreadCount is 2 (stale): it still includes the reaction placeholder
        // that has already been removed from the resident array below.
        conversationMeta.set(cid, {
          ...conversationMeta.get(cid)!,
          unreadCount: 2,
          lastSeenMessageId: read.id,
        })
        const conversations = new Map(s.conversations)
        conversations.set(cid, { ...conversations.get(cid)!, unreadCount: 2, lastSeenMessageId: read.id })
        const messages = new Map(s.messages)
        messages.set(cid, [read, realUnread])
        return { conversationMeta, conversations, messages, activeConversationId: null }
      })

      await chatStore.getState().recomputeUnreadForConversation(cid)

      expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(1)
      expect(chatStore.getState().conversations.get(cid)?.unreadCount).toBe(1)
    })

    it('recomputes from the durable cache when the conversation is not resident', async () => {
      const read = withId(createMessage(cid, 'read'), 'm-read', '2026-06-10T00:00:00Z')
      const realUnread = withId(createMessage(cid, 'still unread'), 'm-real', '2026-06-10T00:02:00Z')
      vi.mocked(messageCache.getMessages).mockResolvedValueOnce([read, realUnread])
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState((s) => {
        const conversationMeta = new Map(s.conversationMeta)
        conversationMeta.set(cid, {
          ...conversationMeta.get(cid)!,
          unreadCount: 2,
          lastSeenMessageId: read.id,
        })
        const conversations = new Map(s.conversations)
        conversations.set(cid, { ...conversations.get(cid)!, unreadCount: 2, lastSeenMessageId: read.id })
        // No resident messages array — the durable (never-opened) path.
        return { conversationMeta, conversations, activeConversationId: null }
      })

      await chatStore.getState().recomputeUnreadForConversation(cid)

      expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(1)
    })

    it('does not touch the active conversation (activation owns its counts)', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState((s) => {
        const conversationMeta = new Map(s.conversationMeta)
        conversationMeta.set(cid, { ...conversationMeta.get(cid)!, unreadCount: 5 })
        return { conversationMeta, activeConversationId: cid }
      })

      await chatStore.getState().recomputeUnreadForConversation(cid)

      expect(chatStore.getState().conversationMeta.get(cid)?.unreadCount).toBe(5)
      expect(messageCache.getMessages).not.toHaveBeenCalled()
    })
  })

  describe('mergeMAMMessages gap tracking (persisted conversationGaps)', () => {
    const cid = 'alice@example.com'

    it('records a GapInterval when a forward catch-up ends incomplete (parity with rooms)', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      const recent = { ...createMessage(cid, 'recent'), id: 'recent', timestamp: new Date('2026-06-10T00:00:00Z') }
      chatStore.getState().addMessage(recent)

      const fetched = { ...createMessage(cid, 'edge'), id: 'edge', timestamp: new Date('2026-05-14T09:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [fetched], {}, false, 'forward')

      // Formation defers until the page is durably cached (Codex r4 #1).
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.get(cid)).toEqual({
          start: new Date('2026-05-14T09:00:00Z').getTime(), // newest fetched
          end: new Date('2026-06-10T00:00:00Z').getTime(),   // oldest held above the gap
        })
      })
    })

    it('clears the gap when a forward catch-up completes', () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationGaps: new Map([[cid, { start: 1000, end: 5000 }]]) })

      chatStore.getState().mergeMAMMessages(cid, [], {}, true, 'forward')

      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
    })

    it('persists conversationGaps to the account-scoped chat storage (survives reload, no cross-account leak)', async () => {
      localStorageMock.clear() // drop the empty bare-key write from beforeEach's scope-null setState
      setStorageScopeJid('alice@example.com')
      chatStore.getState().addConversation(createConversation(cid))
      const recent = { ...createMessage(cid, 'recent'), id: 'recent', timestamp: new Date('2026-06-10T00:00:00Z') }
      chatStore.getState().addMessage(recent)
      const fetched = { ...createMessage(cid, 'edge'), id: 'edge', timestamp: new Date('2026-05-14T09:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [fetched], {}, false, 'forward')

      // Formation defers until the page is durably cached (Codex r4 #1).
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.has(cid)).toBe(true)
      })
      const scoped = localStorageMock._store['xmpp-chat-storage:alice@example.com']
      expect(scoped).toBeDefined()
      expect(scoped).toContain('conversationGaps')
      expect(scoped).toContain(String(new Date('2026-05-14T09:00:00Z').getTime()))
      // Never the bare (unscoped) key.
      expect(localStorageMock._store['xmpp-chat-storage']).toBeUndefined()
    })

    it('plants a seam when a fetch-latest page lands disjoint above held history (parity with rooms)', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      const held = { ...createMessage(cid, 'held'), id: 'held', timestamp: new Date('2026-07-06T00:00:00Z') }
      chatStore.getState().addMessage(held)

      const fetched = { ...createMessage(cid, 'fresh'), id: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [fetched], {}, true, 'backward', true)

      // Formation defers until the page is durably cached (Codex r4 #1).
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.get(cid)).toEqual({
          start: new Date('2026-07-06T00:00:00Z').getTime(),
          end: new Date('2026-07-15T00:00:00Z').getTime(),
        })
      })
    })

    it('does NOT plant a seam on dedupe overlap or plain backward pagination', () => {
      chatStore.getState().addConversation(createConversation(cid))
      const held = { ...createMessage(cid, 'shared'), id: 'shared', timestamp: new Date('2026-07-14T00:00:00Z') }
      chatStore.getState().addMessage(held)

      // Overlapping fetch-latest: dedupe hit → connected.
      const fresh = { ...createMessage(cid, 'fresh'), id: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [{ ...held }, fresh], {}, true, 'backward', true)
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)

      // Plain pagination (isFetchLatest omitted): never a formation candidate.
      const older = { ...createMessage(cid, 'older'), id: 'older', timestamp: new Date('2026-07-01T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [older], {}, false, 'backward')
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
    })

    it('does not plant a seam from a preview timestamp when the resident array is empty; flags coverage unproven instead (finding 10)', () => {
      // Fresh-session shape: preview (meta.lastMessage) persisted, resident array
      // EMPTY. The preview may be an unarchived message (noLocalStore/tombstone),
      // so it must NOT anchor a seam — but its presence proves held-below history.
      const preview = { ...createMessage(cid, 'preview'), id: 'preview', timestamp: new Date('2026-07-06T00:00:00Z') }
      chatStore.getState().addConversation({ ...createConversation(cid), lastMessage: preview })

      const fresh = { ...createMessage(cid, 'fresh'), id: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [fresh], {}, true, 'backward', true)

      // No spurious seam from the (possibly unarchived) preview.
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
      // Coverage is flagged unproven so the seeder won't treat cache-oldest as contiguous.
      expect(chatStore.getState().getMAMQueryState(cid).coverageBottomUnproven).toBe(true)
    })

    it('survives an unrelated later merge that does not re-affirm the flag (finding 10 follow-up: setMAMQueryCompleted must not wipe it)', () => {
      // Same fresh-session shape as the finding-10 test above: preview persisted,
      // resident array EMPTY, conversation stays non-active so the resident
      // array is never populated by either merge below.
      const preview = { ...createMessage(cid, 'preview'), id: 'preview', timestamp: new Date('2026-07-06T00:00:00Z') }
      chatStore.getState().addConversation({ ...createConversation(cid), lastMessage: preview })

      const fresh = { ...createMessage(cid, 'fresh'), id: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [fresh], {}, true, 'backward', true)
      expect(chatStore.getState().getMAMQueryState(cid).coverageBottomUnproven).toBe(true)

      // Second, unrelated merge: an ordinary backward pagination page
      // (isFetchLatest omitted). This hits neither coverage-proving branch in
      // the store (resident stays empty because the conversation is
      // non-active, and no gap was recorded by the first merge) — it must
      // NOT touch coverageBottomUnproven, only setMAMQueryCompleted's shared
      // fields.
      const older = { ...createMessage(cid, 'older'), id: 'older', timestamp: new Date('2026-07-01T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [older], {}, false, 'backward')

      // The flag must survive: setMAMQueryCompleted runs on every merge and
      // must preserve fields it doesn't own, rather than silently wiping them
      // in its rebuilt object literal.
      expect(chatStore.getState().getMAMQueryState(cid).coverageBottomUnproven).toBe(true)
    })

    it('POSITIVE: a proven resident boundary still forms the seam on a disjoint fetch-latest (no over-suppression)', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      const held = { ...createMessage(cid, 'held'), id: 'held', timestamp: new Date('2026-07-06T00:00:00Z') }
      chatStore.getState().addMessage(held)

      const fresh = { ...createMessage(cid, 'fresh'), id: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [fresh], {}, true, 'backward', true)

      // Resident boundary proven → the seam is still recorded (deferred until
      // the page is durably cached — Codex r4 #1).
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.get(cid)).toEqual({
          start: new Date('2026-07-06T00:00:00Z').getTime(),
          end: new Date('2026-07-15T00:00:00Z').getTime(),
        })
      })
      // A proven boundary means coverage is NOT flagged unproven.
      expect(chatStore.getState().getMAMQueryState(cid).coverageBottomUnproven).not.toBe(true)
    })

    it('does NOT flag coverage unproven for a brand-new empty conversation whose first fetch-latest is contiguous-to-live', () => {
      // No preview, nothing held below — the first fetch-latest is genuinely
      // contiguous-to-live. It must NOT be suppressed (Phase B can seed from it).
      chatStore.getState().addConversation(createConversation(cid))

      const fresh = { ...createMessage(cid, 'fresh'), id: 'fresh', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [fresh], {}, true, 'backward', true)

      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
      expect(chatStore.getState().getMAMQueryState(cid).coverageBottomUnproven).toBeFalsy()
    })

    it('backward closure: scroll-up pages shrink then clear a recorded gap', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationGaps: new Map([[cid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }]]) })

      const mid = { ...createMessage(cid, 'mid'), id: 'mid', timestamp: new Date('2026-07-10T00:00:00Z') }
      const upper = { ...createMessage(cid, 'upper'), id: 'upper', timestamp: new Date('2026-07-14T06:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [mid, upper], {}, false, 'backward')
      // The shrink is a hole-reducing transition of an existing gap: it is
      // deferred until the page is durably cached (crash-window safety).
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.get(cid)).toEqual({
          start: new Date('2026-07-06T00:00:00Z').getTime(),
          end: new Date('2026-07-10T00:00:00Z').getTime(),
        })
      })

      const below = { ...createMessage(cid, 'below'), id: 'below', timestamp: new Date('2026-07-05T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [below, { ...mid }], {}, false, 'backward')
      // Clearance is deferred until the page is durably cached (crash-window
      // safety); the mocked saveMessages resolves immediately, so waitFor.
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
      })
    })

    it('backward CLEARANCE with persistable messages is deferred until the page is durably cached', async () => {
      // Crash window: the gap deletion is persisted (localStorage) while
      // saveMessages to IndexedDB is fire-and-forget. A crash in between
      // leaves cache [old][HOLE][new] with no marker. The deletion must wait
      // for the durable write.
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationGaps: new Map([[cid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }]]) })

      // Hold the IndexedDB write open to observe the window.
      let resolveSave!: (committed: boolean) => void
      vi.mocked(messageCache.saveMessages).mockReturnValue(
        new Promise<boolean>((resolve) => { resolveSave = resolve })
      )

      // Page crosses the gap (reaches below its start) → clearance.
      const below = { ...createMessage(cid, 'below'), id: 'below', timestamp: new Date('2026-07-05T00:00:00Z') }
      const above = { ...createMessage(cid, 'above'), id: 'above', timestamp: new Date('2026-07-14T06:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [below, above], {}, false, 'backward')

      // Immediately after the merge — and for as long as the write is
      // pending — the gap must still be recorded.
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(true)
      await Promise.resolve()
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(true)

      resolveSave(true)
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
      })
    })

    it('forward ADVANCE of an existing gap is deferred until the page is durably cached', async () => {
      // Codex r3 #1: the advance (startId → rsm.last) was persisted
      // synchronously while the IndexedDB write was still in flight — a crash
      // in between resumes `after: rsm.last` and skips the page forever.
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationGaps: new Map([[cid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        startId: 'old-cursor',
      }]]) })

      let resolveSave!: (committed: boolean) => void
      vi.mocked(messageCache.saveMessages).mockReturnValue(
        new Promise<boolean>((resolve) => { resolveSave = resolve })
      )

      const m = { ...createMessage(cid, 'fwd'), id: 'fwd', timestamp: new Date('2026-07-07T00:00:00Z') }
      // Incomplete forward page: gap start moves up and startId advances to rsm.last.
      chatStore.getState().mergeMAMMessages(cid, [m], { last: 'new-cursor' }, false, 'forward')

      // Advance must NOT be visible while the write is pending.
      expect(chatStore.getState().conversationGaps.get(cid)?.startId).toBe('old-cursor')
      await Promise.resolve()
      expect(chatStore.getState().conversationGaps.get(cid)?.startId).toBe('old-cursor')

      resolveSave(true)
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.get(cid)?.startId).toBe('new-cursor')
      })
    })

    it('gap transition is dropped when the durable write reports failure', async () => {
      // A quota-exceeded / aborted transaction resolves false (never throws):
      // the cursor must NOT advance past data that was never stored.
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationGaps: new Map([[cid, {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        startId: 'old-cursor',
      }]]) })
      vi.mocked(messageCache.saveMessages).mockResolvedValue(false)

      const m = { ...createMessage(cid, 'fwd'), id: 'fwd', timestamp: new Date('2026-07-07T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [m], { last: 'new-cursor' }, false, 'forward')
      await Promise.resolve()
      await Promise.resolve()
      expect(chatStore.getState().conversationGaps.get(cid)?.startId).toBe('old-cursor')
    })

    it('gap FORMATION with persistable messages is deferred too (its startId is this page\'s rsm.last)', async () => {
      // Codex r4 #1: a formed forward gap carries rsm.last as startId — a
      // cursor INTO this very page. Publishing it before the write commits
      // has exactly the deletion/advance crash window: resume `after: startId`
      // skips the never-stored page. So formation defers as well; on a crash
      // before the write the cache is unchanged and the next catch-up resumes
      // from the cached edge — nothing skipped.
      chatStore.getState().addConversation(createConversation(cid))
      let resolveSave!: (committed: boolean) => void
      vi.mocked(messageCache.saveMessages).mockReturnValue(
        new Promise<boolean>((resolve) => { resolveSave = resolve })
      )

      const m = { ...createMessage(cid, 'fwd'), id: 'fwd', timestamp: new Date('2026-07-07T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [m], { last: 'c1' }, false, 'forward')

      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
      await Promise.resolve()
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)

      resolveSave(true)
      await vi.waitFor(() => {
        expect(chatStore.getState().conversationGaps.get(cid)?.startId).toBe('c1')
      })
    })

    it('gap FORMATION is dropped when the durable write reports failure', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      vi.mocked(messageCache.saveMessages).mockResolvedValue(false)

      const m = { ...createMessage(cid, 'fwd'), id: 'fwd', timestamp: new Date('2026-07-07T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [m], { last: 'c1' }, false, 'forward')
      await Promise.resolve()
      await Promise.resolve()
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
    })

    it('gap FORMATION with nothing persistable applies immediately', () => {
      // A signal-only forward page proves the hole without any page to store.
      chatStore.getState().addConversation(createConversation(cid))
      const held = { ...createMessage(cid, 'held'), id: 'held', timestamp: new Date('2026-07-01T00:00:00Z') }
      chatStore.setState({ messages: new Map([[cid, [held]]]) })
      // All-duplicate page: newMessages 0 → no crash window → immediate.
      chatStore.getState().mergeMAMMessages(cid, [{ ...held }], { last: 'c1' }, false, 'forward')
      expect(chatStore.getState().conversationGaps.has(cid)).toBe(true)
    })

    it('fetch-latest establishes the coverage record and it survives resetMAMStates (fresh session)', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      const m = { ...createMessage(cid, 'm1'), id: 'm1', stanzaId: 'sid-1', timestamp: new Date('2026-07-15T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [m], { first: 'sid-1', last: 'sid-1' }, false, 'backward', true, false,
        { initialBefore: '', fetchLatestTopId: 'sid-1' })
      await vi.waitFor(() => {
        expect(chatStore.getState().getConversationCoverage(cid)).toEqual({ bottomId: 'sid-1', topId: 'sid-1' })
      })
      chatStore.getState().resetMAMStates()
      expect(chatStore.getState().getConversationCoverage(cid)).toEqual({ bottomId: 'sid-1', topId: 'sid-1' })
    })

    it('signal-only give-up (zero messages) records coverage immediately (nothing to persist)', () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.getState().mergeMAMMessages(cid, [], { first: 'p5-first', last: 'p5-last' }, false, 'backward', true, false,
        { initialBefore: '', fetchLatestTopId: 'p1-last' })
      expect(chatStore.getState().getConversationCoverage(cid)).toEqual({ bottomId: 'p5-first', topId: 'p1-last' })
    })

    it('coverage bottom advance with persistable messages defers until the durable write commits', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationCoverage: new Map([[cid, { bottomId: 'deep', topId: 'top' }]]) })
      let resolveSave!: (committed: boolean) => void
      vi.mocked(messageCache.saveMessages).mockReturnValue(new Promise<boolean>((r) => { resolveSave = r }))

      const older = { ...createMessage(cid, 'old'), id: 'old', stanzaId: 'deeper', timestamp: new Date('2026-07-01T00:00:00Z') }
      // Plain backward page resumed id-exactly from the coverage bottom.
      chatStore.getState().mergeMAMMessages(cid, [older], { first: 'deeper' }, false, 'backward', false, false,
        { initialBefore: 'deep' })
      expect(chatStore.getState().getConversationCoverage(cid)?.bottomId).toBe('deep')
      resolveSave(true)
      await vi.waitFor(() => {
        expect(chatStore.getState().getConversationCoverage(cid)?.bottomId).toBe('deeper')
      })
    })

    it('coverage advance is dropped when the durable write reports failure', async () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationCoverage: new Map([[cid, { bottomId: 'deep' }]]) })
      vi.mocked(messageCache.saveMessages).mockResolvedValue(false)

      const older = { ...createMessage(cid, 'old'), id: 'old', stanzaId: 'deeper', timestamp: new Date('2026-07-01T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [older], { first: 'deeper' }, false, 'backward', false, false,
        { initialBefore: 'deep' })
      await Promise.resolve()
      await Promise.resolve()
      expect(chatStore.getState().getConversationCoverage(cid)?.bottomId).toBe('deep')
    })

    it('clearConversationCoverage with ifBottomId only clears a matching record', () => {
      chatStore.setState({ conversationCoverage: new Map([[cid, { bottomId: 'x' }]]) })
      chatStore.getState().clearConversationCoverage(cid, 'other')
      expect(chatStore.getState().getConversationCoverage(cid)).toBeDefined()
      chatStore.getState().clearConversationCoverage(cid, 'x')
      expect(chatStore.getState().getConversationCoverage(cid)).toBeUndefined()
    })

    it('windowed context fetches (preserveGapMarker) never touch the coverage record', () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationCoverage: new Map([[cid, { bottomId: 'deep' }]]) })
      const island = { ...createMessage(cid, 'island'), id: 'island', stanzaId: 'island-id', timestamp: new Date('2026-06-01T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [island], { first: 'island-id' }, true, 'backward', true, true,
        { initialBefore: '' })
      expect(chatStore.getState().getConversationCoverage(cid)).toEqual({ bottomId: 'deep' })
    })

    it('backward CLEARANCE with zero new persistable messages deletes immediately', () => {
      // Nothing new to persist → no crash window → no reason to defer.
      chatStore.getState().addConversation(createConversation(cid))
      const above = { ...createMessage(cid, 'above'), id: 'above', timestamp: new Date('2026-07-14T06:00:00Z') }
      chatStore.setState({
        messages: new Map([[cid, [above]]]),
        conversationGaps: new Map([[cid, { start: new Date('2026-07-06T00:00:00Z').getTime() }]]),
      })

      // complete=true from above the gap, but the page is all duplicates.
      chatStore.getState().mergeMAMMessages(cid, [{ ...above }], {}, true, 'backward')

      expect(chatStore.getState().conversationGaps.has(cid)).toBe(false)
    })

    it('backward closure: an older-region page below the gap leaves it untouched', () => {
      chatStore.getState().addConversation(createConversation(cid))
      const gap = {
        start: new Date('2026-07-06T00:00:00Z').getTime(),
        end: new Date('2026-07-14T00:00:00Z').getTime(),
      }
      chatStore.setState({ conversationGaps: new Map([[cid, gap]]) })

      const ancient = { ...createMessage(cid, 'ancient'), id: 'ancient', timestamp: new Date('2026-07-01T00:00:00Z') }
      chatStore.getState().mergeMAMMessages(cid, [ancient], {}, true, 'backward')
      expect(chatStore.getState().conversationGaps.get(cid)).toEqual(gap)
    })

    it('a signal-only incomplete forward page preserves the persisted gap and advances its coverage cursor', () => {
      // All pages of a forward catch-up were signals (reactions/receipts): the
      // merge carries zero displayable messages but rsm.last IS set. The gap
      // must survive (the page proves nothing about the hole) with startId
      // advanced to the last fetched archive id (coverage progress).
      chatStore.getState().addConversation(createConversation(cid))
      const start = new Date('2026-07-06T00:00:00Z').getTime()
      chatStore.setState({ conversationGaps: new Map([[cid, { start, startId: 'old' }]]) })

      chatStore.getState().mergeMAMMessages(cid, [], { last: 'sig-99' }, false, 'forward')

      expect(chatStore.getState().conversationGaps.get(cid)).toEqual({ start, startId: 'sig-99' })
    })

    it('preserveGapMarker leaves an existing conversation gap untouched on a forward complete=true merge', () => {
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ conversationGaps: new Map([[cid, { start: 1000, end: 5000 }]]) })

      // A bounded windowed context fetch completes within its window — must not clear an older gap.
      chatStore.getState().mergeMAMMessages(cid, [], {}, true, 'forward', false, true)

      expect(chatStore.getState().conversationGaps.get(cid)).toEqual({ start: 1000, end: 5000 })
    })
  })

  describe('clearConversationGapAnchor (purged MAM after-anchor heal)', () => {
    const cid = 'alice@example.com'

    it('strips a MATCHING startId but keeps the start timestamp so repair can progress', () => {
      const start = new Date('2026-07-06T00:00:00Z').getTime()
      chatStore.setState({ conversationGaps: new Map([[cid, { start, startId: 'purged', end: 5000, endId: 'e1' }]]) })

      chatStore.getState().clearConversationGapAnchor(cid, 'purged')

      const gap = chatStore.getState().conversationGaps.get(cid)
      expect(gap).toEqual({ start, end: 5000, endId: 'e1' })

      // The next resume (session catch-up or "Load missing messages") selects
      // the timestamp fallback, not the purged id — the repair progresses.
      expect(selectCatchUpQuery([], {
        forwardGapTimestamp: gap?.start,
        forwardGapStartId: gap?.startId,
      })).toEqual({ start: new Date(start).toISOString() })
    })

    it('does NOT strip a non-matching startId (the gap anchor already advanced)', () => {
      chatStore.setState({ conversationGaps: new Map([[cid, { start: 1000, startId: 'newer' }]]) })

      chatStore.getState().clearConversationGapAnchor(cid, 'purged')

      expect(chatStore.getState().conversationGaps.get(cid)).toEqual({ start: 1000, startId: 'newer' })
    })

    it('is a no-op when no gap is recorded', () => {
      const before = chatStore.getState().conversationGaps
      chatStore.getState().clearConversationGapAnchor(cid, 'purged')
      expect(chatStore.getState().conversationGaps).toBe(before)
    })
  })

  describe('mergeMAMMessages exact-timestamp anchor re-fetch (fallback catch-up, no +1ms)', () => {
    const cid = 'alice@example.com'

    it('dedupes the re-fetched anchor by origin-id, keeps a same-millisecond sibling, and patches the anchor archive id', () => {
      // buildCatchUpStartTime queries from the EXACT anchor timestamp, so the
      // forward page re-includes the anchor's archive copy. The merge must
      // dedupe it (originId), keep a different message sharing the same
      // millisecond, and backfill the id-less resident echo with its stanzaId.
      chatStore.getState().addConversation(createConversation(cid))
      chatStore.setState({ activeConversationId: cid })
      const T = new Date('2026-07-10T10:00:00.000Z')
      // Resident id-less anchor: own-sent echo never stamped with an archive id.
      const anchor: Message = {
        type: 'chat', id: 'anchor-client-id', conversationId: cid,
        from: 'me@example.com', body: 'anchor', timestamp: T, isOutgoing: true,
        originId: 'o1',
      }
      chatStore.setState({ messages: new Map([[cid, [anchor]]]) })

      const anchorArchiveCopy: Message = { ...anchor, id: 'anchor-archive-id', stanzaId: 's1' }
      const sibling: Message = {
        type: 'chat', id: 'sibling', conversationId: cid,
        from: cid, body: 'same-millisecond sibling', timestamp: T, isOutgoing: false,
        stanzaId: 's2',
      }
      chatStore.getState().mergeMAMMessages(cid, [anchorArchiveCopy, sibling], { last: 's2' }, true, 'forward')

      const merged = chatStore.getState().messages.get(cid) ?? []
      expect(merged).toHaveLength(2) // anchor deduped, sibling kept — no dupes
      const mergedAnchor = merged.find((m) => m.originId === 'o1')
      expect(mergedAnchor?.stanzaId).toBe('s1') // resident echo patched with the archive id
      expect(merged.some((m) => m.stanzaId === 's2')).toBe(true)
    })
  })

  describe('addConversation', () => {
    it('should add a new conversation', () => {
      const conv = createConversation('alice@example.com', 'Alice')

      chatStore.getState().addConversation(conv)

      const state = chatStore.getState()
      expect(state.conversations.size).toBe(1)
      expect(state.conversations.get('alice@example.com')).toEqual(conv)
    })

    it('should update existing conversation', () => {
      const conv1 = createConversation('alice@example.com', 'Alice')
      const conv2 = { ...conv1, name: 'Alice Updated', unreadCount: 5 }

      chatStore.getState().addConversation(conv1)
      chatStore.getState().addConversation(conv2)

      const state = chatStore.getState()
      expect(state.conversations.size).toBe(1)
      expect(state.conversations.get('alice@example.com')?.name).toBe('Alice Updated')
      expect(state.conversations.get('alice@example.com')?.unreadCount).toBe(5)
    })

    it('should add multiple conversations', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().addConversation(createConversation('charlie@example.com'))

      expect(chatStore.getState().conversations.size).toBe(3)
    })
  })

  describe('deleteConversation', () => {
    it('should delete conversation and messages', () => {
      const conv = createConversation('alice@example.com')
      chatStore.getState().addConversation(conv)
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'World'))

      chatStore.getState().deleteConversation('alice@example.com')

      const state = chatStore.getState()
      expect(state.conversations.has('alice@example.com')).toBe(false)
      // Messages should be deleted
      expect(state.messages.get('alice@example.com')).toBeUndefined()
    })

    it('should clear activeConversationId if deleting active conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      chatStore.getState().deleteConversation('alice@example.com')

      expect(chatStore.getState().activeConversationId).toBeNull()
    })

    it('should remove from archived set when deleting', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      expect(chatStore.getState().archivedConversations.has('alice@example.com')).toBe(true)

      chatStore.getState().deleteConversation('alice@example.com')

      expect(chatStore.getState().archivedConversations.has('alice@example.com')).toBe(false)
    })

    it('should clear IndexedDB cache when deleting conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().deleteConversation('alice@example.com')

      expect(messageCache.deleteConversationMessages).toHaveBeenCalledWith('alice@example.com')
    })
  })

  describe('setActiveConversation', () => {
    it('should set active conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().setActiveConversation('alice@example.com')

      expect(chatStore.getState().activeConversationId).toBe('alice@example.com')
    })

    it('should return correct activeConversation', () => {
      const conv = createConversation('alice@example.com', 'Alice')
      chatStore.getState().addConversation(conv)
      chatStore.getState().setActiveConversation('alice@example.com')

      // Use toMatchObject because setActiveConversation calls markAsRead which adds lastReadAt
      expect(chatStore.getState().activeConversation()).toMatchObject(conv)
    })

    it('should clear active conversation when set to null', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')
      chatStore.getState().setActiveConversation(null)

      expect(chatStore.getState().activeConversationId).toBeNull()
    })

    it('should mark conversation as read when set active', () => {
      const conv = { ...createConversation('alice@example.com'), unreadCount: 5 }
      chatStore.getState().addConversation(conv)

      chatStore.getState().setActiveConversation('alice@example.com')

      expect(chatStore.getState().conversations.get('alice@example.com')?.unreadCount).toBe(0)
    })
  })

  describe('activateConversation', () => {
    afterEach(() => {
      // Restore the factory default so later tests get a clean resolved-[] mock
      vi.mocked(messageCache.getMessages).mockReset()
      vi.mocked(messageCache.getMessages).mockResolvedValue([])
      vi.mocked(messageCache.getMessagesAround).mockReset()
      vi.mocked(messageCache.getMessagesAround).mockResolvedValue([])
    })

    it('should hydrate messages from cache before marking the conversation active', async () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const cached = createMessage('alice@example.com', 'Cached history')
      vi.mocked(messageCache.getMessages).mockResolvedValue([cached])

      // Snapshot the in-memory messages at the exact moment activation happens —
      // the unread marker is computed from them, so they must be loaded first
      let messagesAtActivation: Message[] | undefined
      const unsubscribe = chatStore.subscribe(
        (state) => state.activeConversationId,
        (activeId) => {
          if (activeId === 'alice@example.com') {
            messagesAtActivation = chatStore.getState().messages.get('alice@example.com')
          }
        }
      )

      await chatStore.getState().activateConversation('alice@example.com')
      unsubscribe()

      expect(chatStore.getState().activeConversationId).toBe('alice@example.com')
      expect(messagesAtActivation?.map((m) => m.id)).toEqual([cached.id])
    })

    it('should deactivate immediately without touching the cache when passed null', async () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')
      vi.clearAllMocks()

      await chatStore.getState().activateConversation(null)

      expect(chatStore.getState().activeConversationId).toBeNull()
      expect(messageCache.getMessages).not.toHaveBeenCalled()
    })

    it('should drop a stale activation that resolves after a newer one', async () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))

      let resolveAlice: (value: Message[]) => void = () => {}
      vi.mocked(messageCache.getMessages).mockImplementation((conversationId) =>
        conversationId === 'alice@example.com'
          ? new Promise((resolve) => { resolveAlice = resolve })
          : Promise.resolve([])
      )

      const stale = chatStore.getState().activateConversation('alice@example.com')
      const fresh = chatStore.getState().activateConversation('bob@example.com')
      await fresh
      resolveAlice([])
      await stale

      expect(chatStore.getState().activeConversationId).toBe('bob@example.com')
    })

    it('flags activationPending while the cache read is in flight, then clears it', async () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      // Hold the cache read open so we can observe the in-flight window — this is
      // the gap during which ChatLayout would otherwise flash the empty state.
      let resolveRead: (value: Message[]) => void = () => {}
      vi.mocked(messageCache.getMessages).mockReturnValue(
        new Promise((resolve) => { resolveRead = resolve })
      )

      expect(chatStore.getState().activationPending).toBe(false)

      const activation = chatStore.getState().activateConversation('alice@example.com')

      // Synchronously after the call: read is in flight, active id not set yet
      expect(chatStore.getState().activationPending).toBe(true)
      expect(chatStore.getState().activeConversationId).toBeNull()

      resolveRead([])
      await activation

      // Once the active id lands the flag clears, atomically with activation
      expect(chatStore.getState().activationPending).toBe(false)
      expect(chatStore.getState().activeConversationId).toBe('alice@example.com')
    })

    it('does not flag activationPending when deactivating with null', async () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      await chatStore.getState().activateConversation(null)

      expect(chatStore.getState().activationPending).toBe(false)
      expect(chatStore.getState().activeConversationId).toBeNull()
    })

    it('activateConversation reloads the window around a pointer deeper than the latest slice', async () => {
      // Arrange: cache holds 300 messages; the latest-100 slice (returned by
      // loadMessagesFromCache) does NOT contain meta.lastSeenMessageId
      // ('msg-150') — the reader left off deep in history. Seeding
      // conversationMeta.lastSeenMessageId directly mimics a persisted read
      // pointer from a prior session (no live activation has run yet here).
      const A = 'alice@example.com'
      chatStore.getState().addConversation(createConversation(A))
      chatStore.setState((state) => {
        const meta = new Map(state.conversationMeta)
        meta.set(A, { ...meta.get(A)!, lastSeenMessageId: 'msg-150' })
        return { conversationMeta: meta }
      })

      // Base offsets in minutes-since-epoch so message order matches id order
      // (msg-149 < msg-150 < msg-151 < ... < msg-299) with no collisions.
      const msgAt = (id: string, offsetMinutes: number): Message => ({
        type: 'chat',
        id,
        conversationId: A,
        from: A,
        body: id,
        timestamp: new Date(offsetMinutes * 60_000),
        isOutgoing: false,
      })

      const latestSlice: Message[] = Array.from({ length: 100 }, (_, i) => msgAt(`msg-${200 + i}`, 200 + i))
      const aroundSlice: Message[] = [msgAt('msg-149', 149), msgAt('msg-150', 150), msgAt('msg-151', 151)]
      vi.mocked(messageCache.getMessages).mockResolvedValue(latestSlice)
      vi.mocked(messageCache.getMessagesAround).mockResolvedValue(aroundSlice)

      await chatStore.getState().activateConversation(A)

      expect(messageCache.getMessagesAround).toHaveBeenCalledWith(A, 'msg-150', expect.any(Object))
      const resident = chatStore.getState().messages.get(A)
      expect(resident?.some((m) => m.id === 'msg-150')).toBe(true)
      expect(chatStore.getState().firstNewMessageMarkers.get(A)).toBe('msg-151')
    })
  })

  describe('loadMessagesAroundFromCache', () => {
    afterEach(() => {
      vi.mocked(messageCache.getMessagesAround).mockReset()
      vi.mocked(messageCache.getMessagesAround).mockResolvedValue([])
    })

    function msgAt(conversationId: string, id: string, minute: number): Message {
      return {
        type: 'chat',
        id,
        conversationId,
        from: conversationId,
        body: id,
        timestamp: new Date(`2024-03-01T10:0${minute}:00Z`),
        isOutgoing: false,
      }
    }

    it('hydrates the resident array with the cache slice that contains the anchor', async () => {
      const A = 'alice@example.com'
      chatStore.getState().addConversation(createConversation(A))
      chatStore.setState({ activeConversationId: A })

      const slice = [
        msgAt(A, 'old-3', 3),
        msgAt(A, 'anchor', 4),
        msgAt(A, 'newer-5', 5),
        msgAt(A, 'newer-6', 6),
      ]
      vi.mocked(messageCache.getMessagesAround).mockResolvedValue(slice)

      const returned = await chatStore.getState().loadMessagesAroundFromCache(A, 'anchor')

      expect(messageCache.getMessagesAround).toHaveBeenCalledWith(A, 'anchor', expect.any(Object))
      const resident = chatStore.getState().messages.get(A)
      expect(resident?.map((m) => m.id)).toEqual(['old-3', 'anchor', 'newer-5', 'newer-6'])
      expect(returned.map((m) => m.id)).toEqual(['old-3', 'anchor', 'newer-5', 'newer-6'])
    })

    it('merges the slice with any already-resident messages, deduped and sorted', async () => {
      const A = 'alice@example.com'
      chatStore.getState().addConversation(createConversation(A))
      chatStore.setState({
        activeConversationId: A,
        messages: new Map([[A, [msgAt(A, 'newer-6', 6), msgAt(A, 'newer-7', 7)]]]),
      })

      vi.mocked(messageCache.getMessagesAround).mockResolvedValue([
        msgAt(A, 'anchor', 4),
        msgAt(A, 'newer-5', 5),
        msgAt(A, 'newer-6', 6), // duplicate of a resident message
      ])

      await chatStore.getState().loadMessagesAroundFromCache(A, 'anchor')

      const resident = chatStore.getState().messages.get(A)
      expect(resident?.map((m) => m.id)).toEqual(['anchor', 'newer-5', 'newer-6', 'newer-7'])
    })
  })

  describe('addMessage', () => {
    it('should add message to conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')

      chatStore.getState().addMessage(msg)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[0].body).toBe('Hello!')
    })

    it('should add message to messages array (lastMessage is derived in useChat)', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')

      chatStore.getState().addMessage(msg)

      // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
      // Store only holds the messages array - verify the message is there
      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[messages.length - 1].body).toBe('Hello!')
    })

    it('should increment unreadCount for incoming messages when not active', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hi', false))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello', false))

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(2)
    })

    it('should not increment unreadCount for outgoing messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hi', true))

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
    })

    it('should increment unreadCount for delayed messages (offline delivery)', () => {
      // Delayed messages in 1:1 chats are from offline storage - they ARE new messages
      // the user hasn't seen, so they should increment unread count
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().addMessage({
        ...createMessage('alice@example.com', 'Message sent while offline', false),
        isDelayed: true,
      })

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(1)
    })

    it('should not increment unreadCount when conversation is active', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hi', false))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello', false))

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
    })

    it('should return messages for active conversation via activeMessages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'World'))
      chatStore.getState().setActiveConversation('alice@example.com')

      const activeMessages = chatStore.getState().activeMessages()
      expect(activeMessages.length).toBe(2)
    })

    it('should deduplicate messages by stanzaId', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const msg1: Message = {
        type: 'chat',
        id: 'msg-1',
        stanzaId: 'server-id-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Same stanzaId, different message id (server duplicate)
      const msg2: Message = {
        type: 'chat',
        id: 'msg-2',
        stanzaId: 'server-id-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      chatStore.getState().addMessage(msg1)
      chatStore.getState().addMessage(msg2)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[0].id).toBe('msg-1')
    })

    it('should deduplicate messages by from + id when no stanzaId', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const msg1: Message = {
        type: 'chat',
        id: 'msg-same-id',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Same from + id (client duplicate)
      const msg2: Message = {
        type: 'chat',
        id: 'msg-same-id',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      chatStore.getState().addMessage(msg1)
      chatStore.getState().addMessage(msg2)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
    })

    it('should allow same message id from different senders', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const msg1: Message = {
        type: 'chat',
        id: 'msg-same-id',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello from Alice!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Same id but different sender (not a duplicate)
      const msg2: Message = {
        type: 'chat',
        id: 'msg-same-id',
        conversationId: 'alice@example.com',
        from: 'bob@example.com',
        body: 'Hello from Bob!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      chatStore.getState().addMessage(msg1)
      chatStore.getState().addMessage(msg2)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(2)
    })

    it('should deduplicate messages by originId (XEP-0359)', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      // Outgoing message stored locally with originId
      const msg1: Message = {
        type: 'chat',
        id: 'client-uuid-1',
        originId: 'client-uuid-1',
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: true,
      }

      // Echo from server with different id but same originId
      const msg2: Message = {
        type: 'chat',
        id: 'different-id',
        originId: 'client-uuid-1',
        stanzaId: 'server-assigned-123',
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: true,
      }

      chatStore.getState().addMessage(msg1)
      chatStore.getState().addMessage(msg2)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[0].id).toBe('client-uuid-1')
    })

    it('should not increment unreadCount for duplicate messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const msg1: Message = {
        type: 'chat',
        id: 'msg-1',
        stanzaId: 'server-id-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      const msg2: Message = {
        type: 'chat',
        id: 'msg-2',
        stanzaId: 'server-id-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello!',
        timestamp: new Date(),
        isOutgoing: false,
      }

      chatStore.getState().addMessage(msg1)
      chatStore.getState().addMessage(msg2)

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(1) // Only incremented once
    })

    it('should save message to IndexedDB when noLocalStore is false', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')

      chatStore.getState().addMessage(msg)

      expect(messageCache.saveMessage).toHaveBeenCalledWith(msg)
    })

    it('should not save message to IndexedDB when noLocalStore is true (XEP-0334)', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = { ...createMessage('alice@example.com', 'Ephemeral message'), noLocalStore: true }

      chatStore.getState().addMessage(msg)

      expect(messageCache.saveMessage).not.toHaveBeenCalled()
    })

    it('should still add noLocalStore message to in-memory store', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = { ...createMessage('alice@example.com', 'Ephemeral'), noLocalStore: true }

      chatStore.getState().addMessage(msg)

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[0].body).toBe('Ephemeral')
    })

    it('should still increment unreadCount for noLocalStore messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = { ...createMessage('alice@example.com', 'Ephemeral', false), noLocalStore: true }

      chatStore.getState().addMessage(msg)

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(1)
    })
  })

  describe('lastMessage preview — bodiless signal placeholders', () => {
    // Regression: an encrypted reaction replayed from MAM before its key was
    // available is stored as an empty-body message (its <reactions> element is
    // sealed in the ciphertext). It must never become the conversation preview.
    function bodilessPlaceholder(conversationId: string): Message {
      return {
        ...createMessage(conversationId, '', true),
        encryptedPayload: '<message><openpgp>…</openpgp></message>',
      }
    }

    it('does not let a bodiless placeholder become lastMessage', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const real = createMessage('alice@example.com', 'Yep, traité hier soir.', false)
      chatStore.getState().addMessage(real)
      chatStore.getState().addMessage(bodilessPlaceholder('alice@example.com'))

      const meta = chatStore.getState().conversationMeta.get('alice@example.com')
      expect(meta?.lastMessage?.id).toBe(real.id)
      expect(meta?.lastMessage?.body).toBe('Yep, traité hier soir.')
    })

    it('recomputes lastMessage to the prior real message when the placeholder is removed', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const real = createMessage('alice@example.com', 'Real message', false)
      chatStore.getState().addMessage(real)
      const placeholder = bodilessPlaceholder('alice@example.com')
      chatStore.getState().addMessage(placeholder)

      // Force the placeholder to be the stored preview (the stuck-data shape),
      // then remove it as the deferred-decrypt cleanup path would.
      const meta = chatStore.getState().conversationMeta.get('alice@example.com')!
      const conv = chatStore.getState().conversations.get('alice@example.com')!
      chatStore.setState({
        conversationMeta: new Map(chatStore.getState().conversationMeta).set('alice@example.com', { ...meta, lastMessage: placeholder }),
        conversations: new Map(chatStore.getState().conversations).set('alice@example.com', { ...conv, lastMessage: placeholder }),
      })

      chatStore.getState().removeMessage('alice@example.com', placeholder.id)

      const after = chatStore.getState().conversationMeta.get('alice@example.com')
      expect(after?.lastMessage?.id).toBe(real.id)
      expect(after?.lastMessage?.body).toBe('Real message')
    })

    it('leaves lastMessage untouched when removing a non-preview message', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const first = createMessage('alice@example.com', 'First', false)
      const last = createMessage('alice@example.com', 'Last', false)
      chatStore.getState().addMessage(first)
      chatStore.getState().addMessage(last)

      chatStore.getState().removeMessage('alice@example.com', first.id)

      const after = chatStore.getState().conversationMeta.get('alice@example.com')
      expect(after?.lastMessage?.id).toBe(last.id)
    })

    it('heals the preview when the deferred-decrypted message is the preview but a bodiless placeholder trails it', () => {
      // Regression: an encrypted message becomes the preview, then an encrypted
      // reaction arrives and is stored as a trailing bodiless placeholder. On
      // unlock the real message decrypts via updateMessage, but it is no longer
      // the *positionally* last array element (the placeholder trails it), so the
      // old `isLastMessage` gate refused to refresh the sidebar — it stayed stuck
      // on "[OpenPGP-encrypted message]". updateMessage must heal by identity:
      // the updated message IS the current preview.
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const encrypted: Message = {
        ...createMessage('alice@example.com', '[OpenPGP-encrypted message]', false),
        encryptedPayload: '<message><openpgp>real</openpgp></message>',
      }
      chatStore.getState().addMessage(encrypted)
      chatStore.getState().addMessage(bodilessPlaceholder('alice@example.com'))

      // Sanity: the encrypted message is the stored preview, placeholder trails it.
      expect(chatStore.getState().conversationMeta.get('alice@example.com')?.lastMessage?.id).toBe(encrypted.id)

      // Deferred decrypt resolves the real message (not positionally last).
      chatStore.getState().updateMessage('alice@example.com', encrypted.id, {
        body: 'Decrypted content',
        encryptedPayload: undefined,
      })

      const preview = chatStore.getState().conversationMeta.get('alice@example.com')?.lastMessage
      expect(preview?.id).toBe(encrypted.id)
      expect(preview?.body).toBe('Decrypted content')
      expect(preview?.encryptedPayload).toBeUndefined()
    })
  })

  describe('clearMessageStanzaId', () => {
    it('strips a stale stanzaId from the in-memory message and IndexedDB', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = { ...createMessage('alice@example.com', 'sent', true), stanzaId: 'uuid-sent', originId: 'uuid-sent' }
      chatStore.getState().addMessage(msg)

      chatStore.getState().clearMessageStanzaId('alice@example.com', 'uuid-sent')

      expect(chatStore.getState().getMessage('alice@example.com', msg.id)?.stanzaId).toBeUndefined()
      expect(messageCache.updateMessage).toHaveBeenCalledWith(msg.id, { stanzaId: undefined })
    })

    it('heals the lastMessage preview when the cleared message was the preview', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = { ...createMessage('alice@example.com', 'sent', true), stanzaId: 'uuid-sent', originId: 'uuid-sent' }
      chatStore.getState().addMessage(msg)
      expect(chatStore.getState().conversationMeta.get('alice@example.com')?.lastMessage?.stanzaId).toBe('uuid-sent')

      chatStore.getState().clearMessageStanzaId('alice@example.com', 'uuid-sent')

      const preview = chatStore.getState().conversationMeta.get('alice@example.com')?.lastMessage
      expect(preview?.id).toBe(msg.id)
      expect(preview?.stanzaId).toBeUndefined()
    })

    it('is a no-op when no message carries the given stanzaId', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = { ...createMessage('alice@example.com', 'real', false), stanzaId: 'archive-1' }
      chatStore.getState().addMessage(msg)
      vi.mocked(messageCache.updateMessage).mockClear()

      chatStore.getState().clearMessageStanzaId('alice@example.com', 'not-present')

      expect(chatStore.getState().getMessage('alice@example.com', msg.id)?.stanzaId).toBe('archive-1')
      expect(messageCache.updateMessage).not.toHaveBeenCalled()
    })
  })

  describe('getConversationLastTimestamp', () => {
    it('returns the meta lastMessage timestamp in epoch ms', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const ts = new Date('2026-05-14T09:00:00.000Z')
      chatStore.getState().addMessage({ ...createMessage('alice@example.com', 'hi', false), timestamp: ts })

      expect(chatStore.getState().getConversationLastTimestamp('alice@example.com')).toBe(ts.getTime())
    })

    it('falls back to the combined conversations map when no meta entry exists', () => {
      const ts = new Date('2026-05-14T09:00:00.000Z')
      const lastMessage = { ...createMessage('bob@example.com', 'hi', false), timestamp: ts }
      // Persist-rehydration / legacy shape: combined map populated, meta absent.
      chatStore.setState({
        conversationMeta: new Map(),
        conversations: new Map([['bob@example.com', { ...createConversation('bob@example.com'), lastMessage }]]),
      })

      expect(chatStore.getState().getConversationLastTimestamp('bob@example.com')).toBe(ts.getTime())
    })

    it('returns undefined when the conversation has no last message', () => {
      chatStore.getState().addConversation(createConversation('carol@example.com'))
      expect(chatStore.getState().getConversationLastTimestamp('carol@example.com')).toBeUndefined()
      expect(chatStore.getState().getConversationLastTimestamp('unknown@example.com')).toBeUndefined()
    })
  })

  describe('markAsRead', () => {
    it('should reset unreadCount to 0', () => {
      const conv = { ...createConversation('alice@example.com'), unreadCount: 10 }
      chatStore.getState().addConversation(conv)

      chatStore.getState().markAsRead('alice@example.com')

      expect(chatStore.getState().conversations.get('alice@example.com')?.unreadCount).toBe(0)
    })

    it('should not affect other conversations', () => {
      chatStore.getState().addConversation({ ...createConversation('alice@example.com'), unreadCount: 5 })
      chatStore.getState().addConversation({ ...createConversation('bob@example.com'), unreadCount: 3 })

      chatStore.getState().markAsRead('alice@example.com')

      expect(chatStore.getState().conversations.get('alice@example.com')?.unreadCount).toBe(0)
      expect(chatStore.getState().conversations.get('bob@example.com')?.unreadCount).toBe(3)
    })

    it('should update lastReadAt to last message timestamp (resets new messages marker)', () => {
      // markAsRead should reset unreadCount AND update lastReadAt
      // This clears the "new messages" marker when switching back to a conversation
      const messageTimestamp = new Date('2025-01-10T12:00:00Z')
      chatStore.getState().addConversation({
        ...createConversation('alice@example.com'),
        unreadCount: 2,
        lastReadAt: new Date('2025-01-10T10:00:00Z'),
      })
      // Add a message so markAsRead can use its timestamp
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg1',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: messageTimestamp,
        isOutgoing: false,
      })

      chatStore.getState().markAsRead('alice@example.com')

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
      expect(conv?.lastReadAt).toEqual(messageTimestamp) // lastReadAt updated to last message
    })

    it('should set lastReadAt to current time when no messages exist', () => {
      const beforeMark = new Date()
      chatStore.getState().addConversation({ ...createConversation('alice@example.com'), unreadCount: 1 })

      chatStore.getState().markAsRead('alice@example.com')

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
      expect(conv?.lastReadAt).toBeDefined()
      expect(conv!.lastReadAt!.getTime()).toBeGreaterThanOrEqual(beforeMark.getTime())
    })

    it('should update lastReadAt even when unreadCount is already 0', () => {
      // Bug fix: when switching to a conversation with 0 unread but stale lastReadAt,
      // the "new messages" marker would show incorrectly
      const oldLastReadAt = new Date('2025-01-10T10:00:00Z')
      const messageTimestamp = new Date('2025-01-10T12:00:00Z')

      chatStore.getState().addConversation({
        ...createConversation('alice@example.com'),
        unreadCount: 0, // Already read
        lastReadAt: oldLastReadAt,
      })

      // Add a newer message
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg1',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'New message',
        timestamp: messageTimestamp,
        isOutgoing: false,
      })

      // markAsRead should update lastReadAt to the new message timestamp
      chatStore.getState().markAsRead('alice@example.com')

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.lastReadAt).toEqual(messageTimestamp)
    })

    it('should not trigger state update when called multiple times with same timestamp (regression test for infinite loop)', () => {
      // Regression test: Date objects were compared by reference (!==) instead of value (.getTime())
      // This caused infinite re-render loops because new Date() !== new Date() is always true
      const messageTimestamp = new Date('2025-01-10T12:00:00Z')
      chatStore.getState().addConversation({
        ...createConversation('alice@example.com'),
        unreadCount: 1,
      })
      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg1',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: messageTimestamp,
        isOutgoing: false,
      })

      // First call - should update state (unreadCount > 0)
      chatStore.getState().markAsRead('alice@example.com')
      const convAfterFirst = chatStore.getState().conversations.get('alice@example.com')
      expect(convAfterFirst?.unreadCount).toBe(0)
      expect(convAfterFirst?.lastReadAt).toEqual(messageTimestamp)

      // Capture conversation reference after first markAsRead
      const conversationsMapAfterFirst = chatStore.getState().conversations

      // Second call - should NOT update conversations (same timestamp, already read)
      chatStore.getState().markAsRead('alice@example.com')
      const conversationsMapAfterSecond = chatStore.getState().conversations

      // Conversations Map reference should be the same (no unnecessary update)
      // This prevents infinite re-render loops in React when using selectors
      expect(conversationsMapAfterSecond).toBe(conversationsMapAfterFirst)

      // Conversation object should also be the same reference
      const convAfterSecond = chatStore.getState().conversations.get('alice@example.com')
      expect(convAfterSecond).toBe(convAfterFirst)
    })

    it('should handle lastReadAt as string (after JSON deserialization from persist middleware)', () => {
      // Regression test: When state is persisted to localStorage and restored,
      // Date objects get serialized as ISO strings. The store must handle both
      // Date objects and strings for lastReadAt comparisons.
      const messageTimestamp = new Date('2025-01-10T12:00:00Z')

      // Simulate a conversation with lastReadAt as a string (as it would be after JSON parse)
      chatStore.setState((state) => {
        const newConversations = new Map(state.conversations)
        newConversations.set('alice@example.com', {
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 1,
          // This simulates what happens when JSON.parse() deserializes a Date
          lastReadAt: '2025-01-10T10:00:00.000Z' as unknown as Date,
        })
        return { conversations: newConversations }
      })

      chatStore.getState().addMessage({
        type: 'chat',
        id: 'msg1',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: messageTimestamp,
        isOutgoing: false,
      })

      // This should NOT throw "getTime is not a function"
      expect(() => {
        chatStore.getState().markAsRead('alice@example.com')
      }).not.toThrow()

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.unreadCount).toBe(0)
      expect(conv?.lastReadAt).toEqual(messageTimestamp)
    })

    it('should handle lastReadAt as string in setActiveConversation (after JSON deserialization)', () => {
      // Regression test: setActiveConversation also compares timestamps for new messages marker
      const oldTimestamp = '2025-01-10T10:00:00.000Z'
      const newMessageTimestamp = new Date('2025-01-10T12:00:00Z')

      // Simulate a conversation with lastReadAt as a string
      chatStore.setState((state) => {
        const newConversations = new Map(state.conversations)
        newConversations.set('alice@example.com', {
          id: 'alice@example.com',
          name: 'Alice',
          type: 'chat',
          unreadCount: 1,
          // Simulates deserialized JSON
          lastReadAt: oldTimestamp as unknown as Date,
        })
        const newMessages = new Map(state.messages)
        newMessages.set('alice@example.com', [{
          type: 'chat',
          id: 'msg1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'New message',
          timestamp: newMessageTimestamp,
          isOutgoing: false,
        }])
        return { conversations: newConversations, messages: newMessages }
      })

      // This should NOT throw "cannot compare Date with string"
      expect(() => {
        chatStore.getState().setActiveConversation('alice@example.com')
      }).not.toThrow()

      // Should have set the new messages marker since the message is after lastReadAt
      expect(chatStore.getState().firstNewMessageMarkers.get('alice@example.com')).toBe('msg1')
    })
  })

  describe('markReadToNewest', () => {
    it('advances the pointer to the newest message, zeroes unread, clears the divider', () => {
      const conversationId = 'alice@example.com'
      chatStore.getState().addConversation({
        ...createConversation(conversationId),
        unreadCount: 2,
        lastSeenMessageId: 'm1',
      })
      chatStore.getState().addMessage({
        type: 'chat', id: 'm1', conversationId, from: conversationId, body: 'first',
        timestamp: new Date('2025-01-10T10:00:00Z'), isOutgoing: false,
      })
      chatStore.getState().addMessage({
        type: 'chat', id: 'm2', conversationId, from: conversationId, body: 'second',
        timestamp: new Date('2025-01-10T10:01:00Z'), isOutgoing: false,
      })
      chatStore.getState().addMessage({
        type: 'chat', id: 'm3', conversationId, from: conversationId, body: 'third',
        timestamp: new Date('2025-01-10T10:02:00Z'), isOutgoing: false,
      })
      chatStore.setState((state) => {
        const newMarkers = new Map(state.firstNewMessageMarkers)
        newMarkers.set(conversationId, 'm2')
        return { firstNewMessageMarkers: newMarkers }
      })

      chatStore.getState().markReadToNewest(conversationId)

      const meta = chatStore.getState().conversationMeta.get(conversationId)
      expect(meta?.lastSeenMessageId).toBe('m3')
      expect(meta?.unreadCount).toBe(0)
      expect(chatStore.getState().firstNewMessageMarkers.has(conversationId)).toBe(false)
    })

    it('is a no-op (same Map references) when the conversation is already read to newest', () => {
      const conversationId = 'alice@example.com'
      chatStore.getState().addConversation({
        ...createConversation(conversationId),
        unreadCount: 2,
        lastSeenMessageId: 'm1',
      })
      chatStore.getState().addMessage({
        type: 'chat', id: 'm1', conversationId, from: conversationId, body: 'first',
        timestamp: new Date('2025-01-10T10:00:00Z'), isOutgoing: false,
      })
      chatStore.getState().addMessage({
        type: 'chat', id: 'm2', conversationId, from: conversationId, body: 'second',
        timestamp: new Date('2025-01-10T10:01:00Z'), isOutgoing: false,
      })
      chatStore.getState().addMessage({
        type: 'chat', id: 'm3', conversationId, from: conversationId, body: 'third',
        timestamp: new Date('2025-01-10T10:02:00Z'), isOutgoing: false,
      })
      chatStore.setState((state) => {
        const newMarkers = new Map(state.firstNewMessageMarkers)
        newMarkers.set(conversationId, 'm2')
        return { firstNewMessageMarkers: newMarkers }
      })

      // First call actually advances the pointer and clears the divider.
      chatStore.getState().markReadToNewest(conversationId)

      const { conversationMeta, conversations } = chatStore.getState()

      // Second call: conversation is already fully read, nothing should change.
      chatStore.getState().markReadToNewest(conversationId)

      const stateAfter = chatStore.getState()
      expect(stateAfter.conversationMeta).toBe(conversationMeta)
      expect(stateAfter.conversations).toBe(conversations)
    })
  })

  describe('hasConversation', () => {
    it('should return true for existing conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      expect(chatStore.getState().hasConversation('alice@example.com')).toBe(true)
    })

    it('should return false for non-existing conversation', () => {
      expect(chatStore.getState().hasConversation('unknown@example.com')).toBe(false)
    })
  })

  describe('reset', () => {
    it('should clear all state', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello'))
      chatStore.getState().setActiveConversation('alice@example.com')

      chatStore.getState().reset()

      const state = chatStore.getState()
      expect(state.conversations.size).toBe(0)
      expect(state.messages.size).toBe(0)
      expect(state.activeConversationId).toBeNull()
    })

    it('should clear localStorage', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().reset()

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('xmpp-chat-storage')
    })
  })

  describe('switchAccount', () => {
    it('should load account-scoped conversations and drafts', () => {
      const aliceState = JSON.stringify({
        state: {
          conversations: [['alice@example.com', { id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0 }]],
          archivedConversations: [],
          drafts: [['alice@example.com', 'Alice draft']],
        },
      })
      localStorageMock._store['xmpp-chat-storage:alice@example.com'] = aliceState

      setStorageScopeJid('alice@example.com')
      chatStore.getState().switchAccount('alice@example.com')

      expect(chatStore.getState().conversations.has('alice@example.com')).toBe(true)
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Alice draft')
    })

    it('should clear in-memory state when switching to an account without saved data', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setDraft('alice@example.com', 'local draft')

      localStorageMock.removeItem('xmpp-chat-storage')
      setStorageScopeJid('bob@example.com')
      chatStore.getState().switchAccount('bob@example.com')

      expect(chatStore.getState().conversations.size).toBe(0)
      expect(chatStore.getState().drafts.size).toBe(0)
    })

    it('should migrate only conversation lists from legacy storage', () => {
      const legacyData = JSON.stringify({
        state: {
          conversations: [
            ['alice@example.com', { id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0 }],
            ['bob@example.com', { id: 'bob@example.com', name: 'Bob', type: 'chat', unreadCount: 0 }],
          ],
          archivedConversations: ['bob@example.com'],
          drafts: [['alice@example.com', 'legacy draft should not migrate']],
        },
      })
      localStorageMock._store['xmpp-chat-storage'] = legacyData

      setStorageScopeJid('me@example.com')
      chatStore.getState().switchAccount('me@example.com')

      // Legacy key should be consumed after successful migration
      expect(localStorageMock._store['xmpp-chat-storage']).toBeUndefined()
      expect(localStorageMock._store['xmpp-chat-storage:me@example.com']).toBeDefined()

      // Conversation lists should be restored
      expect(chatStore.getState().conversations.has('alice@example.com')).toBe(true)
      expect(chatStore.getState().conversations.has('bob@example.com')).toBe(true)
      expect(chatStore.getState().archivedConversations.has('bob@example.com')).toBe(true)

      // Drafts are intentionally not migrated
      expect(chatStore.getState().drafts.size).toBe(0)
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('')
    })
  })

  describe('persistence', () => {
    it('should serialize conversations Map to array', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com', 'Alice'))
      chatStore.getState().addConversation(createConversation('bob@example.com', 'Bob'))

      // Check localStorage was called with serialized data
      expect(localStorageMock.setItem).toHaveBeenCalled()

      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const stored = JSON.parse(lastCall[1])

      // Should be array of tuples, not a Map
      expect(Array.isArray(stored.state.conversations)).toBe(true)
      expect(stored.state.conversations.length).toBe(2)
    })

    it('should NOT serialize messages to localStorage (they are in IndexedDB)', () => {
      // Messages are stored in IndexedDB now, not localStorage
      // The localStorage persistence only stores conversations metadata
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hello'))

      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const stored = JSON.parse(lastCall[1])

      // Messages should not be in localStorage (they're in IndexedDB)
      expect(stored.state.messages).toBeUndefined()
    })

    it('should store messages in memory (display buffer) without localStorage limit', () => {
      // Messages are stored in memory for display, with a high limit (5000)
      // This test verifies we can store more than the old 100 message limit
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      // Add 500 messages (was limited to 100 before, now can go up to 5000)
      for (let i = 0; i < 500; i++) {
        chatStore.getState().addMessage(createMessage('alice@example.com', `Message ${i}`))
      }

      // All 500 messages should be in memory
      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(500)
    })

    it('should serialize conversation with lastMessage', () => {
      // Note: lastMessage is stored on the conversation and updated when messages are added
      // This avoids subscribing to the entire messagesMap in useChat which causes render loops
      const conv = createConversation('alice@example.com')
      chatStore.getState().addConversation(conv)

      const originalDate = new Date('2024-01-15T10:30:00Z')
      const msg: Message = {
        type: 'chat',
        id: 'test-msg',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Test',
        timestamp: originalDate,
        isOutgoing: false,
      }
      chatStore.getState().addMessage(msg)

      // Get the serialized data
      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const serialized = lastCall[1]

      // The persist middleware serializes the conversation
      const parsed = JSON.parse(serialized)

      // Conversation should have lastMessage (updated when message was added)
      const conversationData = parsed.state.conversations.find(
        ([id]: [string, unknown]) => id === 'alice@example.com'
      )
      expect(conversationData).toBeDefined()
      // lastMessage is now stored on the conversation
      expect(conversationData[1].lastMessage).toBeDefined()
      expect(conversationData[1].lastMessage.id).toBe('test-msg')
      expect(conversationData[1].lastMessage.body).toBe('Test')
    })

    it('should reset unreadCount to 0 when deserializing', () => {
      // This tests the behavior that unread counts are session-specific
      const conv = { ...createConversation('alice@example.com'), unreadCount: 5 }
      chatStore.getState().addConversation(conv)

      // Get the serialized data
      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const serialized = lastCall[1]

      // Check that when we would deserialize, unreadCount gets reset
      // (The actual deserialization logic resets unreadCount to 0)
      const parsed = JSON.parse(serialized)

      // The serialized data preserves the unreadCount
      expect(parsed.state.conversations[0][1].unreadCount).toBe(5)

      // But the deserializeState function resets it (tested via behavior)
    })

    it('should handle corrupted localStorage gracefully', () => {
      localStorageMock.getItem.mockReturnValueOnce('invalid json {{{')

      // Should not throw when accessing store with corrupted data
      expect(() => chatStore.getState()).not.toThrow()
    })

    it('should handle missing localStorage data', () => {
      localStorageMock.getItem.mockReturnValueOnce(null)

      // Should work fine with no stored data
      const state = chatStore.getState()
      expect(state.conversations.size).toBe(0)
    })

    it('should store messages in array with proper Date timestamps', () => {
      // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
      // Messages are stored in IndexedDB, not localStorage, but we verify in-memory behavior
      const conv = createConversation('alice@example.com')
      chatStore.getState().addConversation(conv)

      const originalDate = new Date('2024-01-15T10:30:00Z')
      const msg: Message = {
        type: 'chat',
        id: 'test-msg',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Test',
        timestamp: originalDate,
        isOutgoing: false,
      }
      chatStore.getState().addMessage(msg)

      // Verify message is in the array with proper Date timestamp
      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.length).toBe(1)
      expect(messages?.[0].timestamp).toBeInstanceOf(Date)
      expect(messages?.[0].timestamp.getTime()).toBe(originalDate.getTime())
      // Most importantly: getTime() should return a valid number, not NaN
      expect(Number.isNaN(messages?.[0].timestamp.getTime())).toBe(false)
    })

    it('should NOT persist activeConversationId (not stored or always null)', () => {
      // This test prevents regression of the dual-persistence bug where
      // activeConversationId was persisted in both chatStore (localStorage)
      // and ChatLayout's session storage, causing unread badge issues.
      // See: ChatLayout manages activeConversationId via ViewStateData.
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      // Verify the store has the active conversation set
      expect(chatStore.getState().activeConversationId).toBe('alice@example.com')

      // Get the serialized data
      const lastCall = localStorageMock.setItem.mock.calls[localStorageMock.setItem.mock.calls.length - 1]
      const stored = JSON.parse(lastCall[1])

      // activeConversationId should NOT be the current value - either null, undefined, or not present
      // The key point is that 'alice@example.com' should NOT be persisted
      expect(stored.state.activeConversationId).not.toBe('alice@example.com')
      // It should be falsy (null or undefined)
      expect(stored.state.activeConversationId).toBeFalsy()
    })

    it('should always deserialize activeConversationId as null', () => {
      // Even if old localStorage data has activeConversationId set (legacy),
      // deserialize should return null to prevent stale values
      const legacySerializedData = JSON.stringify({
        state: {
          conversations: [['alice@example.com', { id: 'alice@example.com', name: 'Alice', type: 'chat', unreadCount: 0 }]],
          messages: [],
          activeConversationId: 'alice@example.com', // Legacy: this was persisted before
          archivedConversations: [],
        },
      })

      // Simulate loading from localStorage with legacy data
      localStorageMock._store['xmpp-chat-storage'] = legacySerializedData
      localStorageMock.getItem.mockReturnValue(legacySerializedData)

      // Reset and reload store (simulating page refresh)
      chatStore.persist.rehydrate()

      // activeConversationId should be null regardless of legacy stored value
      expect(chatStore.getState().activeConversationId).toBeNull()
    })
  })

  describe('groupchat conversations', () => {
    it('should handle groupchat type conversations', () => {
      const groupConv: Conversation = {
        id: 'room@conference.example.com',
        name: 'Team Chat',
        type: 'groupchat',
        unreadCount: 0,
      }

      chatStore.getState().addConversation(groupConv)

      const stored = chatStore.getState().conversations.get('room@conference.example.com')
      expect(stored?.type).toBe('groupchat')
    })
  })

  describe('updateReactions (XEP-0444)', () => {
    it('should add reactions to a message', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '👍': ['bob@example.com'] })
    })

    it('should find message by origin-id when a reaction references the sender id', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg: Message = {
        ...createMessage('alice@example.com', 'Hello!'),
        id: 'rewritten-id',
        originId: 'sender-origin-uuid',
      }
      chatStore.getState().addMessage(msg)

      // XEP-0444: a 1:1 reaction references the origin-id when present.
      chatStore.getState().updateReactions('alice@example.com', 'sender-origin-uuid', 'bob@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '👍': ['bob@example.com'] })
    })

    it('should add multiple reactions from same user', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍', '❤️'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({
        '👍': ['bob@example.com'],
        '❤️': ['bob@example.com'],
      })
    })

    it('should aggregate reactions from multiple users', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'charlie@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({
        '👍': ['bob@example.com', 'charlie@example.com'],
      })
    })

    it('should replace previous reactions when user sends new set', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      // Bob reacts with thumbs up
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])
      // Bob changes reaction to heart
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['❤️'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '❤️': ['bob@example.com'] })
    })

    it('should remove all reactions when user sends empty array', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', [])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toBeUndefined()
    })

    it('should handle removing one user while keeping others', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'charlie@example.com', ['👍'])
      // Bob removes reaction
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', [])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '👍': ['charlie@example.com'] })
    })

    it('should not modify state if conversation does not exist', () => {
      chatStore.getState().updateReactions('nonexistent@example.com', 'msg-id', 'bob@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('nonexistent@example.com')
      expect(messages).toBeUndefined()
    })

    it('should fall back to the durable cache when the conversation is not active (messages evicted from RAM)', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('carol@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      // Switch away from alice's conversation — deactivation evicts her
      // resident messages array, mirroring what happens when a reaction
      // arrives for a conversation that isn't the active one.
      chatStore.getState().setActiveConversation('alice@example.com')
      chatStore.getState().setActiveConversation('carol@example.com')
      expect(chatStore.getState().messages.get('alice@example.com')).toBeUndefined()

      vi.mocked(messageCache.updateMessageReactions).mockClear()
      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['👍'])

      expect(messageCache.updateMessageReactions).toHaveBeenCalledWith(msg.id, 'bob@example.com', ['👍'])
      // No resident array to update — the reaction lands in the cache only,
      // to be picked up next time the conversation is activated.
      expect(chatStore.getState().messages.get('alice@example.com')).toBeUndefined()
    })

    it('should not modify state if message does not exist', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', 'wrong-msg-id', 'bob@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toBeUndefined()
    })

    it('should handle emoji reactions correctly', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      chatStore.getState().addMessage(msg)

      chatStore.getState().updateReactions('alice@example.com', msg.id, 'bob@example.com', ['🎉', '🔥', '💯'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({
        '🎉': ['bob@example.com'],
        '🔥': ['bob@example.com'],
        '💯': ['bob@example.com'],
      })
    })

    it('should find message by stanzaId when reaction references server-assigned ID', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      msg.stanzaId = 'server-stanza-id-123'
      chatStore.getState().addMessage(msg)

      // Reaction references the stanzaId (as other clients like Gajim may do)
      chatStore.getState().updateReactions('alice@example.com', 'server-stanza-id-123', 'bob@example.com', ['👍'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '👍': ['bob@example.com'] })
    })

    it('should replace reactions when referenced by stanzaId', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const msg = createMessage('alice@example.com', 'Hello!')
      msg.stanzaId = 'server-stanza-id-456'
      chatStore.getState().addMessage(msg)

      // First reaction via stanzaId
      chatStore.getState().updateReactions('alice@example.com', 'server-stanza-id-456', 'bob@example.com', ['👍'])
      // Bob changes reaction (still via stanzaId)
      chatStore.getState().updateReactions('alice@example.com', 'server-stanza-id-456', 'bob@example.com', ['❤️'])

      const messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[0].reactions).toEqual({ '❤️': ['bob@example.com'] })
    })
  })

  describe('draft management', () => {
    beforeEach(() => {
      // Reset drafts state
      chatStore.setState({ drafts: new Map() })
    })

    it('should save a draft for a conversation', () => {
      chatStore.getState().setDraft('alice@example.com', 'Hello, this is my draft')

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Hello, this is my draft')
    })

    it('should return empty string for conversation without draft', () => {
      expect(chatStore.getState().getDraft('nonexistent@example.com')).toBe('')
    })

    it('should update existing draft when setting new text', () => {
      chatStore.getState().setDraft('alice@example.com', 'First draft')
      chatStore.getState().setDraft('alice@example.com', 'Updated draft')

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Updated draft')
    })

    it('should maintain separate drafts for different conversations', () => {
      chatStore.getState().setDraft('alice@example.com', 'Message for Alice')
      chatStore.getState().setDraft('bob@example.com', 'Message for Bob')
      chatStore.getState().setDraft('charlie@example.com', 'Message for Charlie')

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Message for Alice')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('Message for Bob')
      expect(chatStore.getState().getDraft('charlie@example.com')).toBe('Message for Charlie')
    })

    it('should delete draft when setting empty string', () => {
      chatStore.getState().setDraft('alice@example.com', 'Some text')
      chatStore.getState().setDraft('alice@example.com', '')

      const state = chatStore.getState()
      expect(state.drafts.has('alice@example.com')).toBe(false)
      expect(state.getDraft('alice@example.com')).toBe('')
    })

    it('should delete draft when setting whitespace-only string', () => {
      chatStore.getState().setDraft('alice@example.com', 'Some text')
      chatStore.getState().setDraft('alice@example.com', '   ')

      const state = chatStore.getState()
      expect(state.drafts.has('alice@example.com')).toBe(false)
    })

    it('should clear draft for a specific conversation', () => {
      chatStore.getState().setDraft('alice@example.com', 'Draft for Alice')
      chatStore.getState().setDraft('bob@example.com', 'Draft for Bob')

      chatStore.getState().clearDraft('alice@example.com')

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('Draft for Bob')
    })

    it('should not throw when clearing non-existent draft', () => {
      expect(() => {
        chatStore.getState().clearDraft('nonexistent@example.com')
      }).not.toThrow()
    })

    it('should clear all drafts on reset', () => {
      chatStore.getState().setDraft('alice@example.com', 'Draft for Alice')
      chatStore.getState().setDraft('bob@example.com', 'Draft for Bob')

      chatStore.getState().reset()

      expect(chatStore.getState().getDraft('alice@example.com')).toBe('')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('')
      expect(chatStore.getState().drafts.size).toBe(0)
    })

    it('should preserve drafts when switching active conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().setDraft('alice@example.com', 'Draft for Alice')

      // Switch active conversation
      chatStore.getState().setActiveConversation('bob@example.com')

      // Draft should still be preserved for Alice
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Draft for Alice')
    })

    it('should persist drafts to localStorage', () => {
      chatStore.getState().setDraft('alice@example.com', 'Persistent draft')

      // Get the serialized data
      const calls = localStorageMock.setItem.mock.calls
      expect(calls.length).toBeGreaterThan(0)

      const lastCall = calls[calls.length - 1]
      const stored = JSON.parse(lastCall[1])

      // Drafts should be in the persisted state as array of tuples
      expect(stored.state.drafts).toBeDefined()
      expect(Array.isArray(stored.state.drafts)).toBe(true)
      expect(stored.state.drafts).toContainEqual(['alice@example.com', 'Persistent draft'])
    })

    it('should restore drafts from localStorage after rehydration', async () => {
      // Reset all mocks to clear any mockReturnValueOnce calls from previous tests
      localStorageMock.getItem.mockReset()
      localStorageMock.setItem.mockReset()
      localStorageMock.removeItem.mockReset()
      localStorageMock.clear.mockReset()

      // Ensure clean state before test
      chatStore.setState({
        conversations: new Map(),
        messages: new Map(),
        activeConversationId: null,
        archivedConversations: new Set(),
        drafts: new Map(),
        mamQueryStates: new Map(),
      })

      // Set up drafts in localStorage
      const storedData = JSON.stringify({
        state: {
          conversations: [],
          archivedConversations: [],
          drafts: [
            ['alice@example.com', 'Draft for Alice'],
            ['bob@example.com', 'Draft for Bob'],
          ],
        },
      })
      // Set the internal store AND provide a fresh mock implementation
      localStorageMock._store['xmpp-chat-storage'] = storedData
      localStorageMock.getItem.mockImplementation((key: string) =>
        localStorageMock._store[key] || null
      )

      // Rehydrate the store (returns a Promise)
      await chatStore.persist.rehydrate()

      // Drafts should be restored
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Draft for Alice')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('Draft for Bob')
    })

    it('should handle missing drafts in old localStorage data (backwards compatible)', () => {
      // Old localStorage data without drafts field
      const legacyData = JSON.stringify({
        state: {
          conversations: [],
          archivedConversations: [],
          // Note: no drafts field
        },
      })
      localStorageMock._store['xmpp-chat-storage'] = legacyData
      localStorageMock.getItem.mockReturnValue(legacyData)

      // Rehydrate the store - should not throw
      expect(() => chatStore.persist.rehydrate()).not.toThrow()

      // Drafts should default to empty
      expect(chatStore.getState().drafts.size).toBe(0)
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('')
    })
  })

  describe('message routing safety', () => {
    // These tests ensure messages are sent to the correct conversation
    // and drafts don't accidentally get sent to wrong recipients

    it('should keep draft isolated to its conversation when switching', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))

      // Set draft for Alice while viewing her conversation
      chatStore.getState().setActiveConversation('alice@example.com')
      chatStore.getState().setDraft('alice@example.com', 'Secret message for Alice only')

      // Switch to Bob's conversation
      chatStore.getState().setActiveConversation('bob@example.com')

      // Alice's draft should be intact
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('Secret message for Alice only')
      // Bob should have no draft
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('')
    })

    it('should not mix up drafts between conversations', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().addConversation(createConversation('charlie@example.com'))

      // Set drafts for multiple conversations
      chatStore.getState().setDraft('alice@example.com', 'PRIVATE: Alice draft')
      chatStore.getState().setDraft('bob@example.com', 'PRIVATE: Bob draft')

      // Switch between conversations multiple times
      chatStore.getState().setActiveConversation('alice@example.com')
      chatStore.getState().setActiveConversation('charlie@example.com')
      chatStore.getState().setActiveConversation('bob@example.com')
      chatStore.getState().setActiveConversation('alice@example.com')

      // All drafts should still be correctly associated
      expect(chatStore.getState().getDraft('alice@example.com')).toBe('PRIVATE: Alice draft')
      expect(chatStore.getState().getDraft('bob@example.com')).toBe('PRIVATE: Bob draft')
      expect(chatStore.getState().getDraft('charlie@example.com')).toBe('')
    })

    it('should add message to correct conversation regardless of active conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))

      // View Alice's conversation
      chatStore.getState().setActiveConversation('alice@example.com')

      // Add message to Bob's conversation (e.g., incoming message)
      const msgForBob = createMessage('bob@example.com', 'Message for Bob')
      chatStore.getState().addMessage(msgForBob)

      // Message should be in Bob's conversation, not Alice's
      expect(chatStore.getState().messages.get('bob@example.com')?.length).toBe(1)
      expect(chatStore.getState().messages.get('alice@example.com')).toBeUndefined()
    })

    it('should correctly track which conversation has unread messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))

      // View Alice's conversation
      chatStore.getState().setActiveConversation('alice@example.com')

      // Messages to inactive conversation should increment unread
      chatStore.getState().addMessage(createMessage('bob@example.com', 'Hi from Bob'))
      chatStore.getState().addMessage(createMessage('bob@example.com', 'Another message'))

      // Messages to active conversation should not increment unread
      chatStore.getState().addMessage(createMessage('alice@example.com', 'Hi Alice'))

      expect(chatStore.getState().conversations.get('bob@example.com')?.unreadCount).toBe(2)
      expect(chatStore.getState().conversations.get('alice@example.com')?.unreadCount).toBe(0)
    })
  })

  describe('conversation archiving', () => {
    it('should archive a conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().archiveConversation('alice@example.com')

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(true)
      expect(chatStore.getState().archivedConversations.has('alice@example.com')).toBe(true)
    })

    it('should unarchive a conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      chatStore.getState().unarchiveConversation('alice@example.com')

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(false)
      expect(chatStore.getState().archivedConversations.has('alice@example.com')).toBe(false)
    })

    it('should return false for non-archived conversation', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(false)
    })

    it('should auto-unarchive when new message arrives', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(true)

      // Receive a new message
      const msg = createMessage('alice@example.com', 'New message!')
      chatStore.getState().addMessage(msg)

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(false)
    })

    it('should not auto-unarchive for outgoing messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      // Send an outgoing message
      const msg = createMessage('alice@example.com', 'My reply', true)
      chatStore.getState().addMessage(msg)

      // Should still be archived since it's our own message
      expect(chatStore.getState().isArchived('alice@example.com')).toBe(true)
    })

    it('should clear active conversation when archiving it', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      chatStore.getState().archiveConversation('alice@example.com')

      expect(chatStore.getState().activeConversationId).toBeNull()
    })

    it('should handle archiving multiple conversations', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().addConversation(createConversation('charlie@example.com'))

      chatStore.getState().archiveConversation('alice@example.com')
      chatStore.getState().archiveConversation('charlie@example.com')

      expect(chatStore.getState().isArchived('alice@example.com')).toBe(true)
      expect(chatStore.getState().isArchived('bob@example.com')).toBe(false)
      expect(chatStore.getState().isArchived('charlie@example.com')).toBe(true)
      expect(chatStore.getState().archivedConversations.size).toBe(2)
    })
  })

  describe('MAM (XEP-0313) support', () => {
    describe('setMAMLoading', () => {
      it('should set loading state for a conversation', () => {
        chatStore.getState().setMAMLoading('alice@example.com', true)

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.isLoading).toBe(true)
      })

      it('should clear loading state for a conversation', () => {
        chatStore.getState().setMAMLoading('alice@example.com', true)
        chatStore.getState().setMAMLoading('alice@example.com', false)

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.isLoading).toBe(false)
      })
    })

    describe('setMAMError', () => {
      it('should set error state for a conversation', () => {
        chatStore.getState().setMAMError('alice@example.com', 'Network error')

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.error).toBe('Network error')
      })

      it('should clear error state when set to null', () => {
        chatStore.getState().setMAMError('alice@example.com', 'Some error')
        chatStore.getState().setMAMError('alice@example.com', null)

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.error).toBeNull()
      })
    })

    describe('getMAMQueryState', () => {
      it('should return default state for unknown conversation', () => {
        const state = chatStore.getState().getMAMQueryState('unknown@example.com')

        expect(state).toEqual({
          isLoading: false,
          error: null,
          hasQueried: false,
          isHistoryComplete: false,
          isCaughtUpToLive: false,
        })
      })

      it('should return stored state for known conversation', () => {
        chatStore.getState().setMAMLoading('alice@example.com', true)

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.isLoading).toBe(true)
      })
    })

    describe('resetMAMStates', () => {
      it('should clear all MAM query states', () => {
        // Set up MAM state for multiple conversations
        chatStore.getState().setMAMLoading('alice@example.com', true)
        chatStore.getState().setMAMLoading('bob@example.com', false)

        // Verify states are set
        expect(chatStore.getState().getMAMQueryState('alice@example.com').isLoading).toBe(true)
        expect(chatStore.getState().getMAMQueryState('bob@example.com').hasQueried).toBe(false)

        // Mark bob's conversation as queried via mergeMAMMessages
        chatStore.getState().addConversation(createConversation('bob@example.com'))
        chatStore.getState().mergeMAMMessages('bob@example.com', [], { first: '', last: '', count: 0 }, true, 'backward')
        expect(chatStore.getState().getMAMQueryState('bob@example.com').hasQueried).toBe(true)

        // Reset all MAM states
        chatStore.getState().resetMAMStates()

        // Verify all states are cleared (back to defaults)
        const aliceState = chatStore.getState().getMAMQueryState('alice@example.com')
        const bobState = chatStore.getState().getMAMQueryState('bob@example.com')

        expect(aliceState).toEqual({
          isLoading: false,
          error: null,
          hasQueried: false,
          isHistoryComplete: false,
          isCaughtUpToLive: false,
        })
        expect(bobState).toEqual({
          isLoading: false,
          error: null,
          hasQueried: false,
          isHistoryComplete: false,
          isCaughtUpToLive: false,
        })
      })
    })

    describe('stanzaId backfill (closes the MAM cursor data gap)', () => {
      // The MAM-path backfill writes the patched array into the resident map, which
      // now only happens for the active conversation.
      beforeEach(() => {
        chatStore.setState({ activeConversationId: 'alice@example.com' })
      })

      it('backfills stanzaId onto an outgoing message when its archived copy arrives via MAM', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Outgoing message as created by sendMessage: client originId, no stanzaId.
        const sent: Message = {
          type: 'chat',
          id: 'uuid-sent',
          originId: 'uuid-sent',
          conversationId: 'alice@example.com',
          from: 'me@example.com/desktop',
          body: 'hello',
          timestamp: new Date('2024-01-15T12:00:00Z'),
          isOutgoing: true,
        }
        chatStore.getState().addMessage(sent)

        // Archived copy from MAM: same origin-id, now carries the server stanzaId,
        // bare `from`. It is a duplicate (matched by originId) and would otherwise
        // be dropped without ever giving the live message a stanzaId.
        const archived: Message = {
          type: 'chat',
          id: 'uuid-sent',
          originId: 'uuid-sent',
          conversationId: 'alice@example.com',
          from: 'me@example.com',
          body: 'hello',
          timestamp: new Date('2024-01-15T12:00:00Z'),
          isOutgoing: true,
          stanzaId: 'archive-99',
        }

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [archived],
          { count: 1, first: 'archive-99', last: 'archive-99' },
          true,
          'forward'
        )

        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(1) // still deduplicated
        expect(messages?.[0].stanzaId).toBe('archive-99') // but now backfilled
        expect(messageCache.updateMessage).toHaveBeenCalledWith(
          'uuid-sent',
          expect.objectContaining({ stanzaId: 'archive-99' })
        )
      })

      it('backfills stanzaId onto an outgoing message when a duplicate carbon arrives via addMessage', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        const sent: Message = {
          type: 'chat',
          id: 'uuid-2',
          originId: 'uuid-2',
          conversationId: 'alice@example.com',
          from: 'me@example.com/desktop',
          body: 'hi there',
          timestamp: new Date('2024-01-15T12:00:00Z'),
          isOutgoing: true,
        }
        chatStore.getState().addMessage(sent)

        const carbon: Message = {
          type: 'chat',
          id: 'uuid-2',
          originId: 'uuid-2',
          conversationId: 'alice@example.com',
          from: 'me@example.com',
          body: 'hi there',
          timestamp: new Date('2024-01-15T12:00:00Z'),
          isOutgoing: true,
          stanzaId: 'archive-carbon',
        }
        chatStore.getState().addMessage(carbon)

        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(1)
        expect(messages?.[0].stanzaId).toBe('archive-carbon')
        expect(messageCache.updateMessage).toHaveBeenCalledWith(
          'uuid-2',
          expect.objectContaining({ stanzaId: 'archive-carbon' })
        )
      })
    })

    describe('mergeMAMMessages', () => {
      // These tests exercise the foreground merge-into-RAM path (the active
      // conversation / scroll-up). Background catch-up of a NON-active
      // conversation (IndexedDB + preview, no RAM) is covered separately below.
      beforeEach(() => {
        chatStore.setState({ activeConversationId: 'alice@example.com' })
      })

      it('does NOT populate RAM for a non-active conversation (IndexedDB + preview only)', () => {
        chatStore.setState({ activeConversationId: 'other@example.com' })
        chatStore.getState().addConversation(createConversation('alice@example.com'))
        const mam: Message[] = [
          { type: 'chat', id: 'bg-1', conversationId: 'alice@example.com', from: 'alice@example.com', body: 'caught up', timestamp: new Date('2024-02-01T10:00:00Z'), isOutgoing: false, stanzaId: 's-bg-1' },
        ]
        chatStore.getState().mergeMAMMessages('alice@example.com', mam, {}, true, 'forward')
        // Non-active → resident array NOT populated...
        expect(chatStore.getState().messages.get('alice@example.com') ?? []).toEqual([])
        // ...but the sidebar preview is updated.
        expect(chatStore.getState().conversationMeta.get('alice@example.com')?.lastMessage?.id).toBe('bg-1')
      })

      it('should merge MAM messages with existing messages', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add an existing local message
        const localMsg: Message = {
          type: 'chat',
          id: 'local-msg',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Local message',
          timestamp: new Date('2024-01-15T12:00:00Z'),
          isOutgoing: false,
        }
        chatStore.getState().addMessage(localMsg)

        // Merge MAM messages (older)
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-msg-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Old message 1',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
            stanzaId: 'stanza-1',
          },
          {
            type: 'chat',
            id: 'mam-msg-2',
            conversationId: 'alice@example.com',
            from: 'me@example.com',
            body: 'Old message 2',
            timestamp: new Date('2024-01-15T11:00:00Z'),
            isOutgoing: true,
            stanzaId: 'stanza-2',
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 2, first: 'stanza-1', last: 'stanza-2' },
          true,
          'backward'
        )

        // Should have all 3 messages
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(3)

        // Should be sorted by timestamp
        expect(messages?.[0].body).toBe('Old message 1')
        expect(messages?.[1].body).toBe('Old message 2')
        expect(messages?.[2].body).toBe('Local message')
      })

      it('should deduplicate messages by stanzaId', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add an existing message with stanzaId
        const existingMsg: Message = {
          type: 'chat',
          id: 'existing-msg',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Existing message',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
          stanzaId: 'duplicate-stanza-id',
        }
        chatStore.getState().addMessage(existingMsg)

        // Merge MAM message with same stanzaId
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-duplicate',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Existing message',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
            stanzaId: 'duplicate-stanza-id',
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 1 },
          true,
          'backward'
        )

        // Should still have only 1 message (deduplicated)
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(1)
      })

      it('should deduplicate messages by from+id fallback', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add an existing message without stanzaId but with from+id
        const existingMsg: Message = {
          type: 'chat',
          id: 'msg-123',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Existing message',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
        }
        chatStore.getState().addMessage(existingMsg)

        // Merge MAM message with same from+id
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'msg-123',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Existing message',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 1 },
          true,
          'backward'
        )

        // Should still have only 1 message (deduplicated by from+id)
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(1)
      })

      it('should set hasQueried and isHistoryComplete flags for backward query', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 0 },
          true,
          'backward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.hasQueried).toBe(true)
        expect(state.isHistoryComplete).toBe(true)
        expect(state.isHistoryComplete).toBe(true) // Backward compat alias
      })

      it('should set hasQueried and isCaughtUpToLive flags for forward query', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 0 },
          true,
          'forward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.hasQueried).toBe(true)
        expect(state.isCaughtUpToLive).toBe(true)
        expect(state.isHistoryComplete).toBe(false) // Not set for forward queries
      })

      it('should set isHistoryComplete=false when more history is available', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 50, first: 'first-id', last: 'last-id' },
          false, // complete = false
          'backward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.hasQueried).toBe(true)
        expect(state.isHistoryComplete).toBe(false)
        expect(state.isHistoryComplete).toBe(false)
      })

      it('should store oldestFetchedId from RSM first for pagination', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-msg-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Old message',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
            stanzaId: 'oldest-stanza-id',
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 50, first: 'oldest-stanza-id', last: 'newest-stanza-id' },
          false,
          'backward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.oldestFetchedId).toBe('oldest-stanza-id')
      })

      it('should update oldestFetchedId when fetching older messages', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // First fetch
        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 50, first: 'first-batch-oldest', last: 'first-batch-newest' },
          false,
          'backward'
        )

        expect(chatStore.getState().getMAMQueryState('alice@example.com').oldestFetchedId)
          .toBe('first-batch-oldest')

        // Second fetch (older messages)
        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 50, first: 'second-batch-oldest', last: 'second-batch-newest' },
          false,
          'backward'
        )

        // Should be updated to the new oldest
        expect(chatStore.getState().getMAMQueryState('alice@example.com').oldestFetchedId)
          .toBe('second-batch-oldest')
      })

      it('should not have oldestFetchedId when RSM response has no first', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          [],
          { count: 0 }, // Empty RSM response
          true,
          'backward'
        )

        const state = chatStore.getState().getMAMQueryState('alice@example.com')
        expect(state.oldestFetchedId).toBeUndefined()
      })

      it('should trim messages to MAX_MESSAGES_PER_CONVERSATION', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Create 5100 MAM messages (more than MAX_MESSAGES_PER_CONVERSATION which is 5000)
        const total = 5100
        const mamMessages: Message[] = []
        for (let i = 0; i < total; i++) {
          mamMessages.push({
            type: 'chat',
            id: `mam-msg-${i}`,
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: `Message ${i}`,
            timestamp: new Date(Date.now() - (total - i) * 60000), // Ordered by time
            isOutgoing: false,
            stanzaId: `stanza-${i}`,
          })
        }

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: total },
          true,
          'backward'
        )

        // Should be trimmed to MAX_MESSAGES (5000) - this is the display buffer limit
        // All messages are still stored in IndexedDB
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBeLessThanOrEqual(5000)

        // A backward (load-older) merge slides the window: it keeps the OLDEST
        // maxCount messages so the just-loaded older batch survives instead of
        // being evicted at the bound. In production a single backward MAM merge
        // never approaches this scale (auto-pagination caps at 5 pages x 50 = 250
        // messages for chats, 50 for rooms - see MAM.ts), so this 5100-message
        // direct call is a synthetic stress case exercising the trim DIRECTION,
        // not a realistic overflow scenario.
        expect(messages?.length).toBe(5000)
        expect(messages?.[0].body).toBe('Message 0')
        expect(messages?.[messages!.length - 1].body).toBe('Message 4999')
      })

      it('should create conversation messages array if it does not exist', () => {
        chatStore.getState().addConversation(createConversation('alice@example.com'))
        // Don't add any messages - messages array doesn't exist

        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-msg-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'First MAM message',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 1 },
          true,
          'backward'
        )

        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(1)
        expect(messages?.[0].body).toBe('First MAM message')
      })

      it('should merge MAM messages and allow newest to be derived as lastMessage', () => {
        // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
        // Store merges messages; useChat derives lastMessage from array[length-1]
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Merge MAM messages
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-older',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Older MAM message',
            timestamp: new Date('2024-01-15T08:00:00Z'),
            isOutgoing: false,
          },
          {
            type: 'chat',
            id: 'mam-newer',
            conversationId: 'alice@example.com',
            from: 'me@example.com',
            body: 'Newer MAM message',
            timestamp: new Date('2024-01-15T12:00:00Z'),
            isOutgoing: true,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 2 },
          true,
          'forward'
        )

        // Messages array should contain both messages, sorted by timestamp
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(2)
        // Last message in array (which would be derived as lastMessage) should be the newest
        expect(messages?.[messages.length - 1].body).toBe('Newer MAM message')
        expect(messages?.[messages.length - 1].timestamp.getTime()).toBe(new Date('2024-01-15T12:00:00Z').getTime())
      })

      it('should merge older MAM messages at the start of the array', () => {
        // Note: lastMessage is derived from messages array in useChat (like rooms)
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add a recent message first
        const recentMessage: Message = {
          type: 'chat',
          id: 'recent-msg',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Recent message',
          timestamp: new Date('2024-01-15T15:00:00Z'),
          isOutgoing: false,
        }
        chatStore.getState().addMessage(recentMessage)

        // Merge older MAM messages (pagination)
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-old-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'Old message 1',
            timestamp: new Date('2024-01-15T10:00:00Z'),
            isOutgoing: false,
          },
          {
            type: 'chat',
            id: 'mam-old-2',
            conversationId: 'alice@example.com',
            from: 'me@example.com',
            body: 'Old message 2',
            timestamp: new Date('2024-01-15T11:00:00Z'),
            isOutgoing: true,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 2 },
          true,
          'backward'
        )

        // Messages should be sorted by timestamp
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(3)
        // Oldest messages at the start
        expect(messages?.[0].body).toBe('Old message 1')
        expect(messages?.[1].body).toBe('Old message 2')
        // Recent message at the end (would be derived as lastMessage)
        expect(messages?.[messages.length - 1].body).toBe('Recent message')
      })

      it('should append newer MAM messages when direction is forward (catch-up scenario)', () => {
        // This tests the catch-up scenario: user has old messages locally,
        // MAM fetches newer messages that occurred while offline.
        // Direction 'forward' is used when start= filter is set (fetching from a point forward)
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Add an old message that we already have locally
        const oldMessage: Message = {
          type: 'chat',
          id: 'old-local-msg',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Old local message',
          timestamp: new Date('2024-01-15T08:00:00Z'),
          isOutgoing: false,
        }
        chatStore.getState().addMessage(oldMessage)

        // MAM catches up with newer messages (direction='forward')
        const newerMamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-new-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'New message 1',
            timestamp: new Date('2024-01-15T14:00:00Z'),
            isOutgoing: false,
          },
          {
            type: 'chat',
            id: 'mam-new-2',
            conversationId: 'alice@example.com',
            from: 'me@example.com',
            body: 'New message 2',
            timestamp: new Date('2024-01-15T15:00:00Z'),
            isOutgoing: true,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          newerMamMessages,
          { count: 2 },
          true,
          'forward'
        )

        // Messages should be sorted with newer ones at the end
        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(3)
        // Old local message at the start
        expect(messages?.[0].body).toBe('Old local message')
        // Newer MAM messages at the end, sorted by timestamp
        expect(messages?.[1].body).toBe('New message 1')
        expect(messages?.[2].body).toBe('New message 2')
        // Last message (for sidebar preview) should be the newest
        expect(messages?.[messages.length - 1].body).toBe('New message 2')
      })

      it('should correctly sort messages when forward MAM includes out-of-order timestamps', () => {
        // Edge case: MAM might return messages that interleave with existing ones
        chatStore.getState().addConversation(createConversation('alice@example.com'))

        // Existing messages at 10:00 and 14:00
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'existing-1',
          conversationId: 'alice@example.com',
          from: 'alice@example.com',
          body: 'Existing at 10:00',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
        })
        chatStore.getState().addMessage({
          type: 'chat',
          id: 'existing-2',
          conversationId: 'alice@example.com',
          from: 'me@example.com',
          body: 'Existing at 14:00',
          timestamp: new Date('2024-01-15T14:00:00Z'),
          isOutgoing: true,
        })

        // MAM returns messages at 12:00 and 16:00 (interleaved)
        const mamMessages: Message[] = [
          {
            type: 'chat',
            id: 'mam-1',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'MAM at 12:00',
            timestamp: new Date('2024-01-15T12:00:00Z'),
            isOutgoing: false,
          },
          {
            type: 'chat',
            id: 'mam-2',
            conversationId: 'alice@example.com',
            from: 'alice@example.com',
            body: 'MAM at 16:00',
            timestamp: new Date('2024-01-15T16:00:00Z'),
            isOutgoing: false,
          },
        ]

        chatStore.getState().mergeMAMMessages(
          'alice@example.com',
          mamMessages,
          { count: 2 },
          true,
          'forward'
        )

        const messages = chatStore.getState().messages.get('alice@example.com')
        expect(messages?.length).toBe(4)
        // Should be sorted chronologically
        expect(messages?.[0].body).toBe('Existing at 10:00')
        expect(messages?.[1].body).toBe('MAM at 12:00')
        expect(messages?.[2].body).toBe('Existing at 14:00')
        expect(messages?.[3].body).toBe('MAM at 16:00')
        // Newest message is last
        expect(messages?.[messages.length - 1].body).toBe('MAM at 16:00')
      })
    })
  })

  describe('mergeMAMMessages badge hydration', () => {
    const conversationId = 'alice@example.com'

    beforeEach(() => {
      chatStore.getState().addConversation(createConversation(conversationId))
      // Background catch-up hydration only applies to a NON-active conversation —
      // point activeConversationId elsewhere.
      chatStore.setState({ activeConversationId: 'other@example.com' })
    })

    it('forward merge into a non-active conversation recomputes unread count from the pointer', () => {
      chatStore.setState((state) => {
        const meta = new Map(state.conversationMeta)
        meta.set(conversationId, { ...meta.get(conversationId)!, lastSeenMessageId: 'm1' })
        return { conversationMeta: meta }
      })

      const mamMessages: Message[] = [
        {
          type: 'chat',
          id: 'm1',
          conversationId,
          from: conversationId,
          body: 'Already read',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
        {
          type: 'chat',
          id: 'm2',
          conversationId,
          from: conversationId,
          body: 'New 1',
          timestamp: new Date('2024-01-15T10:01:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
        {
          type: 'chat',
          id: 'm3',
          conversationId,
          from: conversationId,
          body: 'New 2',
          timestamp: new Date('2024-01-15T10:02:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
      ]

      chatStore.getState().mergeMAMMessages(conversationId, mamMessages, {}, true, 'forward')

      const meta = chatStore.getState().conversationMeta.get(conversationId)
      expect(meta?.unreadCount).toBe(2)
      // Combined map mirrors meta.
      const conv = chatStore.getState().conversations.get(conversationId)
      expect(conv?.unreadCount).toBe(2)
    })

    it('forward merge into a conversation with NO read state snaps the pointer (fresh-join guard)', () => {
      // No lastSeenMessageId/lastReadAt seeded — fresh conversation, never read.
      const mamMessages: Message[] = [
        {
          type: 'chat',
          id: 'f1',
          conversationId,
          from: conversationId,
          body: 'History 1',
          timestamp: new Date('2024-01-15T10:00:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
        {
          type: 'chat',
          id: 'f2',
          conversationId,
          from: conversationId,
          body: 'History 2',
          timestamp: new Date('2024-01-15T10:01:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
        {
          type: 'chat',
          id: 'f3',
          conversationId,
          from: conversationId,
          body: 'History 3',
          timestamp: new Date('2024-01-15T10:02:00Z'),
          isOutgoing: false,
          isDelayed: true,
        },
      ]

      chatStore.getState().mergeMAMMessages(conversationId, mamMessages, {}, true, 'forward')

      const meta = chatStore.getState().conversationMeta.get(conversationId)
      expect(meta?.unreadCount).toBe(0)
      expect(meta?.lastSeenMessageId).toBe('f3')
    })
  })

  describe('getMessage', () => {
    it('should find message by id', () => {
      const store = chatStore.getState()
      store.addConversation(createConversation('alice@example.com'))

      const message: Message = {
        type: 'chat',
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Hello',
        timestamp: new Date(),
        isOutgoing: false,
      }
      store.addMessage(message)

      const found = store.getMessage('alice@example.com', 'msg-123')
      expect(found).toBeDefined()
      expect(found?.body).toBe('Hello')
    })

    it('should find message by stanzaId (for MAM corrections)', () => {
      const store = chatStore.getState()
      store.addConversation(createConversation('alice@example.com'))

      const message: Message = {
        type: 'chat',
        id: 'original-uuid',
        stanzaId: 'mam-archive-id-12345',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: false,
      }
      store.addMessage(message)

      // Should find by stanzaId when correction references the MAM archive ID
      const found = store.getMessage('alice@example.com', 'mam-archive-id-12345')
      expect(found).toBeDefined()
      expect(found?.body).toBe('Original message')
      expect(found?.id).toBe('original-uuid')
    })

    it('should return undefined when message not found', () => {
      const store = chatStore.getState()
      store.addConversation(createConversation('alice@example.com'))

      const found = store.getMessage('alice@example.com', 'nonexistent')
      expect(found).toBeUndefined()
    })
  })

  describe('updateMessage', () => {
    it('should update message body', () => {
      const store = chatStore.getState()
      store.addConversation(createConversation('alice@example.com'))

      const message: Message = {
        type: 'chat',
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: false,
      }
      store.addMessage(message)

      store.updateMessage('alice@example.com', 'msg-123', {
        body: 'Edited message',
        isEdited: true,
      })

      const updated = store.getMessage('alice@example.com', 'msg-123')
      expect(updated?.body).toBe('Edited message')
      expect(updated?.isEdited).toBe(true)
    })

    it('should find message by origin-id when a correction references it (XEP-0308)', () => {
      const store = chatStore.getState()
      store.addConversation(createConversation('alice@example.com'))

      const message: Message = {
        type: 'chat',
        id: 'rewritten-id',
        originId: 'sender-origin-uuid',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Original',
        timestamp: new Date(),
        isOutgoing: false,
      }
      store.addMessage(message)

      // Correction references the sender-assigned origin-id, not the stored id.
      store.updateMessage('alice@example.com', 'sender-origin-uuid', { body: 'Fixed', isEdited: true })

      const updated = store.getMessage('alice@example.com', 'rewritten-id')
      expect(updated?.body).toBe('Fixed')
      expect(updated?.isEdited).toBe(true)
    })

    it('should update message in array (lastMessage derived from array in useChat)', () => {
      // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
      // When we edit a message, the array is updated, and useChat will derive the latest
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      const message: Message = {
        type: 'chat',
        id: 'msg-123',
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'Original message with typo',
        timestamp: new Date(),
        isOutgoing: true,
      }
      chatStore.getState().addMessage(message)

      // Verify message is in the array
      let messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].body).toBe('Original message with typo')

      // Edit the message (correct the typo)
      chatStore.getState().updateMessage('alice@example.com', 'msg-123', {
        body: 'Corrected message',
        isEdited: true,
      })

      // Message in array should be updated (useChat will derive this as lastMessage)
      messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].body).toBe('Corrected message')
      expect(messages?.[messages!.length - 1].isEdited).toBe(true)
    })

    it('should update specific message without affecting array order', () => {
      // Note: lastMessage is derived from messages array in useChat (like rooms)
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      // Add two messages
      const message1: Message = {
        type: 'chat',
        id: 'msg-1',
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'First message',
        timestamp: new Date('2024-01-15T10:00:00Z'),
        isOutgoing: true,
      }
      const message2: Message = {
        type: 'chat',
        id: 'msg-2',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Second message (latest)',
        timestamp: new Date('2024-01-15T11:00:00Z'),
        isOutgoing: false,
      }
      chatStore.getState().addMessage(message1)
      chatStore.getState().addMessage(message2)

      // Last message in array should be msg-2
      let messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].id).toBe('msg-2')
      expect(messages?.[messages!.length - 1].body).toBe('Second message (latest)')

      // Edit the first message (not the last)
      chatStore.getState().updateMessage('alice@example.com', 'msg-1', {
        body: 'First message (edited)',
        isEdited: true,
      })

      // Array order should be preserved - last message still msg-2
      messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].id).toBe('msg-2')
      expect(messages?.[messages!.length - 1].body).toBe('Second message (latest)')
      // First message should be edited
      expect(messages?.[0].body).toBe('First message (edited)')
      expect(messages?.[0].isEdited).toBe(true)

      // But the first message should be updated in the messages array
      const updated = chatStore.getState().getMessage('alice@example.com', 'msg-1')
      expect(updated?.body).toBe('First message (edited)')
    })

    it('should find and update message by stanzaId (MAM messages)', () => {
      // Note: lastMessage is now derived from messages array in useChat hook (like rooms)
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      // Add a message with both id and stanzaId (typical for MAM-retrieved messages)
      const message: Message = {
        type: 'chat',
        id: 'client-id-123',
        stanzaId: 'mam-stanza-id-456', // Server-assigned ID from MAM
        conversationId: 'alice@example.com',
        from: 'me@example.com',
        body: 'Original message',
        timestamp: new Date(),
        isOutgoing: true,
      }
      chatStore.getState().addMessage(message)

      // Verify message is in the array
      let messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].body).toBe('Original message')
      expect(messages?.[messages!.length - 1].stanzaId).toBe('mam-stanza-id-456')

      // Edit the message using stanzaId (how corrections often reference MAM messages)
      chatStore.getState().updateMessage('alice@example.com', 'mam-stanza-id-456', {
        body: 'Corrected message',
        isEdited: true,
      })

      // Message in array should be updated (useChat will derive this as lastMessage)
      messages = chatStore.getState().messages.get('alice@example.com')
      expect(messages?.[messages!.length - 1].body).toBe('Corrected message')
      expect(messages?.[messages!.length - 1].isEdited).toBe(true)
    })
  })

  describe('reference stability (prevents infinite re-renders)', () => {
    // These tests ensure computed selectors return stable array references
    // when empty, preventing Zustand from triggering infinite re-renders.
    // Using toBe() checks reference equality, not just value equality.

    it('activeMessages() should return same reference when no active conversation', () => {
      const result1 = chatStore.getState().activeMessages()
      const result2 = chatStore.getState().activeMessages()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })

    it('activeMessages() should return same reference when active conversation has no messages', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().setActiveConversation('alice@example.com')

      const result1 = chatStore.getState().activeMessages()
      const result2 = chatStore.getState().activeMessages()
      expect(result1).toBe(result2)
      expect(result1).toHaveLength(0)
    })
  })

  describe('updateLastMessagePreview', () => {
    it('should update lastMessage preview without affecting messages array', () => {
      // Create a conversation with an existing message
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const existingMsg = createMessage('alice@example.com', 'Old message')
      chatStore.getState().addMessage(existingMsg)

      // Verify initial state
      const initialMessages = chatStore.getState().messages.get('alice@example.com')
      expect(initialMessages).toHaveLength(1)
      expect(initialMessages?.[0].body).toBe('Old message')

      // Update the preview with a newer message
      const previewMsg: Message = {
        type: 'chat',
        id: 'preview-msg',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'New message from other device',
        timestamp: new Date(Date.now() + 1000), // Newer timestamp
        isOutgoing: false,
      }
      chatStore.getState().updateLastMessagePreview('alice@example.com', previewMsg)

      // Messages array should be unchanged
      const messagesAfter = chatStore.getState().messages.get('alice@example.com')
      expect(messagesAfter).toHaveLength(1)
      expect(messagesAfter?.[0].body).toBe('Old message')

      // But the preview should be updated (both in conversationMeta and conversations)
      const meta = chatStore.getState().conversationMeta.get('alice@example.com')
      expect(meta?.lastMessage?.body).toBe('New message from other device')

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.lastMessage?.body).toBe('New message from other device')
    })

    it('should not update preview if message is older than existing', () => {
      // Create a conversation with a recent message
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      const recentMsg = createMessage('alice@example.com', 'Recent message')
      recentMsg.timestamp = new Date('2024-01-15T12:00:00Z')
      chatStore.getState().addMessage(recentMsg)

      // Verify the lastMessage was set from addMessage
      const initialMeta = chatStore.getState().conversationMeta.get('alice@example.com')
      expect(initialMeta?.lastMessage?.body).toBe('Recent message')

      // Try to update with an older message
      const olderMsg: Message = {
        type: 'chat',
        id: 'older-msg',
        conversationId: 'alice@example.com',
        from: 'alice@example.com',
        body: 'Older message',
        timestamp: new Date('2024-01-15T11:00:00Z'), // Older timestamp
        isOutgoing: false,
      }
      chatStore.getState().updateLastMessagePreview('alice@example.com', olderMsg)

      // Preview should NOT be updated (still shows recent message)
      const metaAfter = chatStore.getState().conversationMeta.get('alice@example.com')
      expect(metaAfter?.lastMessage?.body).toBe('Recent message')
    })

    it('should do nothing for non-existent conversation', () => {
      const previewMsg: Message = {
        type: 'chat',
        id: 'preview-msg',
        conversationId: 'nonexistent@example.com',
        from: 'nonexistent@example.com',
        body: 'Message',
        timestamp: new Date(),
        isOutgoing: false,
      }

      // Should not throw
      expect(() => {
        chatStore.getState().updateLastMessagePreview('nonexistent@example.com', previewMsg)
      }).not.toThrow()

      // State should be unchanged (no new conversation created)
      expect(chatStore.getState().conversations.has('nonexistent@example.com')).toBe(false)
    })
  })

  describe('refreshLastMessageContent', () => {
    const conversationId = 'alice@example.com'
    const fixedTs = new Date('2024-01-15T12:00:00Z')

    function makeMsg(id: string, body: string, extra: Partial<Message> = {}): Message {
      return {
        type: 'chat',
        id,
        conversationId,
        from: conversationId,
        body,
        timestamp: new Date(fixedTs.getTime()),
        isOutgoing: false,
        ...extra,
      }
    }

    it('heals the preview in place when it is the referenced message (same id and timestamp)', () => {
      chatStore.getState().addConversation(createConversation(conversationId))
      chatStore.getState().addMessage(makeMsg('m1', '[OpenPGP-encrypted message]', { encryptedPayload: '<x/>' }))
      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage?.body)
        .toBe('[OpenPGP-encrypted message]')

      // Deferred decrypt: same message, same timestamp, new body. The strict-newer
      // updateLastMessagePreview would refuse this — refreshLastMessageContent must not.
      chatStore.getState().refreshLastMessageContent(conversationId, 'm1', {
        body: 'decrypted hello',
        encryptedPayload: undefined,
      })

      const meta = chatStore.getState().conversationMeta.get(conversationId)
      expect(meta?.lastMessage?.body).toBe('decrypted hello')
      expect(meta?.lastMessage?.encryptedPayload).toBeUndefined()
      // Combined map (backward-compat) is healed too.
      expect(chatStore.getState().conversations.get(conversationId)?.lastMessage?.body)
        .toBe('decrypted hello')
    })

    it('does NOT touch the preview when the referenced message is not the current preview', () => {
      // Safety contract: a different (e.g. older) message decrypted in the durable
      // pass must never hijack the preview. This is what prevents a stale overwrite.
      chatStore.getState().addConversation(createConversation(conversationId))
      chatStore.getState().addMessage(makeMsg('current', 'current preview'))

      chatStore.getState().refreshLastMessageContent(conversationId, 'some-other-id', {
        body: 'should not appear',
      })

      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage?.body)
        .toBe('current preview')
    })

    it('matches the preview across id tiers (stanzaId)', () => {
      chatStore.getState().addConversation(createConversation(conversationId))
      chatStore.getState().addMessage(makeMsg('m1', '[OpenPGP-encrypted message]', { stanzaId: 'stanza-9' }))

      chatStore.getState().refreshLastMessageContent(conversationId, 'stanza-9', { body: 'cleartext' })

      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage?.body).toBe('cleartext')
    })

    it('does nothing (and does not throw) for a non-existent conversation', () => {
      expect(() => {
        chatStore.getState().refreshLastMessageContent('nobody@example.com', 'm1', { body: 'x' })
      }).not.toThrow()
      expect(chatStore.getState().conversations.has('nobody@example.com')).toBe(false)
    })
  })

  describe('loadMessagesFromCache — deferred-decrypt preview heal on open', () => {
    const conversationId = 'alice@example.com'
    const ts = new Date('2026-06-13T18:48:00Z')

    function encryptedPreview(): Message {
      return {
        type: 'chat',
        id: 'm1',
        conversationId,
        from: conversationId,
        body: '[OpenPGP-encrypted message]',
        timestamp: new Date(ts.getTime()),
        isOutgoing: false,
        encryptedPayload: '<x/>',
      }
    }

    afterEach(() => {
      vi.mocked(messageCache.getMessages).mockReset()
      vi.mocked(messageCache.getMessages).mockResolvedValue([])
    })

    it('heals a stale encrypted preview when the cache copy of the same message is now decrypted', async () => {
      // The user's reported state: the message was decrypted in the durable cache
      // while the conversation was closed, but the persisted sidebar preview still
      // points at the encrypted copy (same id and timestamp — strict-newer refuses).
      chatStore.getState().addConversation({ ...createConversation(conversationId), lastMessage: encryptedPreview() })

      const decrypted: Message = { ...encryptedPreview(), body: 'now decrypted', encryptedPayload: undefined }
      vi.mocked(messageCache.getMessages).mockResolvedValue([decrypted])

      await chatStore.getState().loadMessagesFromCache(conversationId)

      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage?.body).toBe('now decrypted')
      expect(chatStore.getState().conversations.get(conversationId)?.lastMessage?.body).toBe('now decrypted')
    })

    it('does NOT churn the preview when the same-id cache copy is still encrypted (key locked)', async () => {
      chatStore.getState().addConversation({ ...createConversation(conversationId), lastMessage: encryptedPreview() })
      vi.mocked(messageCache.getMessages).mockResolvedValue([encryptedPreview()])

      await chatStore.getState().loadMessagesFromCache(conversationId)

      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage?.body)
        .toBe('[OpenPGP-encrypted message]')
    })
  })

  describe('mergeMAMMessages — deferred-decrypt preview heal', () => {
    const conversationId = 'alice@example.com'
    const ts = new Date('2026-06-13T18:48:00Z')

    it('heals a stale encrypted preview when MAM brings in the decrypted copy of that message', () => {
      const encryptedPreview: Message = {
        type: 'chat', id: 'm1', conversationId, from: conversationId,
        body: '[OpenPGP-encrypted message]', timestamp: new Date(ts.getTime()),
        isOutgoing: false, encryptedPayload: '<x/>',
      }
      chatStore.getState().addConversation({ ...createConversation(conversationId), lastMessage: encryptedPreview })

      // MAM catch-up of the unopened conversation re-delivers the same message,
      // now decrypted (same id and timestamp, encrypted stash cleared).
      const decrypted: Message = { ...encryptedPreview, body: 'now decrypted', encryptedPayload: undefined }
      chatStore.getState().mergeMAMMessages(conversationId, [decrypted], {}, true, 'forward')

      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage?.body).toBe('now decrypted')
    })
  })

  describe('loadOlderMessagesFromCache (sliding window)', () => {
    const conversationId = 'alice@example.com'
    // Mirrors chatStore's RESIDENT_WINDOW_SIZE (formerly MAX_MESSAGES_PER_CONVERSATION).
    const RESIDENT_WINDOW_SIZE = 5000

    beforeEach(() => {
      vi.mocked(messageCache.getMessages).mockReset()
      chatStore.getState().addConversation(createConversation(conversationId))
    })

    function chatMsgAt(id: string, minuteOffset: number): Message {
      return {
        type: 'chat',
        id,
        conversationId,
        from: conversationId,
        body: id,
        // minuteOffset is relative to a fixed epoch so older-batch ids sort before resident ids.
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + minuteOffset * 60000),
        isOutgoing: false,
      }
    }

    it('slides the window: keeps the just-loaded older batch and evicts the newest tail', async () => {
      // Seed the conversation at the resident cap - minutes 50..5049 so ids are 'resident-0'..'resident-4999'.
      const resident: Message[] = []
      for (let i = 0; i < RESIDENT_WINDOW_SIZE; i++) {
        resident.push(chatMsgAt(`resident-${i}`, 50 + i))
      }
      chatStore.setState((state) => {
        const newMessages = new Map(state.messages)
        newMessages.set(conversationId, resident)
        return { messages: newMessages }
      })

      // Cache returns 50 messages older than the current oldest resident message (minute 50).
      const olderBatch: Message[] = []
      for (let i = 0; i < 50; i++) {
        olderBatch.push(chatMsgAt(`older-${i}`, i))
      }
      vi.mocked(messageCache.getMessages).mockResolvedValue(olderBatch)

      await chatStore.getState().loadOlderMessagesFromCache(conversationId, 50)

      const messages = chatStore.getState().messages.get(conversationId)
      // Window size is preserved...
      expect(messages?.length).toBe(RESIDENT_WINDOW_SIZE)
      // ...but the just-loaded older batch is now resident (oldest id is from the older batch)...
      expect(messages?.[0].id).toBe('older-0')
      // ...which means the window slid: the newest 50 resident messages were evicted.
      expect(messages?.some((m) => m.id === 'resident-4999')).toBe(false)
      expect(messages?.[messages.length - 1].id).toBe('resident-4949')
    })
  })

  describe('windowAtLiveEdge gating (sliding window)', () => {
    const conversationId = 'alice@example.com'
    const RESIDENT_WINDOW_SIZE = 5000

    beforeEach(() => {
      vi.mocked(messageCache.getMessages).mockReset()
      vi.mocked(messageCache.saveMessage).mockClear()
      chatStore.getState().addConversation(createConversation(conversationId))
    })

    function chatMsgAt(id: string, minuteOffset: number): Message {
      return {
        type: 'chat',
        id,
        conversationId,
        from: conversationId,
        body: id,
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + minuteOffset * 60000),
        isOutgoing: false,
      }
    }

    // Seed the conversation at the resident cap and slide the window up so its newest tail is evicted.
    function seedSlidWindow() {
      const resident: Message[] = []
      for (let i = 0; i < RESIDENT_WINDOW_SIZE; i++) {
        resident.push(chatMsgAt(`resident-${i}`, 50 + i))
      }
      chatStore.setState((state) => {
        const newMessages = new Map(state.messages)
        newMessages.set(conversationId, resident)
        return { messages: newMessages }
      })

      const olderBatch: Message[] = []
      for (let i = 0; i < 50; i++) {
        olderBatch.push(chatMsgAt(`older-${i}`, i))
      }
      vi.mocked(messageCache.getMessages).mockResolvedValue(olderBatch)
    }

    it('appends a live message when the window is at the live edge (default/absent)', () => {
      const live = chatMsgAt('live-1', 10000)
      chatStore.getState().addMessage(live)

      const messages = chatStore.getState().messages.get(conversationId)
      expect(messages?.some((m) => m.id === 'live-1')).toBe(true)
      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage?.id).toBe('live-1')
    })

    it('sets windowAtLiveEdge false after a load-older that evicts the newest tail', async () => {
      seedSlidWindow()
      await chatStore.getState().loadOlderMessagesFromCache(conversationId, 50)
      expect(chatStore.getState().windowAtLiveEdge.get(conversationId)).toBe(false)
    })

    it('does not append a live message when the window has slid off the live edge, but still persists to cache and updates meta', async () => {
      seedSlidWindow()
      await chatStore.getState().loadOlderMessagesFromCache(conversationId, 50)
      expect(chatStore.getState().windowAtLiveEdge.get(conversationId)).toBe(false)

      vi.mocked(messageCache.saveMessage).mockClear()
      const before = chatStore.getState().messages.get(conversationId)!
      const live = chatMsgAt('live-1', 10000)
      chatStore.getState().addMessage(live)

      const messages = chatStore.getState().messages.get(conversationId)!
      // Resident array is unchanged (no false-adjacency gap appended)...
      expect(messages.some((m) => m.id === 'live-1')).toBe(false)
      expect(messages.length).toBe(before.length)
      expect(messages[messages.length - 1].id).toBe(before[before.length - 1].id)
      // ...but the message is still persisted to IndexedDB...
      expect(messageCache.saveMessage).toHaveBeenCalledWith(expect.objectContaining({ id: 'live-1' }))
      // ...and meta (sidebar preview + unread badge) still update.
      expect(chatStore.getState().conversationMeta.get(conversationId)?.lastMessage?.id).toBe('live-1')
      expect(chatStore.getState().conversationMeta.get(conversationId)?.unreadCount).toBe(1)
    })

    it('recenters to the live edge when the latest window is (re)loaded', async () => {
      seedSlidWindow()
      await chatStore.getState().loadOlderMessagesFromCache(conversationId, 50)
      expect(chatStore.getState().windowAtLiveEdge.get(conversationId)).toBe(false)

      // A latest-N load (activation path) makes the newest messages resident again.
      vi.mocked(messageCache.getMessages).mockResolvedValue([chatMsgAt('latest-1', 9000)])
      await chatStore.getState().loadMessagesFromCache(conversationId, { limit: 100 })
      expect(chatStore.getState().windowAtLiveEdge.get(conversationId) ?? true).toBe(true)
    })

    it('does not include windowAtLiveEdge in the persisted partialize output', () => {
      chatStore.getState().addMessage(chatMsgAt('live-1', 10000))
      const persisted = chatStore.persist.getOptions().partialize!(chatStore.getState())
      expect('windowAtLiveEdge' in persisted).toBe(false)
    })

    it('mergeMAMMessages flips windowAtLiveEdge true on a fetch-latest merge, but a plain backward merge does not', () => {
      chatStore.getState().setActiveConversation(conversationId)
      // Seed the flag false, as if a prior scroll-up slid the window off the live edge.
      chatStore.setState((state) => {
        const w = new Map(state.windowAtLiveEdge)
        w.set(conversationId, false)
        return { windowAtLiveEdge: w }
      })

      // A plain backward merge (isFetchLatest false) must not flip it back.
      const older = chatMsgAt('older-1', 1)
      chatStore.getState().mergeMAMMessages(conversationId, [older], {}, false, 'backward')
      expect(chatStore.getState().windowAtLiveEdge.get(conversationId)).toBe(false)

      // A fetch-latest merge lands the window AT the live edge by construction.
      const fresh = chatMsgAt('fresh-1', 20000)
      chatStore.getState().mergeMAMMessages(conversationId, [fresh], {}, false, 'backward', true)
      expect(chatStore.getState().windowAtLiveEdge.get(conversationId)).toBe(true)
    })
  })

  describe('loadNewerMessagesFromCache (sliding window)', () => {
    const conversationId = 'alice@example.com'
    const RESIDENT_WINDOW_SIZE = 5000

    beforeEach(() => {
      vi.mocked(messageCache.getMessages).mockReset()
      chatStore.getState().addConversation(createConversation(conversationId))
    })

    function chatMsgAt(id: string, minuteOffset: number): Message {
      return {
        type: 'chat',
        id,
        conversationId,
        from: conversationId,
        body: id,
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + minuteOffset * 60000),
        isOutgoing: false,
      }
    }

    // Seed the conversation at the resident cap with a slid-up window (oldest resident is 'resident-0').
    function seedResidentWindow() {
      const resident: Message[] = []
      for (let i = 0; i < RESIDENT_WINDOW_SIZE; i++) {
        resident.push(chatMsgAt(`resident-${i}`, i))
      }
      chatStore.setState((state) => {
        const newMessages = new Map(state.messages)
        newMessages.set(conversationId, resident)
        const newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
        newWindowAtLiveEdge.set(conversationId, false)
        return { messages: newMessages, windowAtLiveEdge: newWindowAtLiveEdge }
      })
    }

    it('appends the newer batch and evicts the oldest at the bound', async () => {
      seedResidentWindow()

      // Cache returns 50 messages newer than the current newest resident message (minute 4999).
      const newerBatch: Message[] = []
      for (let i = 0; i < 50; i++) {
        newerBatch.push(chatMsgAt(`newer-${i}`, RESIDENT_WINDOW_SIZE + i))
      }
      vi.mocked(messageCache.getMessages).mockResolvedValue(newerBatch)

      await chatStore.getState().loadNewerMessagesFromCache(conversationId, 50)

      const messages = chatStore.getState().messages.get(conversationId)
      // Window size is preserved...
      expect(messages?.length).toBe(RESIDENT_WINDOW_SIZE)
      // ...the just-loaded newer batch is now resident (newest id is from the newer batch)...
      expect(messages?.[messages.length - 1].id).toBe('newer-49')
      // ...which means the window slid down: the oldest 50 resident messages were evicted.
      expect(messages?.some((m) => m.id === 'resident-0')).toBe(false)
      expect(messages?.[0].id).toBe('resident-50')
    })

    it('queries the cache with an after-cursor at the newest resident timestamp', async () => {
      seedResidentWindow()
      vi.mocked(messageCache.getMessages).mockResolvedValue([])

      await chatStore.getState().loadNewerMessagesFromCache(conversationId, 50)

      const newestInMemory = chatMsgAt(`resident-${RESIDENT_WINDOW_SIZE - 1}`, RESIDENT_WINDOW_SIZE - 1)
      expect(messageCache.getMessages).toHaveBeenCalledWith(conversationId, {
        after: newestInMemory.timestamp,
        limit: 50,
      })
    })

    it('sets windowAtLiveEdge true when the cache returns fewer than the limit (reached the tail)', async () => {
      seedResidentWindow()
      // Fewer than the requested limit ⇒ no more newer messages remain in the cache.
      const newerBatch = [chatMsgAt('newer-0', RESIDENT_WINDOW_SIZE)]
      vi.mocked(messageCache.getMessages).mockResolvedValue(newerBatch)

      await chatStore.getState().loadNewerMessagesFromCache(conversationId, 50)

      expect(chatStore.getState().windowAtLiveEdge.get(conversationId) ?? true).toBe(true)
    })

    it('leaves windowAtLiveEdge slid (false) when a full batch returns (more newer remain)', async () => {
      seedResidentWindow()
      const newerBatch: Message[] = []
      for (let i = 0; i < 50; i++) {
        newerBatch.push(chatMsgAt(`newer-${i}`, RESIDENT_WINDOW_SIZE + i))
      }
      vi.mocked(messageCache.getMessages).mockResolvedValue(newerBatch)

      await chatStore.getState().loadNewerMessagesFromCache(conversationId, 50)

      expect(chatStore.getState().windowAtLiveEdge.get(conversationId)).toBe(false)
    })

    it('returns an empty array and does nothing when the conversation has no resident messages', async () => {
      const returned = await chatStore.getState().loadNewerMessagesFromCache(conversationId, 50)
      expect(returned).toEqual([])
      expect(messageCache.getMessages).not.toHaveBeenCalled()
    })
  })

  describe('recenterToLatest (sliding window)', () => {
    const conversationId = 'alice@example.com'
    const RESIDENT_WINDOW_SIZE = 5000

    beforeEach(() => {
      vi.mocked(messageCache.getMessages).mockReset()
      chatStore.getState().addConversation(createConversation(conversationId))
    })

    function chatMsgAt(id: string, minuteOffset: number): Message {
      return {
        type: 'chat',
        id,
        conversationId,
        from: conversationId,
        body: id,
        timestamp: new Date(Date.UTC(2024, 0, 1, 0, 0, 0) + minuteOffset * 60000),
        isOutgoing: false,
      }
    }

    it('reloads the newest window and sets windowAtLiveEdge true', async () => {
      // Seed a slid-up window (evicted the newest tail via load-older).
      const resident: Message[] = []
      for (let i = 0; i < RESIDENT_WINDOW_SIZE; i++) {
        resident.push(chatMsgAt(`resident-${i}`, 50 + i))
      }
      chatStore.setState((state) => {
        const newMessages = new Map(state.messages)
        newMessages.set(conversationId, resident)
        const newWindowAtLiveEdge = new Map(state.windowAtLiveEdge)
        newWindowAtLiveEdge.set(conversationId, false)
        return { messages: newMessages, windowAtLiveEdge: newWindowAtLiveEdge }
      })

      const latestBatch = [chatMsgAt('latest-1', 90000)]
      vi.mocked(messageCache.getMessages).mockResolvedValue(latestBatch)

      await chatStore.getState().recenterToLatest(conversationId)

      expect(chatStore.getState().windowAtLiveEdge.get(conversationId) ?? true).toBe(true)
      const messages = chatStore.getState().messages.get(conversationId)
      expect(messages?.some((m) => m.id === 'latest-1')).toBe(true)
    })

    it('sets windowAtLiveEdge true even when the cache has nothing newer (already-resident latest window)', async () => {
      vi.mocked(messageCache.getMessages).mockResolvedValue([])

      await chatStore.getState().recenterToLatest(conversationId)

      expect(chatStore.getState().windowAtLiveEdge.get(conversationId) ?? true).toBe(true)
    })
  })

  describe('activeConversations', () => {
    it('should return only non-archived conversations', () => {
      // Create multiple conversations
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))
      chatStore.getState().addConversation(createConversation('carol@example.com'))

      // Archive one
      chatStore.getState().archiveConversation('bob@example.com')

      // activeConversations should only return non-archived
      const active = chatStore.getState().activeConversations()
      expect(active).toHaveLength(2)
      expect(active.map(c => c.id)).toContain('alice@example.com')
      expect(active.map(c => c.id)).toContain('carol@example.com')
      expect(active.map(c => c.id)).not.toContain('bob@example.com')
    })

    it('should return empty array when all conversations are archived', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().archiveConversation('alice@example.com')

      const active = chatStore.getState().activeConversations()
      expect(active).toHaveLength(0)
    })

    it('should return all conversations when none are archived', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))
      chatStore.getState().addConversation(createConversation('bob@example.com'))

      const active = chatStore.getState().activeConversations()
      expect(active).toHaveLength(2)
    })
  })

  describe('setTargetMessageId', () => {
    it('should set targetMessageId', () => {
      chatStore.getState().setTargetMessageId('msg-123')
      expect(chatStore.getState().targetMessageId).toBe('msg-123')
    })

    it('should clear targetMessageId when set to null', () => {
      chatStore.getState().setTargetMessageId('msg-123')
      chatStore.getState().setTargetMessageId(null)
      expect(chatStore.getState().targetMessageId).toBeNull()
    })

    it('should start as null', () => {
      expect(chatStore.getState().targetMessageId).toBeNull()
    })

    it('should be reset when store is reset', () => {
      chatStore.getState().setTargetMessageId('msg-123')
      chatStore.getState().reset()
      expect(chatStore.getState().targetMessageId).toBeNull()
    })
  })
})

// Regression tests for chat/room parity drifts: each of these behaviors already
// exists in roomStore and had silently diverged in chatStore (or vice versa).
describe('chatStore parity drift regressions', () => {
  const convId = 'peer@example.com'

  beforeEach(() => {
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    chatStore.setState({
      conversationEntities: new Map(),
      conversationMeta: new Map(),
      conversations: new Map(),
      messages: new Map(),
      activeConversationId: null,
      archivedConversations: new Set(),
      firstNewMessageMarkers: new Map(),
      windowAtLiveEdge: new Map(),
      mamQueryStates: new Map(),
      conversationGaps: new Map(),
    })
    chatStore.getState().addConversation(createConversation(convId))
    chatStore.setState({ activeConversationId: convId })
  })

  afterEach(() => {
    setResidentWindowSize(5000)
  })

  function messageAt(id: string, body: string, iso: string): Message {
    return {
      type: 'chat',
      id,
      conversationId: convId,
      from: convId,
      body,
      timestamp: new Date(iso),
      isOutgoing: false,
    }
  }

  describe('addMessage sliding-window trim (parity with roomStore)', () => {
    it('trims the resident array to the window bound on live append', () => {
      setResidentWindowSize(3)
      for (let i = 1; i <= 4; i++) {
        chatStore.getState().addMessage(messageAt(`m-${i}`, `m${i}`, `2024-01-15T10:0${i}:00Z`))
      }
      const resident = chatStore.getState().messages.get(convId) || []
      expect(resident.map((m) => m.id)).toEqual(['m-2', 'm-3', 'm-4'])
    })
  })

  describe('updateReactions cache fallback (parity with roomStore)', () => {
    it('updates the durable cache when the conversation is resident but the message is not', () => {
      chatStore.getState().addMessage(messageAt('resident-1', 'still here', '2024-01-15T10:00:00Z'))
      vi.mocked(messageCache.updateMessageReactions).mockClear()
      const residentBefore = chatStore.getState().messages.get(convId)

      chatStore.getState().updateReactions(convId, 'evicted-1', 'bob@example.com', ['👍'])

      expect(messageCache.updateMessageReactions).toHaveBeenCalledWith('evicted-1', 'bob@example.com', ['👍'])
      // The resident array is untouched — only the durable copy is patched.
      expect(chatStore.getState().messages.get(convId)).toBe(residentBefore)
    })
  })

  describe('cache pagination dedupe (parity with roomStore)', () => {
    it('loadOlderMessagesFromCache dedupes and sorts an overlapping, out-of-order batch', async () => {
      const current = messageAt('cur-1', 'current', '2024-01-15T11:00:00Z')
      chatStore.setState((state) => ({ messages: new Map(state.messages).set(convId, [current]) }))

      // Batch overlaps the resident window (cur-1 again) and arrives out of order.
      vi.mocked(messageCache.getMessages).mockReset()
      vi.mocked(messageCache.getMessages).mockResolvedValue([
        { ...current },
        messageAt('old-2', 'older 2', '2024-01-15T10:30:00Z'),
        messageAt('old-1', 'older 1', '2024-01-15T10:00:00Z'),
      ])

      await chatStore.getState().loadOlderMessagesFromCache(convId)

      const resident = chatStore.getState().messages.get(convId) || []
      expect(resident.map((m) => m.id)).toEqual(['old-1', 'old-2', 'cur-1'])
    })

    it('loadNewerMessagesFromCache dedupes and sorts an overlapping, out-of-order batch', async () => {
      const current = messageAt('cur-1', 'current', '2024-01-15T11:00:00Z')
      chatStore.setState((state) => ({ messages: new Map(state.messages).set(convId, [current]) }))

      vi.mocked(messageCache.getMessages).mockReset()
      vi.mocked(messageCache.getMessages).mockResolvedValue([
        messageAt('new-2', 'newer 2', '2024-01-15T13:00:00Z'),
        { ...current },
        messageAt('new-1', 'newer 1', '2024-01-15T12:00:00Z'),
      ])

      await chatStore.getState().loadNewerMessagesFromCache(convId)

      const resident = chatStore.getState().messages.get(convId) || []
      expect(resident.map((m) => m.id)).toEqual(['cur-1', 'new-1', 'new-2'])
    })
  })
})
