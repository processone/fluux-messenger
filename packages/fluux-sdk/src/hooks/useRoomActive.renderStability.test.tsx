/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRoomActive } from './useRoomActive'
import { roomStore } from '../stores'
import {
  wrapper,
  useRenderCount,
  createRoom,
  createRoomMessage,
} from './renderStability.helpers'

describe('useRoomActive render stability', () => {
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

  it('should not re-render when a background room receives messages', () => {
    const roomA = createRoom('roomA@conference.example.com', { joined: true, isBookmarked: true })
    const roomB = createRoom('roomB@conference.example.com', { joined: true, isBookmarked: true })

    act(() => {
      roomStore.getState().addRoom(roomA)
      roomStore.getState().addRoom(roomB)
      roomStore.getState().setActiveRoom('roomA@conference.example.com')
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoomActive()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Add 10 messages to background room B
    act(() => {
      for (let i = 0; i < 10; i++) {
        roomStore.getState().addMessage(
          'roomB@conference.example.com',
          createRoomMessage('roomB@conference.example.com', 'user1', `Message ${i}`, {
            id: `msg-b-${i}`,
          })
        )
      }
    })

    // useRoomActive should NOT re-render for background room messages
    expect(result.current.renderCount).toBe(rendersAfterMount)
  })

  it('should not re-render when background room occupants change', () => {
    const roomA = createRoom('roomA@conference.example.com', { joined: true, isBookmarked: true })
    const roomB = createRoom('roomB@conference.example.com', { joined: true, isBookmarked: true })

    act(() => {
      roomStore.getState().addRoom(roomA)
      roomStore.getState().addRoom(roomB)
      roomStore.getState().setActiveRoom('roomA@conference.example.com')
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoomActive()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Add occupants to background room B
    act(() => {
      const occupants = Array.from({ length: 50 }, (_, i) => ({
        nick: `user${i}`,
        affiliation: 'member' as const,
        role: 'participant' as const,
      }))
      roomStore.getState().batchAddOccupants('roomB@conference.example.com', occupants)
    })

    // useRoomActive should NOT re-render for background occupant changes
    expect(result.current.renderCount).toBe(rendersAfterMount)
  })

  it('should not re-render when background room typing state changes', () => {
    const roomA = createRoom('roomA@conference.example.com', { joined: true, isBookmarked: true })
    const roomB = createRoom('roomB@conference.example.com', { joined: true, isBookmarked: true })

    act(() => {
      roomStore.getState().addRoom(roomA)
      roomStore.getState().addRoom(roomB)
      roomStore.getState().setActiveRoom('roomA@conference.example.com')
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoomActive()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Set typing in background room B
    act(() => {
      roomStore.getState().setTyping('roomB@conference.example.com', 'someuser', true)
    })

    // useRoomActive should NOT re-render for background typing
    expect(result.current.renderCount).toBe(rendersAfterMount)
  })

  it('should re-render when active room receives a message', () => {
    const roomA = createRoom('roomA@conference.example.com', { joined: true, isBookmarked: true })

    act(() => {
      roomStore.getState().addRoom(roomA)
      roomStore.getState().setActiveRoom('roomA@conference.example.com')
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoomActive()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Add a message to the active room
    act(() => {
      roomStore.getState().addMessage(
        'roomA@conference.example.com',
        createRoomMessage('roomA@conference.example.com', 'user1', 'Hello!', {
          id: 'msg-active-1',
        })
      )
    })

    // Should re-render at least once for the active room message
    expect(result.current.renderCount).toBeGreaterThan(rendersAfterMount)
  })

  it('should remain stable with many background rooms', () => {
    // Create 20 rooms, all joined
    const rooms = Array.from({ length: 20 }, (_, i) =>
      createRoom(`room-${String(i).padStart(2, '0')}@conference.example.com`, {
        joined: true,
        isBookmarked: true,
      })
    )

    act(() => {
      rooms.forEach(r => roomStore.getState().addRoom(r))
      roomStore.getState().setActiveRoom(rooms[0].jid)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoomActive()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Add messages to 15 background rooms
    act(() => {
      for (let i = 1; i <= 15; i++) {
        roomStore.getState().addMessage(
          rooms[i].jid,
          createRoomMessage(rooms[i].jid, 'user1', `Background msg ${i}`, {
            id: `bg-msg-${i}`,
          })
        )
      }
    })

    // useRoomActive should NOT re-render for background room messages
    expect(result.current.renderCount).toBe(rendersAfterMount)
  })
})
