import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useSDKErrorToasts } from './useSDKErrorToasts'

const mockSubscribe = vi.fn()

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({
    client: {
      subscribe: mockSubscribe,
    },
  }),
  getLocalPart: (jid: string) => jid.split('@')[0],
  // Only referenced through `instanceof` by the join-error mapper, which this
  // hook reaches via its condition-based entry point.
  RoomJoinError: class RoomJoinError extends Error {},
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'rooms.inviteRejected') {
        return `Invitation rejected: ${params?.error ?? ''}`
      }
      if (key === 'rooms.couldNotRejoin') {
        return `Could not rejoin ${params?.room ?? ''}: ${params?.reason ?? ''}`
      }
      if (key === 'rooms.nicknameInUse') return 'Nickname already in use'
      return key
    },
  }),
}))

const mockAddToast = vi.fn()
vi.mock('@/stores/toastStore', () => ({
  useToastStore: (selector: (state: { addToast: typeof mockAddToast }) => unknown) =>
    selector({ addToast: mockAddToast }),
}))

describe('useSDKErrorToasts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSubscribe.mockReturnValue(vi.fn())
  })

  it('should subscribe to the unattended failures on mount', () => {
    renderHook(() => useSDKErrorToasts())

    expect(mockSubscribe).toHaveBeenCalledTimes(2)
    expect(mockSubscribe).toHaveBeenCalledWith('room:invite-error', expect.any(Function))
    expect(mockSubscribe).toHaveBeenCalledWith('room:autojoin-error', expect.any(Function))
  })

  it('should show error toast when room:invite-error fires', () => {
    renderHook(() => useSDKErrorToasts())

    const callback = mockSubscribe.mock.calls[0][1]
    callback({ error: 'Forbidden', condition: 'forbidden', errorType: 'auth' })

    expect(mockAddToast).toHaveBeenCalledWith('error', 'Invitation rejected: Forbidden')
  })

  it('should show server text when available in error field', () => {
    renderHook(() => useSDKErrorToasts())

    const callback = mockSubscribe.mock.calls[0][1]
    callback({ error: 'You are not allowed to invite users', condition: 'forbidden', errorType: 'auth' })

    expect(mockAddToast).toHaveBeenCalledWith(
      'error',
      'Invitation rejected: You are not allowed to invite users',
    )
  })

  it('should translate the condition of a failed rejoin', () => {
    renderHook(() => useSDKErrorToasts())

    const callback = mockSubscribe.mock.calls.find(([name]) => name === 'room:autojoin-error')![1]
    callback({
      roomJid: 'team@conference.example.com',
      error: 'Room join failed: conflict',
      condition: 'conflict',
    })

    expect(mockAddToast).toHaveBeenCalledWith('error', 'Could not rejoin team: Nickname already in use')
  })

  it('should fall back to the server text on an unrecognized condition', () => {
    renderHook(() => useSDKErrorToasts())

    const callback = mockSubscribe.mock.calls.find(([name]) => name === 'room:autojoin-error')![1]
    callback({
      roomJid: 'team@conference.example.com',
      error: 'The service is going down for maintenance',
      condition: 'system-shutdown',
    })

    expect(mockAddToast).toHaveBeenCalledWith(
      'error',
      'Could not rejoin team: The service is going down for maintenance',
    )
  })

  it('should unsubscribe every subscription on unmount', () => {
    const mockUnsubscribe = vi.fn()
    mockSubscribe.mockReturnValue(mockUnsubscribe)

    const { unmount } = renderHook(() => useSDKErrorToasts())
    expect(mockUnsubscribe).not.toHaveBeenCalled()

    unmount()
    expect(mockUnsubscribe).toHaveBeenCalledTimes(2)
  })

  it('should not call addToast before an event fires', () => {
    renderHook(() => useSDKErrorToasts())

    expect(mockAddToast).not.toHaveBeenCalled()
  })
})
