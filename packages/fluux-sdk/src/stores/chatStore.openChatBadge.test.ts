/**
 * A 1:1 chat opened after a message arrived, then focused and at the bottom,
 * must clear its sidebar badge even when the "seen newest row" report reaches
 * the store before the "at the live edge" measurement (captain's report).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { chatStore } from './chatStore'
import { connectionStore } from './connectionStore'
import type { Message, Conversation } from '../core/types'
import { getLocalPart } from '../core/jid'
import { _resetStorageScopeForTesting, getStorageScopeJid } from '../utils/storageScope'
import { _clearAllTransientForTesting } from './shared/transientUnread'
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
    saveMessageWithResult: vi.fn().mockResolvedValue(true),
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
    stanzaId: undefined, originId: undefined,
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
import * as messageCache from '../utils/messageCache'

describe('open 1:1 chat at the bottom: the badge clears once the newest message is read', () => {
  beforeEach(() => {
    _resetStorageScopeForTesting()
    localStorageMock.clear()
    chatStore.setState({
      conversationEntities: new Map(), conversationMeta: new Map(), conversations: new Map(),
      messages: new Map(), activeConversationId: null, archivedConversations: new Set(),
      mamQueryStates: new Map(), conversationGaps: new Map(),
      // No coverage record: the archive recount stands down, as it does in a real
      // account whose history coverage is not established yet.
      conversationCoverage: new Map(),
      typingStates: new Map(), drafts: new Map(), windowAtLiveEdge: new Map(),
      firstNewMessageMarkers: new Map(), firstNewMessageCounts: new Map(), lastArrivedMessage: new Map(),
    })
    vi.clearAllMocks()
    _clearAllTransientForTesting()
    _clearAllViewportEvidenceForTesting()
    connectionStore.getState().setWindowVisible(true)
  })

  it('opening the chat on its one new message, seen before the view reports the live edge, leaves no badge', async () => {
    const ADRIEN = 'adrien@example.com'
    const OTHER = 'jerome@example.com'
    chatStore.getState().addConversation(createConversation(ADRIEN))
    chatStore.getState().addConversation(createConversation(OTHER))

    // The captain's own message, read at the bottom of the open chat.
    chatStore.getState().setActiveConversation(ADRIEN)
    reportCurrent(ADRIEN, 'at-edge')
    const own = createMessage(ADRIEN, 'Oh oui, ce sera bien de faire un bon blog post', { from: 'me@example.com', isOutgoing: true, stanzaId: 'sid-own' })
    chatStore.getState().addMessage(own)
    expect(chatStore.getState().conversations.get(ADRIEN)?.unreadCount).toBe(0)

    // Adrien replies while another chat is open.
    chatStore.getState().setActiveConversation(OTHER)
    const reply = createMessage(ADRIEN, "Presque 25% d'une année encore", { stanzaId: 'sid-reply' })
    chatStore.getState().addMessage(reply)
    expect(chatStore.getState().conversations.get(ADRIEN)?.unreadCount).toBe(1)

    // The captain opens Adrien's chat; the cache holds both rows.
    vi.mocked(messageCache.getMessages).mockResolvedValueOnce([own, reply] as never)
    await chatStore.getState().activateConversation(ADRIEN)
    expect(chatStore.getState().firstNewMessageMarkers.get(ADRIEN)?.id).toBe(reply.id)

    // Browser order measured in Chromium and WebKit: the viewport reports the newest row
    // as seen (~60 ms after activation), then reports the live edge (~280 ms).
    chatStore.getState().advanceReadPointer(ADRIEN, { id: reply.id })
    reportCurrent(ADRIEN, 'at-edge')
    await new Promise(resolve => setTimeout(resolve, 50))

    const state = chatStore.getState()
    const meta = state.conversationMeta.get(ADRIEN)
    expect(meta?.readPointer?.identity.messageId).toBe(reply.id)
    expect(currentViewportEvidence(evidenceKey(ADRIEN))).toBe('at-edge')
    expect(state.activeConversationId).toBe(ADRIEN)
    expect(connectionStore.getState().windowVisible).toBe(true)
    // Open, focused, at the bottom, newest message read: no badge.
    expect(state.conversations.get(ADRIEN)?.unreadCount).toBe(0)
  })
  it('control: the same journey with the live-edge report first clears the badge', async () => {
    const ADRIEN = 'adrien@example.com'
    const OTHER = 'jerome@example.com'
    chatStore.getState().addConversation(createConversation(ADRIEN))
    chatStore.getState().addConversation(createConversation(OTHER))

    // The captain's own message, read at the bottom of the open chat.
    chatStore.getState().setActiveConversation(ADRIEN)
    reportCurrent(ADRIEN, 'at-edge')
    const own = createMessage(ADRIEN, 'Oh oui, ce sera bien de faire un bon blog post', { from: 'me@example.com', isOutgoing: true, stanzaId: 'sid-own' })
    chatStore.getState().addMessage(own)
    expect(chatStore.getState().conversations.get(ADRIEN)?.unreadCount).toBe(0)

    // Adrien replies while another chat is open.
    chatStore.getState().setActiveConversation(OTHER)
    const reply = createMessage(ADRIEN, "Presque 25% d'une année encore", { stanzaId: 'sid-reply' })
    chatStore.getState().addMessage(reply)
    expect(chatStore.getState().conversations.get(ADRIEN)?.unreadCount).toBe(1)

    // The captain opens Adrien's chat; the cache holds both rows.
    vi.mocked(messageCache.getMessages).mockResolvedValueOnce([own, reply] as never)
    await chatStore.getState().activateConversation(ADRIEN)
    expect(chatStore.getState().firstNewMessageMarkers.get(ADRIEN)?.id).toBe(reply.id)

    // Browser order measured in Chromium and WebKit: the viewport reports the newest row
    // as seen (~60 ms after activation), then reports the live edge (~280 ms).
    reportCurrent(ADRIEN, 'at-edge')
    chatStore.getState().advanceReadPointer(ADRIEN, { id: reply.id })
    await new Promise(resolve => setTimeout(resolve, 50))

    const state = chatStore.getState()
    const meta = state.conversationMeta.get(ADRIEN)
    expect(meta?.readPointer?.identity.messageId).toBe(reply.id)
    expect(currentViewportEvidence(evidenceKey(ADRIEN))).toBe('at-edge')
    expect(state.activeConversationId).toBe(ADRIEN)
    expect(connectionStore.getState().windowVisible).toBe(true)
    // Open, focused, at the bottom, newest message read: no badge.
    expect(state.conversations.get(ADRIEN)?.unreadCount).toBe(0)
  })
})
