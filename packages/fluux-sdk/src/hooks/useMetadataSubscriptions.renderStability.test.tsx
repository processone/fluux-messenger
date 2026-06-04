/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRoomOccupants } from './useMetadataSubscriptions'
import { roomStore } from '../stores'
import {
  wrapper,
  useRenderCount,
  createRoom,
  createRoomMessage,
} from './renderStability.helpers'

const JID = 'roomA@conference.example.com'

describe('useRoomOccupants render stability', () => {
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

  it('does NOT re-render when the active room receives messages', () => {
    act(() => {
      roomStore.getState().addRoom(createRoom(JID, { joined: true }))
      roomStore.getState().setActiveRoom(JID)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const occupants = useRoomOccupants(JID)
        return { renderCount, occupants }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount
    const mapAfterMount = result.current.occupants

    act(() => {
      for (let i = 0; i < 10; i++) {
        roomStore.getState().addMessage(JID, createRoomMessage(JID, 'user1', `m${i}`, { id: `m-${i}` }))
      }
    })

    expect(result.current.renderCount).toBe(rendersAfterMount)
    expect(result.current.occupants).toBe(mapAfterMount) // same reference
  })

  it('DOES re-render when an occupant joins or leaves the active room', () => {
    act(() => {
      roomStore.getState().addRoom(createRoom(JID, { joined: true }))
      roomStore.getState().setActiveRoom(JID)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const occupants = useRoomOccupants(JID)
        return { renderCount, occupants }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    act(() => {
      roomStore.getState().addOccupant(JID, { nick: 'alice', affiliation: 'member', role: 'participant' })
    })
    expect(result.current.renderCount).toBeGreaterThan(rendersAfterMount)
    expect(result.current.occupants.has('alice')).toBe(true)

    const rendersAfterJoin = result.current.renderCount
    act(() => {
      roomStore.getState().removeOccupant(JID, 'alice')
    })
    expect(result.current.renderCount).toBeGreaterThan(rendersAfterJoin)
    expect(result.current.occupants.has('alice')).toBe(false)
  })
})
