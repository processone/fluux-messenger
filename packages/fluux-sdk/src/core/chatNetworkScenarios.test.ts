/**
 * Chat Network Scenario Journey Tests
 *
 * Multi-step tests that validate 1:1 conversation state consistency across
 * network transitions (connect → disconnect → SM resume / fresh session).
 *
 * Mirrors networkScenarios.test.ts (which covers rooms) to ensure chat-specific
 * behavior is tested: MAM catch-up with `start` cursor, serverInfo discovery
 * gating, typing state cleanup, and conversation switching after reconnect.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
  writable: true,
})

// Mock messageCache to prevent IndexedDB operations
vi.mock('../utils/messageCache', () => ({
  saveRoomMessage: vi.fn().mockResolvedValue(undefined),
  saveRoomMessages: vi.fn().mockResolvedValue(undefined),
  getRoomMessages: vi.fn().mockResolvedValue([]),
  getRoomMessage: vi.fn().mockResolvedValue(null),
  getRoomMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessage: vi.fn().mockResolvedValue(undefined),
  deleteRoomMessages: vi.fn().mockResolvedValue(undefined),
  saveMessage: vi.fn().mockResolvedValue(undefined),
  saveMessages: vi.fn().mockResolvedValue(undefined),
  getMessages: vi.fn().mockResolvedValue([]),
  getMessage: vi.fn().mockResolvedValue(null),
  getMessageByStanzaId: vi.fn().mockResolvedValue(null),
  updateMessage: vi.fn().mockResolvedValue(undefined),
  deleteMessage: vi.fn().mockResolvedValue(undefined),
  deleteConversationMessages: vi.fn().mockResolvedValue(undefined),
  clearAllMessages: vi.fn().mockResolvedValue(undefined),
  isMessageCacheAvailable: vi.fn().mockReturnValue(false),
  getOldestMessageTimestamp: vi.fn().mockResolvedValue(null),
  getOldestRoomMessageTimestamp: vi.fn().mockResolvedValue(null),
  getMessageCount: vi.fn().mockResolvedValue(0),
  getRoomMessageCount: vi.fn().mockResolvedValue(0),
  flushPendingRoomMessages: vi.fn().mockResolvedValue(undefined),
}))

import { chatStore } from '../stores/chatStore'
import { connectionStore } from '../stores/connectionStore'
import { NS_MAM } from './namespaces'
import {
  createMockClient,
  simulateFreshSession,
  simulateSmResumption,
} from './sideEffects.testHelpers'
import { setupChatSideEffects } from './chatSideEffects'

/** Helper: add a 1:1 conversation to the chat store */
function seedConversation(id: string, opts?: { active?: boolean }) {
  chatStore.getState().addConversation({
    id,
    name: id,
    type: 'chat',
    lastMessage: undefined,
    unreadCount: 0,
  })
  if (opts?.active) {
    chatStore.getState().setActiveConversation(id)
  }
}

/** Helper: set serverInfo with MAM support */
function enableMAM() {
  connectionStore.getState().setServerInfo({
    identities: [],
    domain: 'example.com',
    features: [NS_MAM],
  })
}

