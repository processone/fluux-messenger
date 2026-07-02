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

describe('useWindowVisibility', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.windowVisible = false
    state.activeConversationId = null
    state.activeRoomJid = null
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  })

  it('dismisses the active conversation notification on focus regain', () => {
    state.activeConversationId = 'alice@example.com'
    renderHook(() => useWindowVisibility())
    expect(markConvRead).toHaveBeenCalledWith('alice@example.com')
    expect(dismissNotification).toHaveBeenCalledWith('conversation', 'alice@example.com')
  })

  it('dismisses the active room notification on focus regain', () => {
    state.activeRoomJid = 'team@conf.example.com'
    renderHook(() => useWindowVisibility())
    expect(markRoomRead).toHaveBeenCalledWith('team@conf.example.com')
    expect(dismissNotification).toHaveBeenCalledWith('room', 'team@conf.example.com')
  })

  it('does nothing when there is no active conversation or room', () => {
    renderHook(() => useWindowVisibility())
    expect(dismissNotification).not.toHaveBeenCalled()
  })
})
