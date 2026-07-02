import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { NOTIFICATION_NAVIGATE } from '@/utils/notificationNavigation'

const navigateToConversation = vi.fn()
const navigateToRoom = vi.fn()

vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({
    navigateToConversation,
    navigateToRoom,
    navigateToContact: vi.fn(),
  }),
}))

import { useServiceWorkerNavigation } from './useServiceWorkerNavigation'

// Minimal EventTarget stand-in for navigator.serviceWorker in jsdom.
function installFakeServiceWorker(): EventTarget {
  const target = new EventTarget()
  Object.defineProperty(navigator, 'serviceWorker', {
    value: target,
    configurable: true,
  })
  return target
}

describe('useServiceWorkerNavigation', () => {
  let sw: EventTarget

  beforeEach(() => {
    navigateToConversation.mockClear()
    navigateToRoom.mockClear()
    sw = installFakeServiceWorker()
  })

  afterEach(() => {
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker
  })

  it('routes a conversation navigate message to navigateToConversation', () => {
    renderHook(() => useServiceWorkerNavigation())

    sw.dispatchEvent(
      Object.assign(new MessageEvent('message'), {
        data: { type: NOTIFICATION_NAVIGATE, navType: 'conversation', target: 'alice@example.com' },
      }),
    )

    expect(navigateToConversation).toHaveBeenCalledWith('alice@example.com')
    expect(navigateToRoom).not.toHaveBeenCalled()
  })

  it('routes a room navigate message to navigateToRoom', () => {
    renderHook(() => useServiceWorkerNavigation())

    sw.dispatchEvent(
      Object.assign(new MessageEvent('message'), {
        data: { type: NOTIFICATION_NAVIGATE, navType: 'room', target: 'lobby@conf.example.com' },
      }),
    )

    expect(navigateToRoom).toHaveBeenCalledWith('lobby@conf.example.com')
    expect(navigateToConversation).not.toHaveBeenCalled()
  })

  it('ignores unrelated service-worker messages', () => {
    renderHook(() => useServiceWorkerNavigation())

    sw.dispatchEvent(
      Object.assign(new MessageEvent('message'), { data: { type: 'SKIP_WAITING' } }),
    )

    expect(navigateToConversation).not.toHaveBeenCalled()
    expect(navigateToRoom).not.toHaveBeenCalled()
  })

  it('removes its listener on unmount', () => {
    const { unmount } = renderHook(() => useServiceWorkerNavigation())
    unmount()

    sw.dispatchEvent(
      Object.assign(new MessageEvent('message'), {
        data: { type: NOTIFICATION_NAVIGATE, navType: 'conversation', target: 'alice@example.com' },
      }),
    )

    expect(navigateToConversation).not.toHaveBeenCalled()
  })
})
