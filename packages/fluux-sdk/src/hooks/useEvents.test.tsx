/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useEvents } from './useEvents'
import { eventsStore, connectionStore, chatStore } from '../stores'
import { XMPPProvider } from '../provider'
import { createMockXMPPClientForHooks } from '../core/test-utils'

// Mock localStorage for chatStore.reset()
const localStorageMock = {
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}
Object.defineProperty(global, 'localStorage', { value: localStorageMock })

// Create shared mock client
const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return {
    ...actual,
    useXMPPContext: () => ({ client: mockClient }),
  }
})

// Wrapper component that provides XMPP context
function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

describe('useEvents hook', () => {
  beforeEach(() => {
    // Reset store state before each test
    eventsStore.getState().reset()
    chatStore.getState().reset()
    connectionStore.getState().reset()
    vi.clearAllMocks()
  })

  describe('subscription requests', () => {
    it('should reflect subscriptionRequests from store', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      expect(result.current.subscriptionRequests).toHaveLength(0)

      act(() => {
        eventsStore.getState().addSubscriptionRequest('alice@example.com')
      })

      expect(result.current.subscriptionRequests).toHaveLength(1)
      expect(result.current.subscriptionRequests[0].from).toBe('alice@example.com')
    })

    it('should call client.acceptSubscription when acceptSubscription is called', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.roster.acceptSubscription.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.acceptSubscription('alice@example.com')
      })

      expect(mockClient.roster.acceptSubscription).toHaveBeenCalledWith('alice@example.com')
    })

    it('should call client.rejectSubscription when rejectSubscription is called', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.roster.rejectSubscription.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.rejectSubscription('alice@example.com')
      })

      expect(mockClient.roster.rejectSubscription).toHaveBeenCalledWith('alice@example.com')
    })
  })

  describe('stranger messages', () => {
    it('should reflect strangerMessages from store', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      expect(result.current.strangerMessages).toHaveLength(0)

      act(() => {
        eventsStore.getState().addStrangerMessage('stranger@example.com', 'Hello!')
      })

      expect(result.current.strangerMessages).toHaveLength(1)
      expect(result.current.strangerMessages[0].body).toBe('Hello!')
    })

    it('should group stranger messages by sender in strangerConversations', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addStrangerMessage('alice@example.com', 'Hi!')
        eventsStore.getState().addStrangerMessage('alice@example.com', 'How are you?')
        eventsStore.getState().addStrangerMessage('bob@example.com', 'Hello')
      })

      expect(Object.keys(result.current.strangerConversations)).toHaveLength(2)
      expect(result.current.strangerConversations['alice@example.com']).toHaveLength(2)
      expect(result.current.strangerConversations['bob@example.com']).toHaveLength(1)
    })

    it('should add contact and create conversation when acceptStranger is called', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.roster.addContact.mockResolvedValue(undefined)

      act(() => {
        eventsStore.getState().addStrangerMessage('stranger@example.com', 'Hello!')
        eventsStore.getState().addStrangerMessage('stranger@example.com', 'Anyone there?')
      })

      await act(async () => {
        await result.current.acceptStranger('stranger@example.com')
      })

      // Should add contact with local part as nickname
      expect(mockClient.roster.addContact).toHaveBeenCalledWith('stranger@example.com', 'stranger')

      // Should create conversation
      const conversations = Array.from(chatStore.getState().conversations.values())
      expect(conversations).toHaveLength(1)
      expect(conversations[0].id).toBe('stranger@example.com')

      // Should move messages to the conversation
      const messages = chatStore.getState().messages.get('stranger@example.com')
      expect(messages).toHaveLength(2)

      // Should remove from stranger messages
      expect(result.current.strangerMessages).toHaveLength(0)
    })

    it('should remove stranger messages when ignoreStranger is called', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addStrangerMessage('spam@example.com', 'Buy now!')
        eventsStore.getState().addStrangerMessage('other@example.com', 'Hello')
      })

      expect(result.current.strangerMessages).toHaveLength(2)

      act(() => {
        result.current.ignoreStranger('spam@example.com')
      })

      expect(result.current.strangerMessages).toHaveLength(1)
      expect(result.current.strangerMessages[0].from).toBe('other@example.com')
    })
  })

  describe('MUC invitations', () => {
    it('should reflect mucInvitations from store', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      expect(result.current.mucInvitations).toHaveLength(0)

      act(() => {
        eventsStore.getState().addMucInvitation(
          'room@conference.example.com',
          'alice@example.com',
          'Join us!'
        )
      })

      expect(result.current.mucInvitations).toHaveLength(1)
      expect(result.current.mucInvitations[0].roomJid).toBe('room@conference.example.com')
      expect(result.current.mucInvitations[0].from).toBe('alice@example.com')
      expect(result.current.mucInvitations[0].reason).toBe('Join us!')
    })

    it('should join room when acceptInvitation is called', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.muc.joinRoom.mockResolvedValue(undefined)

      // Set up current JID for default nickname
      act(() => {
        connectionStore.getState().setJid('myuser@example.com/resource')
        eventsStore.getState().addMucInvitation(
          'room@conference.example.com',
          'alice@example.com'
        )
      })

      await act(async () => {
        await result.current.acceptInvitation('room@conference.example.com')
      })

      expect(mockClient.muc.joinRoom).toHaveBeenCalledWith(
        'room@conference.example.com',
        'myuser',  // local part of JID
        { password: undefined, isQuickChat: false }
      )

      // Should remove from invitations
      expect(result.current.mucInvitations).toHaveLength(0)
    })

    it('should prefer the profile username (XEP-0172 nick) over the JID local part', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.muc.joinRoom.mockResolvedValue(undefined)

      act(() => {
        connectionStore.getState().setJid('myuser@example.com/resource')
        connectionStore.getState().setOwnNickname('Alice')
        eventsStore.getState().addMucInvitation(
          'room@conference.example.com',
          'alice@example.com'
        )
      })

      await act(async () => {
        await result.current.acceptInvitation('room@conference.example.com')
      })

      expect(mockClient.muc.joinRoom).toHaveBeenCalledWith(
        'room@conference.example.com',
        'Alice',  // profile username, not the JID local part
        { password: undefined, isQuickChat: false }
      )
    })

    it('should join room with password from invitation', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.muc.joinRoom.mockResolvedValue(undefined)

      act(() => {
        connectionStore.getState().setJid('myuser@example.com/resource')
        eventsStore.getState().addMucInvitation(
          'room@conference.example.com',
          'alice@example.com',
          'Private room',
          'secret123'
        )
      })

      await act(async () => {
        await result.current.acceptInvitation('room@conference.example.com')
      })

      expect(mockClient.muc.joinRoom).toHaveBeenCalledWith(
        'room@conference.example.com',
        'myuser',
        { password: 'secret123', isQuickChat: false }
      )
    })

    it('should join room with isQuickChat flag from invitation', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.muc.joinRoom.mockResolvedValue(undefined)

      act(() => {
        connectionStore.getState().setJid('myuser@example.com/resource')
        eventsStore.getState().addMucInvitation(
          'quickchat-user-happy-fox@conference.example.com',
          'alice@example.com',
          'Join quick chat',
          undefined,
          false,
          true // isQuickChat
        )
      })

      await act(async () => {
        await result.current.acceptInvitation('quickchat-user-happy-fox@conference.example.com')
      })

      expect(mockClient.muc.joinRoom).toHaveBeenCalledWith(
        'quickchat-user-happy-fox@conference.example.com',
        'myuser',
        { password: undefined, isQuickChat: true }
      )
    })

    it('should remove invitation when declineInvitation is called', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addMucInvitation(
          'room1@conference.example.com',
          'alice@example.com'
        )
        eventsStore.getState().addMucInvitation(
          'room2@conference.example.com',
          'bob@example.com'
        )
      })

      expect(result.current.mucInvitations).toHaveLength(2)

      act(() => {
        result.current.declineInvitation('room1@conference.example.com')
      })

      expect(result.current.mucInvitations).toHaveLength(1)
      expect(result.current.mucInvitations[0].roomJid).toBe('room2@conference.example.com')
    })
  })

  describe('system notifications', () => {
    it('should reflect systemNotifications from store', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      expect(result.current.systemNotifications).toHaveLength(0)

      act(() => {
        eventsStore.getState().addSystemNotification(
          'connection-error',
          'Server Update',
          'The server will restart at midnight'
        )
      })

      expect(result.current.systemNotifications).toHaveLength(1)
      expect(result.current.systemNotifications[0].title).toBe('Server Update')
      expect(result.current.systemNotifications[0].type).toBe('connection-error')
    })

    it('should remove notification when dismissNotification is called', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addSystemNotification('connection-error', 'Info 1', 'Message 1')
        eventsStore.getState().addSystemNotification('auth-error', 'Warning 1', 'Message 2')
      })

      expect(result.current.systemNotifications).toHaveLength(2)

      const notificationId = result.current.systemNotifications[0].id

      act(() => {
        result.current.dismissNotification(notificationId)
      })

      expect(result.current.systemNotifications).toHaveLength(1)
    })
  })

  describe('pendingCount', () => {
    it('should count all pending events', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      expect(result.current.pendingCount).toBe(0)

      act(() => {
        // 2 subscription requests
        eventsStore.getState().addSubscriptionRequest('alice@example.com')
        eventsStore.getState().addSubscriptionRequest('bob@example.com')

        // 1 stranger conversation (even with multiple messages)
        eventsStore.getState().addStrangerMessage('stranger@example.com', 'Hi')
        eventsStore.getState().addStrangerMessage('stranger@example.com', 'Hello?')

        // 1 MUC invitation
        eventsStore.getState().addMucInvitation(
          'room@conference.example.com',
          'inviter@example.com'
        )

        // 1 system notification
        eventsStore.getState().addSystemNotification('connection-error', 'Test', 'Test message')
      })

      // 2 + 1 (stranger conversations grouped by sender) + 1 + 1 = 5
      expect(result.current.pendingCount).toBe(5)
    })

    it('should update when events are handled', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.roster.acceptSubscription.mockResolvedValue(undefined)

      act(() => {
        eventsStore.getState().addSubscriptionRequest('alice@example.com')
        eventsStore.getState().addSubscriptionRequest('bob@example.com')
      })

      expect(result.current.pendingCount).toBe(2)

      await act(async () => {
        await result.current.acceptSubscription('alice@example.com')
        eventsStore.getState().removeSubscriptionRequest('alice@example.com')
      })

      expect(result.current.pendingCount).toBe(1)
    })
  })

  describe('edge cases', () => {
    it('should handle empty JID gracefully in acceptStranger', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.roster.addContact.mockResolvedValue(undefined)

      act(() => {
        eventsStore.getState().addStrangerMessage('stranger@example.com', 'Hello')
      })

      // Note: The hook uses getLocalPart which handles bare JIDs
      await act(async () => {
        await result.current.acceptStranger('stranger@example.com')
      })

      expect(mockClient.roster.addContact).toHaveBeenCalledWith('stranger@example.com', 'stranger')
    })

    it('should use "user" as default nickname when JID is null in acceptInvitation', async () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      mockClient.muc.joinRoom.mockResolvedValue(undefined)

      act(() => {
        // Don't set JID
        eventsStore.getState().addMucInvitation(
          'room@conference.example.com',
          'inviter@example.com'
        )
      })

      await act(async () => {
        await result.current.acceptInvitation('room@conference.example.com')
      })

      expect(mockClient.muc.joinRoom).toHaveBeenCalledWith(
        'room@conference.example.com',
        'user',  // default when JID is null
        { password: undefined, isQuickChat: false }
      )
    })

    it('should not duplicate subscription requests', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addSubscriptionRequest('alice@example.com')
        eventsStore.getState().addSubscriptionRequest('alice@example.com')
        eventsStore.getState().addSubscriptionRequest('alice@example.com')
      })

      expect(result.current.subscriptionRequests).toHaveLength(1)
    })

    it('should not duplicate MUC invitations for same room', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addMucInvitation(
          'room@conference.example.com',
          'alice@example.com'
        )
        eventsStore.getState().addMucInvitation(
          'room@conference.example.com',
          'bob@example.com'
        )
      })

      expect(result.current.mucInvitations).toHaveLength(1)
      // First invitation is kept
      expect(result.current.mucInvitations[0].from).toBe('alice@example.com')
    })
  })

  describe('reference stability (prevents render loops)', () => {
    it('should return stable empty array reference for subscriptionRequests when no requests exist', () => {
      const { result, rerender } = renderHook(() => useEvents(), { wrapper })

      const requests1 = result.current.subscriptionRequests
      rerender()
      const requests2 = result.current.subscriptionRequests

      // Should be the exact same reference (toBe), not just equal content (toEqual)
      expect(requests1).toBe(requests2)
    })

    it('should return stable empty array reference for strangerMessages when no messages exist', () => {
      const { result, rerender } = renderHook(() => useEvents(), { wrapper })

      const messages1 = result.current.strangerMessages
      rerender()
      const messages2 = result.current.strangerMessages

      expect(messages1).toBe(messages2)
    })

    it('should return stable empty array reference for mucInvitations when no invitations exist', () => {
      const { result, rerender } = renderHook(() => useEvents(), { wrapper })

      const invitations1 = result.current.mucInvitations
      rerender()
      const invitations2 = result.current.mucInvitations

      expect(invitations1).toBe(invitations2)
    })

    it('should return stable empty array reference for systemNotifications when no notifications exist', () => {
      const { result, rerender } = renderHook(() => useEvents(), { wrapper })

      const notifications1 = result.current.systemNotifications
      rerender()
      const notifications2 = result.current.systemNotifications

      expect(notifications1).toBe(notifications2)
    })

    it('should update array reference when subscriptionRequests actually change', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addSubscriptionRequest('alice@example.com')
      })

      const requests1 = result.current.subscriptionRequests

      act(() => {
        eventsStore.getState().addSubscriptionRequest('bob@example.com')
      })

      const requests2 = result.current.subscriptionRequests

      // Content should have changed
      expect(requests1.length).toBe(1)
      expect(requests2.length).toBe(2)
      // References should be different (new array created)
      expect(requests1).not.toBe(requests2)
    })

    it('should update array reference when strangerMessages actually change', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addStrangerMessage('alice@example.com', 'Hi')
      })

      const messages1 = result.current.strangerMessages

      act(() => {
        eventsStore.getState().addStrangerMessage('bob@example.com', 'Hello')
      })

      const messages2 = result.current.strangerMessages

      // Content should have changed
      expect(messages1.length).toBe(1)
      expect(messages2.length).toBe(2)
      // References should be different (new array created)
      expect(messages1).not.toBe(messages2)
    })

    it('should update array reference when mucInvitations actually change', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addMucInvitation(
          'room1@conference.example.com',
          'alice@example.com'
        )
      })

      const invitations1 = result.current.mucInvitations

      act(() => {
        eventsStore.getState().addMucInvitation(
          'room2@conference.example.com',
          'bob@example.com'
        )
      })

      const invitations2 = result.current.mucInvitations

      // Content should have changed
      expect(invitations1.length).toBe(1)
      expect(invitations2.length).toBe(2)
      // References should be different (new array created)
      expect(invitations1).not.toBe(invitations2)
    })

    it('should update array reference when systemNotifications actually change', () => {
      const { result } = renderHook(() => useEvents(), { wrapper })

      act(() => {
        eventsStore.getState().addSystemNotification('connection-error', 'Test 1', 'Message 1')
      })

      const notifications1 = result.current.systemNotifications

      act(() => {
        eventsStore.getState().addSystemNotification('auth-error', 'Test 2', 'Message 2')
      })

      const notifications2 = result.current.systemNotifications

      // Content should have changed
      expect(notifications1.length).toBe(1)
      expect(notifications2.length).toBe(2)
      // References should be different (new array created)
      expect(notifications1).not.toBe(notifications2)
    })
  })
})
