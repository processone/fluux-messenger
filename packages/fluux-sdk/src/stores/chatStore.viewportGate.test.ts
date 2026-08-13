/**
 * SDK-owned generation-scoped viewport evidence gates the
 * on-arrival pointer advance.
 *
 * Exercised against the REAL chatStore (not just the pure `notificationState`
 * functions covered by `notificationState.test.ts`) so the WIRING itself is
 * under test: `setActiveConversation` is the SOLE caller of
 * `beginViewportGeneration`, and `addMessage` derives
 * `EntityContext.viewportAtLiveEdge` from `currentViewportEvidence`. A pure
 * notificationState-level pass proves the gate logic but cannot catch a
 * mis-wired call site (e.g. a stray `beginViewportGeneration` call from the
 * view, or `addMessage` reading the wrong key).
 *
 * Acceptance scenarios 8 and 9 — see
 * docs/superpowers/specs/2026-07-23-read-state-unread-count-single-source-acceptance.md
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatStore } from './chatStore'
import { connectionStore } from './connectionStore'
import type { Message, Conversation } from '../core/types'
import { getLocalPart } from '../core/jid'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../utils/storageScope'
import { _clearAllTransientForTesting } from './shared/transientUnread'
import type { ReadPointer } from './shared/readPointer'
import {
  currentViewportGeneration,
  currentViewportEvidence,
  reportViewport,
  _clearAllViewportEvidenceForTesting,
  type EvidenceKey,
} from './shared/viewportEvidence'

vi.mock('../utils/messageCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/messageCache')>()
  return {
    ...actual,
    saveMessage: vi.fn().mockResolvedValue(undefined),
    saveMessages: vi.fn().mockResolvedValue(true),
    getMessages: vi.fn().mockResolvedValue([]),
    getMessagesAround: vi.fn().mockResolvedValue([]),
    updateMessage: vi.fn().mockResolvedValue(undefined),
    updateMessageReactions: vi.fn().mockResolvedValue(true),
  }
})

const localStorageMock = (() => {
  let store: Record<string, string> = {}
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value
    },
    removeItem: (key: string) => {
      delete store[key]
    },
    clear: () => {
      store = {}
    },
  }
})()
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

function createConversation(id: string): Conversation {
  return {
    id,
    name: getLocalPart(id),
    type: 'chat',
    unreadCount: 0,
  }
}

let msgCounter = 0
function createMessage(conversationId: string, body: string, overrides: Partial<Message> = {}): Message {
  msgCounter += 1
  return {
    type: 'chat',
    id: `msg-${msgCounter}`,
    conversationId,
    from: conversationId,
    body,
    timestamp: new Date(`2025-01-15T09:${String(msgCounter).padStart(2, '0')}:00Z`),
    isOutgoing: false,
    ...overrides,
  }
}

function evidenceKey(conversationId: string): EvidenceKey {
  return { kind: 'chat', entityId: conversationId, accountScope: getStorageScopeJid() ?? '' }
}

/** Simulate the view's `reportLiveEdge` callback, reporting against the CURRENT generation. */
function reportCurrent(conversationId: string, evidence: 'at-edge' | 'away'): void {
  const key = evidenceKey(conversationId)
  reportViewport(key, currentViewportGeneration(key), evidence)
}

/**
 * Directly patch a distinguishing "prior read state" (nonzero unreadCount +
 * a named read pointer) onto an ALREADY-ACTIVATED conversation. `addMessage`
 * requires both `conversations` and `conversationMeta` entries to run its
 * counting logic — `setActiveConversation` itself always marks-as-read via
 * `onActivate` (there are no loaded messages in this lightweight test file,
 * so `onActivate` snaps straight to unreadCount 0), so a distinguishing
 * baseline has to be injected AFTER activation, not before — patching state
 * directly (as chatStore.internal.mds.test.ts's `seedWithPointer` does) bypasses that
 * reset without touching the SDK's own activation code path under test.
 */
function setPriorReadState(id: string, unreadCount: number, priorMessageId: string): void {
  const priorPointer: ReadPointer = { order: { role: 'floor', timestamp: new Date('2025-01-15T08:00:00Z').getTime() }, identity: { state: 'local', messageId: priorMessageId } }
  chatStore.setState((state) => {
    const meta = state.conversationMeta.get(id)
    const conv = state.conversations.get(id)
    const newMeta = new Map(state.conversationMeta)
    newMeta.set(id, { ...(meta ?? { unreadCount: 0, readPointer: undefined }), unreadCount, readPointer: priorPointer })
    const newConversations = new Map(state.conversations)
    if (conv) newConversations.set(id, { ...conv, unreadCount, readPointer: priorPointer })
    return { conversationMeta: newMeta, conversations: newConversations }
  })
}

