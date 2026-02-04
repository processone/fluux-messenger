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
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'rooms.inviteRejected') {
        return `Invitation rejected: ${params?.error ?? ''}`
      }
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

  it('should subscribe to room:invite-error on mount', () => {
    renderHook(() => useSDKErrorToasts())

    expect(mockSubscribe).toHaveBeenCalledTimes(1)
    expect(mockSubscribe).toHaveBeenCalledWith('room:invite-error', expect.any(Function))
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

  it('should unsubscribe on unmount', () => {
    const mockUnsubscribe = vi.fn()
    mockSubscribe.mockReturnValue(mockUnsubscribe)

    const { unmount } = renderHook(() => useSDKErrorToasts())
    expect(mockUnsubscribe).not.toHaveBeenCalled()

    unmount()
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('should not call addToast before an event fires', () => {
    renderHook(() => useSDKErrorToasts())

    expect(mockAddToast).not.toHaveBeenCalled()
  })
})
