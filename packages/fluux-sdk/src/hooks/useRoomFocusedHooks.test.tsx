/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { renderHook, act } from '@testing-library/react'
import { XMPPProvider } from '../provider'
import { roomStore } from '../stores'
import { usePolls } from './usePolls'
import { useRoomModeration } from './useRoomModeration'
import { useRoomManagement } from './useRoomManagement'
import { useRoomActions } from './useRoomActions'
import { useRoomActive } from './useRoomActive'
import { createRoom } from './renderStability.helpers'

function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

/**
 * The focused room hooks are the single source of their action slice;
 * useRoomActions composes them. These guards pin (a) each focused hook's
 * surface and (b) that the composed aggregate still exposes every slice
 * action, so a component can migrate from useRoomActions to a focused hook
 * (or back) without a behavior change.
 */
describe('focused room hooks', () => {
  const pollActions = ['sendPoll', 'votePoll', 'closePoll'] as const
  const moderationActions = [
    'moderateMessage', 'setAffiliation', 'setRole', 'queryAffiliationList',
    'listHats', 'createHat', 'destroyHat', 'listHatAssignments', 'assignHat', 'unassignHat',
  ] as const
  const managementActions = [
    'createRoom', 'destroyRoom', 'roomExists', 'submitRoomConfig', 'setSubject',
    'inviteToRoom', 'inviteMultipleToRoom', 'browsePublicRooms', 'setBookmark',
    'removeBookmark', 'setRoomNotifyAll', 'setRoomAvatar', 'clearRoomAvatar',
    'restoreRoomAvatarFromCache',
  ] as const

  const asFns = (obj: unknown) => obj as Record<string, unknown>

  it('usePolls exposes exactly the poll actions', () => {
    const { result } = renderHook(() => usePolls(), { wrapper })
    for (const name of pollActions) expect(typeof asFns(result.current)[name]).toBe('function')
  })

  it('useRoomModeration exposes the moderation + hat actions', () => {
    const { result } = renderHook(() => useRoomModeration(), { wrapper })
    for (const name of moderationActions) expect(typeof asFns(result.current)[name]).toBe('function')
  })

  it('useRoomManagement exposes the room CRUD / config / bookmark actions', () => {
    const { result } = renderHook(() => useRoomManagement(), { wrapper })
    for (const name of managementActions) expect(typeof asFns(result.current)[name]).toBe('function')
  })

  it('useRoomActions still exposes every composed slice action', () => {
    const { result } = renderHook(() => useRoomActions(), { wrapper })
    const hook = asFns(result.current)
    const missing = [...pollActions, ...moderationActions, ...managementActions].filter(
      (name) => typeof hook[name] !== 'function'
    )
    expect(missing).toEqual([])
  })

  it('useRoomActive still exposes the slice actions it sources from the focused hooks', () => {
    // useRoomActive now sources these definitions from the focused hooks; its
    // public surface must be unchanged (only the actions it already exposed).
    const { result } = renderHook(() => useRoomActive(), { wrapper })
    const hook = asFns(result.current)
    const composedSlice = [
      'sendPoll', 'votePoll', 'closePoll',
      'moderateMessage', 'setAffiliation', 'setRole',
      'setRoomNotifyAll', 'submitRoomConfig', 'setSubject', 'destroyRoom',
      'setRoomAvatar', 'clearRoomAvatar', 'restoreRoomAvatarFromCache',
    ]
    const missing = composedSlice.filter((name) => typeof hook[name] !== 'function')
    expect(missing).toEqual([])
  })
})

/**
 * Composing useRoomActions from the focused hooks must not reintroduce render
 * churn: the focused hooks (and the composed aggregate) subscribe to NO store,
 * so their returned object identity must stay stable across heavy room-store
 * churn — a component reading them must not re-render on room updates.
 */
describe('focused room hooks render stability', () => {
  beforeEach(() => {
    roomStore.setState({
      rooms: new Map(),
      roomEntities: new Map(),
      roomMeta: new Map(),
      roomRuntime: new Map(),
      activeRoomJid: null,
      mamQueryStates: new Map(),
      drafts: new Map(),
    })
  })

  function churnRoomStore() {
    act(() => {
      for (let i = 0; i < 25; i++) {
        roomStore.getState().addRoom(createRoom(`r${i}@conference.example.com`, { joined: true }))
      }
      roomStore.getState().setActiveRoom('r0@conference.example.com')
    })
  }

  it.each([
    ['usePolls', usePolls],
    ['useRoomModeration', useRoomModeration],
    ['useRoomManagement', useRoomManagement],
    ['useRoomActions', useRoomActions],
  ])('%s returns a stable object across room-store churn', (_name, hook) => {
    const { result } = renderHook(() => hook(), { wrapper })
    const before = result.current
    churnRoomStore()
    // Same object reference → the component did not re-render from store churn.
    expect(result.current).toBe(before)
  })
})