describe('chatStore viewport-evidence gate (Task 11)', () => {
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
      mamQueryStates: new Map(),
      conversationGaps: new Map(),
      conversationCoverage: new Map(),
      typingStates: new Map(),
      drafts: new Map(),
      windowAtLiveEdge: new Map(),
    })
    vi.clearAllMocks()
    _clearAllTransientForTesting()
    _clearAllViewportEvidenceForTesting()
    connectionStore.getState().setWindowVisible(true)
  })

  it('setActiveConversation begins a fresh generation SYNCHRONOUSLY (ordering requirement)', () => {
    chatStore.getState().addConversation(createConversation('alice@example.com'))
    // Never activated: generation 0 (the module's own "never began" sentinel).
    expect(currentViewportGeneration(evidenceKey('alice@example.com'))).toBe(0)

    chatStore.getState().setActiveConversation('alice@example.com')

    // Synchronously after the call returns — no microtask/await in between — the
    // generation must already have moved. This is what makes the render-time
    // `currentViewportGeneration(key)` read in ChatView correct: the SDK's
    // activation always runs before the view re-renders for the new entity.
    expect(currentViewportGeneration(evidenceKey('alice@example.com'))).toBeGreaterThan(0)
  })

  describe('scenario 8: on-arrival pointer-advance precondition', () => {
    // Seeded at a distinguishing nonzero unreadCount/readPointer so a broken
    // gate is caught by an inequality, not a 0 -> 0 / undefined -> undefined
    // tautology (this effort's recurring hollow-test defect).
    const PRIOR_MESSAGE_ID = 'prior-msg'

    function activateAndSeed(id: string): void {
      chatStore.getState().addConversation(createConversation(id))
      chatStore.getState().setActiveConversation(id)
      setPriorReadState(id, 4, PRIOR_MESSAGE_ID)
    }

    it('active + focused + SCROLLED UP (viewport reports "away"): pointer unchanged, unread increases', () => {
      activateAndSeed('alice@example.com')
      reportCurrent('alice@example.com', 'away')

      chatStore.getState().addMessage(createMessage('alice@example.com', 'incoming while scrolled up'))

      const conv = chatStore.getState().conversations.get('alice@example.com')
      // Break check (a): gating on `isActive && windowVisible` only would take the
      // "sees it" branch here and wrongly report unreadCount 4 (unchanged from the
      // seed, since force-zero was removed) / pointer advanced.
      expect(conv?.readPointer?.identity.messageId).toBe(PRIOR_MESSAGE_ID)
      expect(conv?.unreadCount).toBe(5)
    })

    it('active + focused + AT THE LIVE EDGE: pointer advances, count converges to 0', () => {
      activateAndSeed('alice@example.com')
      reportCurrent('alice@example.com', 'at-edge')

      const msg = createMessage('alice@example.com', 'incoming at the live edge')
      chatStore.getState().addMessage(msg)

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.readPointer?.identity.messageId).toBe(msg.id)
      expect(conv?.unreadCount).toBe(0)
    })

    it('active + focused + UNKNOWN viewport (never reported): treated as not-at-edge, pointer unchanged', () => {
      activateAndSeed('alice@example.com')
      // Deliberately no reportCurrent(...) call — evidence stays 'unknown'.

      chatStore.getState().addMessage(createMessage('alice@example.com', 'incoming, no report yet'))

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.readPointer?.identity.messageId).toBe(PRIOR_MESSAGE_ID)
      expect(conv?.unreadCount).toBe(5)
    })

    it('window hidden (existing gate, unaffected by Task 11): pointer unchanged even with an at-edge report', () => {
      activateAndSeed('alice@example.com')
      reportCurrent('alice@example.com', 'at-edge')
      // Window loses focus — the pre-existing gate this task does not touch.
      connectionStore.getState().setWindowVisible(false)

      chatStore.getState().addMessage(createMessage('alice@example.com', 'incoming while unfocused'))

      const conv = chatStore.getState().conversations.get('alice@example.com')
      expect(conv?.readPointer?.identity.messageId).toBe(PRIOR_MESSAGE_ID)
      expect(conv?.unreadCount).toBe(5)
    })
  })

  describe('scenario 9: viewport-evidence freshness across a conversation switch (switch-race)', () => {
    const PRIOR_A = 'prior-a'
    const PRIOR_B = 'prior-b'

    function setUpBoth(): void {
      chatStore.getState().addConversation(createConversation('convA@example.com'))
      chatStore.getState().addConversation(createConversation('convB@example.com'))
    }

    it("switching to B before B reports: an arrival in B does not advance B's pointer (unread increments)", () => {
      setUpBoth()

      // A active and genuinely at the bottom.
      chatStore.getState().setActiveConversation('convA@example.com')
      setPriorReadState('convA@example.com', 4, PRIOR_A)
      reportCurrent('convA@example.com', 'at-edge')

      // Switch to B — a NEW generation starts for B at 'unknown'.
      chatStore.getState().setActiveConversation('convB@example.com')
      setPriorReadState('convB@example.com', 4, PRIOR_B)

      // A message arrives in B BEFORE B has reported its own viewport state.
      chatStore.getState().addMessage(createMessage('convB@example.com', 'arrives before B reports'))

      const convB = chatStore.getState().conversations.get('convB@example.com')
      // Break check (b) territory: if B's evidence had inherited/started at-edge
      // (instead of 'unknown'), this would wrongly advance and zero the count.
      expect(convB?.readPointer?.identity.messageId).toBe(PRIOR_B)
      expect(convB?.unreadCount).toBe(5)
    })

    it("a late report carrying conversation A's key/generation never bleeds into B's evidence", () => {
      // This is the break check (b) the acceptance spec calls out verbatim:
      // "accept the stale-generation report → it flips B to at-edge and the
      // next arrival wrongly advances." The historical bug this guards against
      // is evidence stored in a single shared slot instead of scoped per KEY —
      // under that bug, ANY report (regardless of which entity it names) could
      // flip a shared flag that then governs every entity, including B.
      setUpBoth()

      chatStore.getState().setActiveConversation('convA@example.com')
      setPriorReadState('convA@example.com', 4, PRIOR_A)
      // A's own token is still current — it was never reactivated, so a report
      // against it is legitimately accepted for A's OWN key. That is harmless:
      // A is inactive, so `onMessageReceived`'s `isActive` gate alone keeps it
      // from ever advancing A's pointer. The property under test is that this
      // report — scoped to A's key — cannot possibly affect B's key.
      const aGeneration = currentViewportGeneration(evidenceKey('convA@example.com'))

      chatStore.getState().setActiveConversation('convB@example.com')
      setPriorReadState('convB@example.com', 4, PRIOR_B)

      reportViewport(evidenceKey('convA@example.com'), aGeneration, 'at-edge')

      chatStore.getState().addMessage(createMessage('convB@example.com', 'arrives after A (only) reports'))

      const convB = chatStore.getState().conversations.get('convB@example.com')
      expect(convB?.readPointer?.identity.messageId).toBe(PRIOR_B)
      expect(convB?.unreadCount).toBe(5)
      // B's OWN evidence is unaffected by a report scoped to A's key.
      expect(currentViewportEvidence(evidenceKey('convB@example.com'))).toBe('unknown')
    })

    it("after B reports at-edge on its OWN generation, a subsequent arrival in B may advance B's pointer", () => {
      setUpBoth()

      chatStore.getState().setActiveConversation('convA@example.com')
      reportCurrent('convA@example.com', 'at-edge')
      chatStore.getState().setActiveConversation('convB@example.com')
      setPriorReadState('convB@example.com', 4, PRIOR_B)

      // B reports on ITS OWN current generation.
      reportCurrent('convB@example.com', 'at-edge')

      const msg = createMessage('convB@example.com', 'arrives once B is genuinely at the edge')
      chatStore.getState().addMessage(msg)

      const convB = chatStore.getState().conversations.get('convB@example.com')
      expect(convB?.readPointer?.identity.messageId).toBe(msg.id)
      expect(convB?.unreadCount).toBe(0)
    })
  })

  describe('same-entity reactivation (Task 11 required test)', () => {
    const PRIOR = 'prior-msg'

    it('activate A, report at-edge, deactivate, re-activate A: the previous generation report is rejected, the new one is accepted', () => {
      chatStore.getState().addConversation(createConversation('alice@example.com'))

      chatStore.getState().setActiveConversation('alice@example.com')
      const firstGeneration = currentViewportGeneration(evidenceKey('alice@example.com'))
      reportCurrent('alice@example.com', 'at-edge')

      // Deactivate, then re-activate the SAME conversation — a NEW generation begins.
      chatStore.getState().setActiveConversation(null)
      chatStore.getState().setActiveConversation('alice@example.com')
      const secondGeneration = currentViewportGeneration(evidenceKey('alice@example.com'))
      expect(secondGeneration).not.toBe(firstGeneration)
      // Re-seed a distinguishing baseline for THIS (second) activation — the
      // re-activation itself marks-as-read again, same as the first one.
      setPriorReadState('alice@example.com', 4, PRIOR)

      // A late report still carrying the FIRST (now stale) generation token must be rejected.
      reportViewport(evidenceKey('alice@example.com'), firstGeneration, 'at-edge')
      chatStore.getState().addMessage(createMessage('alice@example.com', 'arrives after the stale re-activation report'))
      const convAfterStaleReport = chatStore.getState().conversations.get('alice@example.com')
      expect(convAfterStaleReport?.readPointer?.identity.messageId).toBe(PRIOR)
      expect(convAfterStaleReport?.unreadCount).toBe(5)

      // A report on the NEW (current) generation is accepted.
      reportViewport(evidenceKey('alice@example.com'), secondGeneration, 'at-edge')
      const msg = createMessage('alice@example.com', 'arrives once the new generation reports at-edge')
      chatStore.getState().addMessage(msg)
      const convAfterFreshReport = chatStore.getState().conversations.get('alice@example.com')
      expect(convAfterFreshReport?.readPointer?.identity.messageId).toBe(msg.id)
      expect(convAfterFreshReport?.unreadCount).toBe(0)
    })
  })
})
