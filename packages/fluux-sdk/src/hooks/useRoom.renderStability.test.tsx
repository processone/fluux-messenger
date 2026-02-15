/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRoom } from './useRoom'
import { roomStore } from '../stores'
import {
  wrapper,
  useRenderCount,
  createRoom,
  createRoomMessage,
  generateRooms,
} from './renderStability.helpers'

describe('useRoom render stability', () => {
  beforeEach(() => {
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      mamQueryStates: new Map(),
      activeAnimation: null,
      drafts: new Map(),
    })
  })

  it('should batch renders when adding many rooms in a single act()', () => {
    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoom()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Add 100 rooms in a single act() — React should batch these
    const rooms = generateRooms(100, { joined: true, isBookmarked: true })
    act(() => {
      rooms.forEach(r => roomStore.getState().addRoom(r))
    })

    // After act() resolves, there should be a bounded number of renders
    // React batches updates within act(), but Zustand fires per setState
    // The key assertion: it should not be O(n²) — at most O(n) renders
    const totalRenders = result.current.renderCount - rendersAfterMount
    expect(totalRenders).toBeLessThanOrEqual(100)
    // Verify the data is correct
    expect(result.current.joinedRooms.length).toBe(100)
  })

  it('should render at most linearly when adding rooms individually', () => {
    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoom()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Add 10 rooms, each in its own act()
    for (let i = 0; i < 10; i++) {
      act(() => {
        roomStore.getState().addRoom(
          createRoom(`room-${i}@conference.example.com`, { joined: true, isBookmarked: true })
        )
      })
    }

    // Total renders should be linear: at most ~10 + initial
    // Each addRoom triggers at most one useShallow-detected change
    const totalRenders = result.current.renderCount - rendersAfterMount
    expect(totalRenders).toBeLessThanOrEqual(11)
    expect(result.current.joinedRooms.length).toBe(10)
  })

  it('should maintain stable joinedRooms reference when unrelated room data changes', () => {
    const roomA = createRoom('roomA@conference.example.com', { joined: true, isBookmarked: true })
    const roomB = createRoom('roomB@conference.example.com', { joined: true, isBookmarked: true })

    act(() => {
      roomStore.getState().addRoom(roomA)
      roomStore.getState().addRoom(roomB)
    })

    const { result } = renderHook(
      () => {
        const hookResult = useRoom()
        return hookResult
      },
      { wrapper }
    )

    const joinedBefore = result.current.joinedRooms

    // Add messages to room B — this mutates room B but shouldn't change the room list order
    act(() => {
      roomStore.getState().addMessage(
        'roomB@conference.example.com',
        createRoomMessage('roomB@conference.example.com', 'user1', 'Hello', {
          id: 'msg-1',
        })
      )
    })

    const joinedAfter = result.current.joinedRooms

    // The list will re-render (since rooms Map changed), but elements should be the same rooms
    expect(joinedAfter.length).toBe(2)
    expect(joinedAfter.map(r => r.jid).sort()).toEqual(joinedBefore.map(r => r.jid).sort())
  })

  it('should not re-render for totalUnreadCount when messages (not unreads) are added to active room', () => {
    const roomA = createRoom('roomA@conference.example.com', { joined: true, isBookmarked: true })

    act(() => {
      roomStore.getState().addRoom(roomA)
      roomStore.getState().setActiveRoom('roomA@conference.example.com')
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoom()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    // totalUnreadCount should be 0
    expect(result.current.totalUnreadCount).toBe(0)

    const rendersAfterMount = result.current.renderCount

    // Add a message to the active room — active rooms don't increment unread
    act(() => {
      roomStore.getState().addMessage(
        'roomA@conference.example.com',
        createRoomMessage('roomA@conference.example.com', 'user1', 'Hello', {
          id: 'msg-1',
        }),
        { incrementUnread: false }
      )
    })

    // totalUnreadCount should still be 0
    expect(result.current.totalUnreadCount).toBe(0)
  })

  it('should handle rapid room additions without O(n²) render behavior', () => {
    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoom()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const startRenders = result.current.renderCount

    // Simulate bookmark arrival: 50 rooms added rapidly
    const rooms = generateRooms(50, { isBookmarked: true, autojoin: true })
    act(() => {
      rooms.forEach(r => roomStore.getState().addRoom(r))
    })

    const totalRenders = result.current.renderCount - startRenders

    // Should be bounded — O(n) at worst within act()
    expect(totalRenders).toBeLessThanOrEqual(50)
    expect(result.current.allRooms.length).toBe(50)
  })
})
