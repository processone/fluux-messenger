import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const state = vi.hoisted(() => ({
  windowVisible: false,
  activeConversationId: null as string | null,
  activeRoomJid: null as string | null,
}))
const { setWindowVisible, markConvRead, markRoomRead, dismissNotification } = vi.hoisted(() => ({
  setWindowVisible: vi.fn(),
  markConvRead: vi.fn(),
  markRoomRead: vi.fn(),
  dismissNotification: vi.fn(),
}))

vi.mock('@fluux/sdk', () => ({
  connectionStore: { getState: () => ({ windowVisible: state.windowVisible, setWindowVisible }) },
  chatStore: { getState: () => ({ activeConversationId: state.activeConversationId, markAsRead: markConvRead }) },
  roomStore: { getState: () => ({ activeRoomJid: state.activeRoomJid, markAsRead: markRoomRead }) },
}))
vi.mock('@/utils/dismissNotification', () => ({ dismissNotification }))

import { useWindowVisibility } from './useWindowVisibility'
import { registerViewportBottomRef, _resetViewportRegistryForTesting } from '@/utils/viewportAtBottom'

const CONV = 'alice@example.com'
const ROOM = 'team@conf.example.com'

describe('useWindowVisibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.windowVisible = false
    state.activeConversationId = null
    state.activeRoomJid = null
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    _resetViewportRegistryForTesting()
  })

  it('dismisses the active conversation notification on focus regain', () => {
    state.activeConversationId = CONV
    renderHook(() => useWindowVisibility())
    expect(dismissNotification).toHaveBeenCalledWith('conversation', CONV)
  })

  it('dismisses the active room notification on focus regain', () => {
    state.activeRoomJid = ROOM
    renderHook(() => useWindowVisibility())
    expect(dismissNotification).toHaveBeenCalledWith('room', ROOM)
  })

  it('does nothing when there is no active conversation or room', () => {
    renderHook(() => useWindowVisibility())
    expect(dismissNotification).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Focus regain is not evidence of reading (issue #1076).
  //
  // Gajim gates the same transition on view_is_at_bottom(); we gated it on
  // windowAtLiveEdge, which is true for any backgrounded view parked at the
  // tail. One alt-tab therefore marked a whole room read, advanced the read
  // pointer to the newest message and destroyed the "new messages" divider.
  // -------------------------------------------------------------------------

  it('marks the active room read when the viewport is at the bottom', () => {
    state.activeRoomJid = ROOM
    registerViewportBottomRef('room', ROOM, { current: true })
    renderHook(() => useWindowVisibility())
    expect(markRoomRead).toHaveBeenCalledWith(ROOM)
  })

  it('does not mark the active room read when the viewport is scrolled up', () => {
    state.activeRoomJid = ROOM
    registerViewportBottomRef('room', ROOM, { current: false })
    renderHook(() => useWindowVisibility())
    expect(markRoomRead).not.toHaveBeenCalled()
  })

  it('marks the active conversation read when the viewport is at the bottom', () => {
    state.activeConversationId = CONV
    registerViewportBottomRef('conversation', CONV, { current: true })
    renderHook(() => useWindowVisibility())
    expect(markConvRead).toHaveBeenCalledWith(CONV)
  })

  it('does not mark the active conversation read when the viewport is scrolled up', () => {
    state.activeConversationId = CONV
    registerViewportBottomRef('conversation', CONV, { current: false })
    renderHook(() => useWindowVisibility())
    expect(markConvRead).not.toHaveBeenCalled()
  })

  it('does not mark read when no viewport is registered for the active view', () => {
    state.activeRoomJid = ROOM
    renderHook(() => useWindowVisibility())
    expect(markRoomRead).not.toHaveBeenCalled()
  })

  it('reads the ref live, so a scroll after registration is respected', () => {
    state.activeRoomJid = ROOM
    const ref = { current: true }
    registerViewportBottomRef('room', ROOM, ref)
    ref.current = false // user scrolled up before refocusing
    renderHook(() => useWindowVisibility())
    expect(markRoomRead).not.toHaveBeenCalled()
  })
})
