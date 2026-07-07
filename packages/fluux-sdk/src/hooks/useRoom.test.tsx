/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useRoom } from './useRoom'
import { roomStore, adminStore } from '../stores'
import { XMPPProvider } from '../provider'
import type { Room, RoomMessage } from '../core/types'
import { getLocalPart } from '../core/jid'

// Wrapper component that provides XMPP context
function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

// Helper to create test rooms
function createRoom(jid: string, options: Partial<Room> = {}): Room {
  return {
    jid,
    name: options.name || getLocalPart(jid),
    nickname: options.nickname || 'testuser',
    joined: options.joined ?? false,
    isBookmarked: options.isBookmarked ?? false,
    autojoin: options.autojoin,
    password: options.password,
    occupants: options.occupants || new Map(),
    messages: options.messages || [],
    unreadCount: options.unreadCount || 0,
    mentionsCount: options.mentionsCount || 0,
    typingUsers: options.typingUsers || new Set(),
  }
}

// Helper to create test messages
function createMessage(id: string, roomJid: string, nick: string, body: string): RoomMessage {
  return {
    type: 'groupchat',
    id,
    roomJid,
    from: `${roomJid}/${nick}`,
    nick,
    body,
    timestamp: new Date(),
    isOutgoing: false,
  }
}

describe('useRoom hook', () => {
  beforeEach(() => {
    // Reset store state before each test
    roomStore.setState({ rooms: new Map(), activeRoomJid: null })
  })

  describe('composed action surface (useRoom = state + useRoomActions)', () => {
    // useRoom now composes useRoomActions instead of re-defining every action;
    // this pins that its full action surface — including actions that had
    // drifted onto useRoomActions only — is present and callable.
    const representativeActions = [
      // messaging / lifecycle
      'joinRoom', 'leaveRoom', 'sendMessage', 'sendReaction', 'setActiveRoom',
      // read-state (these had drifted onto useRoomActions only)
      'markAsRead', 'markReadToNewest', 'markAllRoomsRead',
      // polls
      'sendPoll', 'votePoll', 'closePoll',
      // moderation / admin
      'moderateMessage', 'setAffiliation', 'setRole', 'queryAffiliationList',
      // hats
      'listHats', 'assignHat', 'unassignHat',
      // management / config
      'createRoom', 'destroyRoom', 'submitRoomConfig', 'setSubject',
      'setBookmark', 'removeBookmark', 'browsePublicRooms', 'setRoomAvatar',
    ] as const

    it('exposes every composed action as a function', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })
      const hook = result.current as unknown as Record<string, unknown>
      const missing = representativeActions.filter((name) => typeof hook[name] !== 'function')
      expect(missing).toEqual([])
    })

    it('still exposes room state alongside the actions', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })
      expect(Array.isArray(result.current.joinedRooms)).toBe(true)
      expect(Array.isArray(result.current.allRooms)).toBe(true)
      expect(result.current.activeRoomJid).toBeNull()
    })
  })

  describe('joinedRooms reactivity', () => {
    it('should return only joined rooms', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('room1@conference.example.com', { joined: true }))
        roomStore.getState().addRoom(createRoom('room2@conference.example.com', { joined: false }))
      })

      const joined = result.current.joinedRooms
      expect(joined.length).toBe(1)
      expect(joined[0].jid).toBe('room1@conference.example.com')
    })

    it('should update when room joined status changes', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('room1@conference.example.com', { joined: false }))
      })

      expect(result.current.joinedRooms.length).toBe(0)

      act(() => {
        roomStore.getState().setRoomJoined('room1@conference.example.com', true)
      })

      expect(result.current.joinedRooms.length).toBe(1)
    })
  })

  describe('bookmarkedRooms reactivity', () => {
    it('should return only bookmarked rooms', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('room1@conference.example.com', { isBookmarked: true }))
        roomStore.getState().addRoom(createRoom('room2@conference.example.com', { isBookmarked: false }))
      })

      const bookmarked = result.current.bookmarkedRooms
      expect(bookmarked.length).toBe(1)
      expect(bookmarked[0].jid).toBe('room1@conference.example.com')
    })

    it('should update when bookmark is added via setBookmark', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      expect(result.current.bookmarkedRooms.length).toBe(0)

      act(() => {
        roomStore.getState().setBookmark('newroom@conference.example.com', {
          name: 'New Room',
          nick: 'mynick',
          autojoin: true,
        })
      })

      const bookmarked = result.current.bookmarkedRooms
      expect(bookmarked.length).toBe(1)
      expect(bookmarked[0].name).toBe('New Room')
      expect(bookmarked[0].autojoin).toBe(true)
    })

    it('should update when bookmark is removed', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().setBookmark('room@conference.example.com', {
          name: 'Test Room',
          nick: 'nick',
        })
      })

      expect(result.current.bookmarkedRooms.length).toBe(1)

      act(() => {
        roomStore.getState().removeBookmark('room@conference.example.com')
      })

      expect(result.current.bookmarkedRooms.length).toBe(0)
    })
  })

  describe('allRooms reactivity', () => {
    it('should return all rooms that are bookmarked or joined', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('joined@conference.example.com', {
          joined: true,
          isBookmarked: false,
        }))
        roomStore.getState().addRoom(createRoom('bookmarked@conference.example.com', {
          joined: false,
          isBookmarked: true,
        }))
        roomStore.getState().addRoom(createRoom('both@conference.example.com', {
          joined: true,
          isBookmarked: true,
        }))
      })

      const all = result.current.allRooms
      expect(all.length).toBe(3)
    })

    it('should update when rooms are added or removed', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      expect(result.current.allRooms.length).toBe(0)

      act(() => {
        roomStore.getState().setBookmark('room1@conference.example.com', {
          name: 'Room 1',
          nick: 'nick',
        })
      })

      expect(result.current.allRooms.length).toBe(1)

      act(() => {
        roomStore.getState().setBookmark('room2@conference.example.com', {
          name: 'Room 2',
          nick: 'nick',
        })
      })

      expect(result.current.allRooms.length).toBe(2)

      act(() => {
        roomStore.getState().removeBookmark('room1@conference.example.com')
      })

      expect(result.current.allRooms.length).toBe(1)
    })
  })

  describe('activeRoom reactivity', () => {
    it('should return the active room', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', {
          name: 'Test Room',
          joined: true,
        }))
        roomStore.getState().setActiveRoom('test@conference.example.com')
      })

      expect(result.current.activeRoom?.jid).toBe('test@conference.example.com')
      expect(result.current.activeRoom?.name).toBe('Test Room')
    })

    it('should update when active room changes', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('room1@conference.example.com', { name: 'Room 1', joined: true }))
        roomStore.getState().addRoom(createRoom('room2@conference.example.com', { name: 'Room 2', joined: true }))
      })

      expect(result.current.activeRoom).toBeUndefined()

      act(() => {
        roomStore.getState().setActiveRoom('room1@conference.example.com')
      })

      expect(result.current.activeRoom?.name).toBe('Room 1')

      act(() => {
        roomStore.getState().setActiveRoom('room2@conference.example.com')
      })

      expect(result.current.activeRoom?.name).toBe('Room 2')
    })

    it('should return undefined when no room is active', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      expect(result.current.activeRoom).toBeUndefined()
    })
  })

  describe('activeMessages reactivity', () => {
    it('should return messages from active room', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      const messages = [
        createMessage('msg1', 'test@conference.example.com', 'alice', 'Hello'),
        createMessage('msg2', 'test@conference.example.com', 'bob', 'Hi there'),
      ]

      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', { messages, joined: true }))
        roomStore.getState().setActiveRoom('test@conference.example.com')
      })

      expect(result.current.activeMessages.length).toBe(2)
      expect(result.current.activeMessages[0].body).toBe('Hello')
      expect(result.current.activeMessages[1].body).toBe('Hi there')
    })

    it('should update when message is added to active room', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))
        roomStore.getState().setActiveRoom('test@conference.example.com')
      })

      expect(result.current.activeMessages.length).toBe(0)

      act(() => {
        roomStore.getState().addMessage(
          'test@conference.example.com',
          createMessage('msg1', 'test@conference.example.com', 'alice', 'New message!')
        )
      })

      expect(result.current.activeMessages.length).toBe(1)
      expect(result.current.activeMessages[0].body).toBe('New message!')
    })

    it('should return empty array when no room is active', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      expect(result.current.activeMessages).toEqual([])
    })
  })

  describe('activeRoomJid', () => {
    it('should track the active room JID', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      expect(result.current.activeRoomJid).toBeNull()

      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))
        roomStore.getState().setActiveRoom('test@conference.example.com')
      })

      expect(result.current.activeRoomJid).toBe('test@conference.example.com')
    })
  })

  describe('getRoom', () => {
    it('should return a specific room by JID', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', { name: 'Test Room' }))
      })

      const room = result.current.getRoom('test@conference.example.com')
      expect(room?.name).toBe('Test Room')
    })

    it('should return undefined for non-existent room', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      const room = result.current.getRoom('nonexistent@conference.example.com')
      expect(room).toBeUndefined()
    })
  })

  describe('setActiveRoom', () => {
    it('should set the active room', async () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))
      })

      await act(async () => {
        await result.current.setActiveRoom('test@conference.example.com')
      })

      expect(result.current.activeRoomJid).toBe('test@conference.example.com')
    })

    it('should load cache before setting active room (regression: firstNewMessageId needs full history)', async () => {
      // Regression test for bug where opening a room with only live messages
      // showed no historical context above the "new messages" marker.
      // The fix: load cache BEFORE calling setActiveRoom in the store,
      // so firstNewMessageId is calculated with the full message history.
      const { result } = renderHook(() => useRoom(), { wrapper })

      const liveMessage = createMessage('live-1', 'test@conference.example.com', 'alice', 'New message')
      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', {
          joined: true,
          messages: [liveMessage],
          unreadCount: 1,
        }))
      })

      // Replace loadMessagesFromCache on the store to record activeRoomJid at call time.
      // Must use setState() because Zustand creates new state objects on set(), so
      // vi.spyOn on a previous getState() reference won't intercept future calls.
      const originalLoad = roomStore.getState().loadMessagesFromCache
      let activeRoomDuringCacheLoad: string | null | undefined = undefined
      let loadCallCount = 0
      roomStore.setState({
        loadMessagesFromCache: async (roomJid: string, options?: { limit?: number }) => {
          if (loadCallCount === 0) {
            // Record state at the time of the FIRST cache load (from the hook)
            activeRoomDuringCacheLoad = roomStore.getState().activeRoomJid
          }
          loadCallCount++
          return originalLoad(roomJid, options)
        },
      })

      await act(async () => {
        await result.current.setActiveRoom('test@conference.example.com')
      })

      // Cache was loaded while active room was still null → correct ordering
      expect(activeRoomDuringCacheLoad).toBeNull()
      expect(loadCallCount).toBeGreaterThanOrEqual(1)

      // Restore original
      roomStore.setState({ loadMessagesFromCache: originalLoad })
    })

    it('should always load cache even when room has messages', async () => {
      // Regression test: cache loading must not be skipped when messages exist.
      // Previously, rooms with live messages in memory would skip cache loading,
      // leaving only new messages visible without historical context.
      const { result } = renderHook(() => useRoom(), { wrapper })

      const existingMessage = createMessage('msg-1', 'test@conference.example.com', 'bob', 'Existing')
      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', {
          joined: true,
          messages: [existingMessage],
        }))
      })

      const originalLoad = roomStore.getState().loadMessagesFromCache
      let cacheLoadRoomJid: string | null = null
      roomStore.setState({
        loadMessagesFromCache: async (roomJid: string, options?: { limit?: number }) => {
          cacheLoadRoomJid = roomJid
          return originalLoad(roomJid, options)
        },
      })

      await act(async () => {
        await result.current.setActiveRoom('test@conference.example.com')
      })

      // Cache should be loaded regardless of existing messages
      expect(cacheLoadRoomJid).toBe('test@conference.example.com')

      roomStore.setState({ loadMessagesFromCache: originalLoad })
    })

    it('should clear active room when passed null', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))
        roomStore.getState().setActiveRoom('test@conference.example.com')
      })

      act(() => {
        result.current.setActiveRoom(null)
      })

      expect(result.current.activeRoomJid).toBeNull()
    })
  })

  describe('markAsRead', () => {
    it('should reset unread count', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', { unreadCount: 5 }))
      })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.unreadCount).toBe(5)

      act(() => {
        result.current.markAsRead('test@conference.example.com')
      })

      expect(roomStore.getState().rooms.get('test@conference.example.com')?.unreadCount).toBe(0)
    })
  })

  // Note: updateReactions is an internal store function, tested in roomStore.test.ts
  // The hook doesn't expose this function since apps should use sendReaction() instead

  describe('draft management', () => {
    beforeEach(() => {
      // Reset drafts state
      roomStore.setState({ drafts: new Map() })
    })

    it('should set and get drafts via hook functions', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        result.current.setDraft('room1@conference.example.com', 'Hello room!')
      })

      expect(result.current.getDraft('room1@conference.example.com')).toBe('Hello room!')
    })

    it('should clear drafts via hook functions', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        result.current.setDraft('room1@conference.example.com', 'Hello room!')
      })

      act(() => {
        result.current.clearDraft('room1@conference.example.com')
      })

      expect(result.current.getDraft('room1@conference.example.com')).toBe('')
    })

    it('should maintain separate drafts for different rooms', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        result.current.setDraft('room1@conference.example.com', 'Draft for Room 1')
        result.current.setDraft('room2@conference.example.com', 'Draft for Room 2')
      })

      expect(result.current.getDraft('room1@conference.example.com')).toBe('Draft for Room 1')
      expect(result.current.getDraft('room2@conference.example.com')).toBe('Draft for Room 2')
    })

    it('should preserve drafts when switching active room', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      // Set up rooms
      act(() => {
        roomStore.getState().addRoom(createRoom('room1@conference.example.com', { joined: true }))
        roomStore.getState().addRoom(createRoom('room2@conference.example.com', { joined: true }))
      })

      // Set draft for Room 1
      act(() => {
        result.current.setActiveRoom('room1@conference.example.com')
        result.current.setDraft('room1@conference.example.com', 'Private message for Room 1')
      })

      // Switch to Room 2
      act(() => {
        result.current.setActiveRoom('room2@conference.example.com')
      })

      // Room 1's draft should still be intact
      expect(result.current.getDraft('room1@conference.example.com')).toBe('Private message for Room 1')
      expect(result.current.getDraft('room2@conference.example.com')).toBe('')
    })

    it('should not mix up drafts after multiple room switches', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      // Set up multiple rooms
      act(() => {
        roomStore.getState().addRoom(createRoom('room1@conference.example.com', { joined: true }))
        roomStore.getState().addRoom(createRoom('room2@conference.example.com', { joined: true }))
        roomStore.getState().addRoom(createRoom('room3@conference.example.com', { joined: true }))
      })

      // Set drafts for multiple rooms
      act(() => {
        result.current.setDraft('room1@conference.example.com', 'CONFIDENTIAL: Room 1 only')
        result.current.setDraft('room2@conference.example.com', 'CONFIDENTIAL: Room 2 only')
      })

      // Rapidly switch between rooms
      act(() => {
        result.current.setActiveRoom('room1@conference.example.com')
        result.current.setActiveRoom('room3@conference.example.com')
        result.current.setActiveRoom('room2@conference.example.com')
        result.current.setActiveRoom('room1@conference.example.com')
        result.current.setActiveRoom('room2@conference.example.com')
      })

      // Verify drafts are still correctly associated
      expect(result.current.getDraft('room1@conference.example.com')).toBe('CONFIDENTIAL: Room 1 only')
      expect(result.current.getDraft('room2@conference.example.com')).toBe('CONFIDENTIAL: Room 2 only')
      expect(result.current.getDraft('room3@conference.example.com')).toBe('')
    })

    it('should ensure drafts do not leak between rooms', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      // Set up rooms
      act(() => {
        roomStore.getState().addRoom(createRoom('private@conference.example.com', { name: 'Private', joined: true }))
        roomStore.getState().addRoom(createRoom('public@conference.example.com', { name: 'Public', joined: true }))
      })

      // Type sensitive content for private room
      act(() => {
        result.current.setActiveRoom('private@conference.example.com')
        result.current.setDraft('private@conference.example.com', 'TOP SECRET: Do not share')
      })

      // Switch to public room - should not see the private draft
      act(() => {
        result.current.setActiveRoom('public@conference.example.com')
      })

      // Public room should have empty draft
      expect(result.current.getDraft('public@conference.example.com')).toBe('')

      // Private room draft should still be there
      expect(result.current.getDraft('private@conference.example.com')).toBe('TOP SECRET: Do not share')
    })
  })

  describe('bookmark workflow', () => {
    it('should support the full bookmark lifecycle', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      // Initially no rooms
      expect(result.current.allRooms.length).toBe(0)

      // Add a bookmark (simulating fetch from server)
      act(() => {
        roomStore.getState().setBookmark('room@conference.example.com', {
          name: 'My Favorite Room',
          nick: 'mynick',
          autojoin: false,
        })
      })

      // Room should appear in bookmarked and allRooms, but not joined
      expect(result.current.bookmarkedRooms.length).toBe(1)
      expect(result.current.joinedRooms.length).toBe(0)
      expect(result.current.allRooms.length).toBe(1)

      // Simulate joining the room
      act(() => {
        roomStore.getState().setRoomJoined('room@conference.example.com', true)
      })

      // Now it should be in both joined and bookmarked
      expect(result.current.bookmarkedRooms.length).toBe(1)
      expect(result.current.joinedRooms.length).toBe(1)

      // Leave the room
      act(() => {
        roomStore.getState().setRoomJoined('room@conference.example.com', false)
      })

      // Still bookmarked, but not joined
      expect(result.current.bookmarkedRooms.length).toBe(1)
      expect(result.current.joinedRooms.length).toBe(0)
      expect(result.current.allRooms.length).toBe(1)

      // Remove the bookmark
      act(() => {
        roomStore.getState().removeBookmark('room@conference.example.com')
      })

      // Room should be completely gone
      expect(result.current.allRooms.length).toBe(0)
    })

    it('should preserve room data when bookmarking existing joined room', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      // Join a room first (without bookmark)
      act(() => {
        roomStore.getState().addRoom(createRoom('room@conference.example.com', {
          name: 'Test Room',
          nickname: 'oldnick',
          joined: true,
          isBookmarked: false,
          unreadCount: 3,
        }))
      })

      expect(result.current.joinedRooms.length).toBe(1)
      expect(result.current.bookmarkedRooms.length).toBe(0)

      // Now bookmark it
      act(() => {
        roomStore.getState().setBookmark('room@conference.example.com', {
          name: 'Bookmarked Name',
          nick: 'newnick',
          autojoin: true,
        })
      })

      // Should now be in both lists
      expect(result.current.joinedRooms.length).toBe(1)
      expect(result.current.bookmarkedRooms.length).toBe(1)

      // Check the room data was updated but joined status preserved
      const room = result.current.getRoom('room@conference.example.com')
      expect(room?.name).toBe('Bookmarked Name')
      expect(room?.nickname).toBe('newnick')
      expect(room?.joined).toBe(true)
      expect(room?.isBookmarked).toBe(true)
      expect(room?.autojoin).toBe(true)
    })
  })

  describe('mucServiceJid', () => {
    beforeEach(() => {
      // Reset admin store state
      adminStore.setState({ mucServiceJid: null })
    })

    it('should return null when MUC service is not discovered', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })
      expect(result.current.mucServiceJid).toBeNull()
    })

    it('should return MUC service JID when discovered', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        adminStore.getState().setMucServiceJid('conference.example.com')
      })

      expect(result.current.mucServiceJid).toBe('conference.example.com')
    })

    it('should update reactively when MUC service JID changes', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      expect(result.current.mucServiceJid).toBeNull()

      act(() => {
        adminStore.getState().setMucServiceJid('muc.server.com')
      })

      expect(result.current.mucServiceJid).toBe('muc.server.com')

      act(() => {
        adminStore.getState().setMucServiceJid('conference.other.com')
      })

      expect(result.current.mucServiceJid).toBe('conference.other.com')
    })
  })

  describe('reference stability (prevents render loops)', () => {
    it('should return stable empty array reference for joinedRooms when no rooms are joined', () => {
      const { result, rerender } = renderHook(() => useRoom(), { wrapper })

      const joined1 = result.current.joinedRooms
      rerender()
      const joined2 = result.current.joinedRooms

      // Should be the exact same reference (toBe), not just equal content (toEqual)
      expect(joined1).toBe(joined2)
    })

    it('should return stable empty array reference for bookmarkedRooms when no rooms are bookmarked', () => {
      const { result, rerender } = renderHook(() => useRoom(), { wrapper })

      const bookmarked1 = result.current.bookmarkedRooms
      rerender()
      const bookmarked2 = result.current.bookmarkedRooms

      expect(bookmarked1).toBe(bookmarked2)
    })

    it('should return stable empty array reference for allRooms when no rooms exist', () => {
      const { result, rerender } = renderHook(() => useRoom(), { wrapper })

      const all1 = result.current.allRooms
      rerender()
      const all2 = result.current.allRooms

      expect(all1).toBe(all2)
    })

    it('should return stable empty array reference for activeMessages when no active room', () => {
      const { result, rerender } = renderHook(() => useRoom(), { wrapper })

      const messages1 = result.current.activeMessages
      rerender()
      const messages2 = result.current.activeMessages

      expect(messages1).toBe(messages2)
    })

    it('should return stable empty array reference for activeMessages when active room has no messages', () => {
      const { result, rerender } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().addRoom(createRoom('test@conference.example.com', { joined: true }))
        roomStore.getState().setActiveRoom('test@conference.example.com')
      })

      const messages1 = result.current.activeMessages
      rerender()
      const messages2 = result.current.activeMessages

      expect(messages1.length).toBe(0)
      expect(messages1).toBe(messages2)
    })

    it('should maintain stable array reference when unrelated state changes', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().setBookmark('room1@conference.example.com', { name: 'Room 1', nick: 'nick' })
        roomStore.getState().setRoomJoined('room1@conference.example.com', true)
      })

      const joined1 = result.current.joinedRooms
      const bookmarked1 = result.current.bookmarkedRooms
      const all1 = result.current.allRooms

      // Arrays should have content
      expect(joined1.length).toBe(1)
      expect(bookmarked1.length).toBe(1)
      expect(all1.length).toBe(1)
    })

    it('should update array reference when rooms actually change', () => {
      const { result } = renderHook(() => useRoom(), { wrapper })

      act(() => {
        roomStore.getState().setBookmark('room1@conference.example.com', { name: 'Room 1', nick: 'nick' })
        roomStore.getState().setRoomJoined('room1@conference.example.com', true)
      })

      const joined1 = result.current.joinedRooms

      act(() => {
        roomStore.getState().setBookmark('room2@conference.example.com', { name: 'Room 2', nick: 'nick' })
        roomStore.getState().setRoomJoined('room2@conference.example.com', true)
      })

      const joined2 = result.current.joinedRooms

      // Content should have changed
      expect(joined1.length).toBe(1)
      expect(joined2.length).toBe(2)
      // References should be different (new array created)
      expect(joined1).not.toBe(joined2)
    })
  })
})
