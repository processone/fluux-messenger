/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRoomOccupantCount } from './useMetadataSubscriptions'
import { roomStore } from '../stores'
import { wrapper, useRenderCount, createRoom } from './renderStability.helpers'

const ROOM = 'roomA@conference.example.com'

describe('useRoomOccupantCount render stability', () => {
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

  it('does NOT re-render when an occupant\'s metadata changes but the count is unchanged', () => {
    act(() => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      roomStore.getState().setActiveRoom(ROOM)
      roomStore.getState().addOccupant(ROOM, { nick: 'alice', affiliation: 'member', role: 'participant' })
    })

    const { result } = renderHook(
      () => ({ renderCount: useRenderCount(), count: useRoomOccupantCount(ROOM) }),
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount
    expect(result.current.count).toBe(1)

    // 20 metadata-only updates to the SAME occupant (presence/show flapping) — count stays 1.
    act(() => {
      for (let i = 0; i < 20; i++) {
        roomStore.getState().addOccupant(ROOM, {
          nick: 'alice',
          affiliation: 'member',
          role: 'participant',
          show: i % 2 ? 'away' : undefined,
        })
      }
    })

    expect(result.current.count).toBe(1)
    expect(result.current.renderCount).toBe(rendersAfterMount) // count subscription bailed on every update
  })

  it('re-renders when the occupant count changes (join / leave)', () => {
    act(() => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      roomStore.getState().setActiveRoom(ROOM)
      roomStore.getState().addOccupant(ROOM, { nick: 'alice', affiliation: 'member', role: 'participant' })
    })

    const { result } = renderHook(
      () => ({ renderCount: useRenderCount(), count: useRoomOccupantCount(ROOM) }),
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    act(() => {
      roomStore.getState().addOccupant(ROOM, { nick: 'bob', affiliation: 'member', role: 'participant' })
    })
    expect(result.current.count).toBe(2)
    expect(result.current.renderCount).toBeGreaterThan(rendersAfterMount)

    const rendersAfterJoin = result.current.renderCount
    act(() => {
      roomStore.getState().removeOccupant(ROOM, 'bob')
    })
    expect(result.current.count).toBe(1)
    expect(result.current.renderCount).toBeGreaterThan(rendersAfterJoin)
  })

  it('does NOT re-render when a BACKGROUND room receives presence churn', () => {
    const BG = 'roomB@conference.example.com'
    act(() => {
      roomStore.getState().addRoom(createRoom(ROOM, { joined: true }))
      roomStore.getState().addRoom(createRoom(BG, { joined: true }))
      roomStore.getState().setActiveRoom(ROOM)
      roomStore.getState().addOccupant(ROOM, { nick: 'alice', affiliation: 'member', role: 'participant' })
    })

    // Subscribe to the ACTIVE room's count.
    const { result } = renderHook(
      () => ({ renderCount: useRenderCount(), count: useRoomOccupantCount(ROOM) }),
      { wrapper }
    )
    const rendersAfterMount = result.current.renderCount

    // Storm the BACKGROUND room with individual joins/leaves + metadata flapping.
    act(() => {
      for (let i = 0; i < 30; i++) {
        roomStore.getState().addOccupant(BG, { nick: `U${i}`, jid: `u${i}@x`, affiliation: 'member', role: 'participant' })
      }
      for (let i = 0; i < 30; i++) {
        roomStore.getState().addOccupant(BG, { nick: `U${i}`, jid: `u${i}@x`, affiliation: 'member', role: 'participant', show: 'away' })
      }
      for (let i = 0; i < 10; i++) {
        roomStore.getState().removeOccupant(BG, `U${i}`)
      }
    })

    // The displayed (active) room's count subscription is fully isolated.
    expect(result.current.count).toBe(1)
    expect(result.current.renderCount).toBe(rendersAfterMount)
  })
})