/** Helper: wait for async side effects to settle */
function settle(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Helper: simulate a disconnect */
function simulateDisconnect(client: ReturnType<typeof createMockClient>, opts?: { clearMocks?: boolean }) {
  connectionStore.getState().setStatus('reconnecting')
  if (opts?.clearMocks) {
    vi.mocked(client.chat.queryMAM).mockClear()
  }
}

describe('Chat Network Scenario Journey Tests', () => {
  let client: ReturnType<typeof createMockClient>
  let cleanup: () => void

  beforeEach(() => {
    chatStore.getState().reset()
    connectionStore.getState().reset()
    client = createMockClient()
  })

  afterEach(() => {
    cleanup?.()
  })

  // =========================================================================
  // Scenario 1: Active conversation → Disconnect → SM Resume → No MAM
  // =========================================================================
  describe('Scenario 1: SM Resume skips MAM for active conversation', () => {
    it('should not trigger MAM on SM resumption', async () => {
      enableMAM()
      seedConversation('alice@example.com', { active: true })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(client)

      simulateSmResumption(client)

      await settle()
      expect(client.chat.queryMAM).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Scenario 2: Active conversation → Disconnect → Fresh session → MAM
  // =========================================================================
  describe('Scenario 2: Fresh session triggers MAM for active conversation', () => {
    it('should trigger MAM catch-up on fresh session', async () => {
      enableMAM()
      seedConversation('alice@example.com', { active: true })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(client)

      simulateFreshSession(client)

      await vi.waitFor(() => {
        expect(client.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({ with: 'alice@example.com' })
        )
      })
    })
  })

  // =========================================================================
  // Scenario 3: SM Resume → Switch conversation → No redundant MAM
  // =========================================================================
  describe('Scenario 3: SM Resume → Switch conversation', () => {
    it('should NOT trigger MAM when switching back to SM-resumed conversation', async () => {
      enableMAM()
      seedConversation('alice@example.com', { active: true })
      seedConversation('bob@example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(client)

      simulateSmResumption(client)
      await settle()

      // Switch to bob then back to alice
      chatStore.getState().setActiveConversation('bob@example.com')
      await settle()

      vi.mocked(client.chat.queryMAM).mockClear()

      chatStore.getState().setActiveConversation('alice@example.com')
      await settle()

      // Alice was the active conversation during SM resume → fetchInitiated marks it
      expect(client.chat.queryMAM).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Scenario 4: Fresh session → Switch conversation → MAM for new convo
  // =========================================================================
  describe('Scenario 4: Fresh session → Switch to unfetched conversation', () => {
    it('should trigger MAM when switching to a conversation not yet caught up', async () => {
      enableMAM()
      seedConversation('alice@example.com', { active: true })
      seedConversation('bob@example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(client)

      // Fresh session catches up alice (active)
      simulateFreshSession(client)

      await vi.waitFor(() => {
        expect(client.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({ with: 'alice@example.com' })
        )
      })
      vi.mocked(client.chat.queryMAM).mockClear()

      // Switch to bob — should trigger MAM (not yet caught up)
      chatStore.getState().setActiveConversation('bob@example.com')

      await vi.waitFor(() => {
        expect(client.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({ with: 'bob@example.com' })
        )
      })
    })
  })

  // =========================================================================
  // Scenario 5: Rapid disconnect/reconnect cycles
  // =========================================================================
  describe('Scenario 5: Rapid disconnect/reconnect cycles', () => {
    it('should maintain consistent state after rapid cycles', async () => {
      enableMAM()
      seedConversation('alice@example.com', { active: true })

      cleanup = setupChatSideEffects(client)

      // Mock queryMAM to clear loading state (in production, the MAM module does this)
      vi.mocked(client.chat.queryMAM).mockImplementation(async () => {
        const activeId = chatStore.getState().activeConversationId
        if (activeId) chatStore.getState().setMAMLoading(activeId, false)
      })

      // Cycle 1: fresh session
      simulateFreshSession(client)
      await vi.waitFor(() => {
        expect(client.chat.queryMAM).toHaveBeenCalled()
      })

      // Cycle 2: disconnect → SM resume
      simulateDisconnect(client, { clearMocks: true })
      simulateSmResumption(client)
      await settle()

      // No MAM on SM resume
      expect(client.chat.queryMAM).not.toHaveBeenCalled()

      // Cycle 3: disconnect → fresh session
      simulateDisconnect(client)
      simulateFreshSession(client)

      // MAM should trigger again (fetchInitiated cleared by disconnect + online)
      await vi.waitFor(() => {
        expect(client.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({ with: 'alice@example.com' })
        )
      })
    })
  })

  // =========================================================================
  // Scenario 6: ServerInfo MAM discovery after fresh session
  // =========================================================================
  describe('Scenario 6: Late MAM discovery on fresh session', () => {
    it('should trigger MAM when serverInfo arrives after fresh session', async () => {
      // No MAM support initially
      seedConversation('alice@example.com', { active: true })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(client)

      // Fresh session without MAM support
      simulateFreshSession(client)
      await settle()

      // No MAM yet — server features not discovered
      expect(client.chat.queryMAM).not.toHaveBeenCalled()

      // Server info arrives with MAM support
      enableMAM()

      await vi.waitFor(() => {
        expect(client.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({ with: 'alice@example.com' })
        )
      })
    })

    it('should NOT trigger MAM when serverInfo arrives after SM resumption', async () => {
      seedConversation('alice@example.com', { active: true })

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(client)

      // SM resumption (not fresh session)
      simulateSmResumption(client)
      await settle()

      // Server info arrives — should NOT trigger MAM (isFreshSession is false)
      enableMAM()
      await settle()

      expect(client.chat.queryMAM).not.toHaveBeenCalled()
    })
  })

  // =========================================================================
  // Scenario 7: Typing state cleanup on disconnect
  // =========================================================================
  describe('Scenario 7: Typing state cleanup on disconnect', () => {
    it('should clear all typing states when going offline', async () => {
      enableMAM()
      seedConversation('alice@example.com', { active: true })

      connectionStore.getState().setStatus('online')
      cleanup = setupChatSideEffects(client)

      // Simulate typing indicator
      chatStore.getState().setTyping('alice@example.com', 'alice@example.com/mobile', true)
      expect(chatStore.getState().typingStates.get('alice@example.com')?.size).toBe(1)

      // Go offline
      connectionStore.getState().setStatus('disconnected')

      // Typing states should be cleared
      expect(chatStore.getState().typingStates.size).toBe(0)
    })
  })

  // =========================================================================
  // Scenario 8: Multiple conversations — only active gets MAM on fresh session
  // =========================================================================
  describe('Scenario 8: Multiple conversations — selective MAM', () => {
    it('should only trigger MAM for the active conversation on fresh session', async () => {
      enableMAM()
      seedConversation('alice@example.com', { active: true })
      seedConversation('bob@example.com')
      seedConversation('charlie@example.com')

      connectionStore.getState().setStatus('disconnected')
      cleanup = setupChatSideEffects(client)

      simulateFreshSession(client)

      await vi.waitFor(() => {
        expect(client.chat.queryMAM).toHaveBeenCalledTimes(1)
        expect(client.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({ with: 'alice@example.com' })
        )
      })
    })
  })

  // =========================================================================
  // Scenario 9: Mixed room + chat side effects (integration)
  // =========================================================================
  describe('Scenario 9: Chat side effects with concurrent room side effects', () => {
    it('should handle chat MAM independently from room MAM', async () => {
      // This test imports both side effects to verify no interference
      const { setupRoomSideEffects } = await import('./roomSideEffects')
      const { roomStore: rs } = await import('../stores/roomStore')

      enableMAM()
      seedConversation('alice@example.com', { active: true })

      rs.getState().addRoom({
        jid: 'room@conference.example.com',
        name: 'Test Room',
        nickname: 'testuser',
        joined: true,
        supportsMAM: true,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set(),
        isBookmarked: true,
      })
      rs.getState().setActiveRoom('room@conference.example.com')

      connectionStore.getState().setStatus('disconnected')

      const chatCleanup = setupChatSideEffects(client)
      const roomCleanup = setupRoomSideEffects(client)
      cleanup = () => { chatCleanup(); roomCleanup() }

      simulateFreshSession(client)

      // Both should trigger independently
      await vi.waitFor(() => {
        expect(client.chat.queryMAM).toHaveBeenCalledWith(
          expect.objectContaining({ with: 'alice@example.com' })
        )
        expect(client.chat.queryRoomMAM).toHaveBeenCalledWith(
          expect.objectContaining({ roomJid: 'room@conference.example.com' })
        )
      })
    })
  })
})
