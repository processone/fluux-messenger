/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, cleanup } from '@testing-library/react'

// Capture the conversation handler passed to useNotificationEvents.
let capturedOnConversationMessage:
  | ((conv: unknown, message: unknown) => void)
  | undefined

// Drive connection status from the test.
let currentStatus = 'connecting'
const setStatus = (s: string) => {
  currentStatus = s
}

const showWebNotification = vi.fn()

vi.mock('./useNotificationEvents', () => ({
  useNotificationEvents: (handlers: {
    onConversationMessage?: (conv: unknown, message: unknown) => void
  }) => {
    capturedOnConversationMessage = handlers.onConversationMessage
  },
}))

vi.mock('./useNotificationPermission', () => ({
  useNotificationPermission: () => {},
  getNotificationPermissionGranted: () => true,
  isTauri: false,
}))

vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({
    navigateToConversation: vi.fn(),
    navigateToRoom: vi.fn(),
  }),
}))

vi.mock('@/utils/webNotification', () => ({
  showWebNotification: (...args: unknown[]) => showWebNotification(...args),
}))

vi.mock('@/utils/notificationAvatar', () => ({
  getNotificationAvatarUrl: () => Promise.resolve(undefined),
}))

vi.mock('@/utils/messagePreviewText', () => ({
  formatLocalizedPreview: (m: { body?: string }) => m.body ?? '',
}))

vi.mock('@/utils/notificationDebug', () => ({
  notificationDebug: { desktopNotification: vi.fn() },
}))

vi.mock('@/utils/notificationRouting', () => ({
  routeNotificationTarget: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    rosterStore: { getState: () => ({ getContact: () => undefined }) },
    usePresence: () => ({ presenceStatus: 'online' }),
    useConnectionStatus: () => ({ status: currentStatus }),
  }
})

import { useDesktopNotifications } from './useDesktopNotifications'
import { newMessagesText } from '@/utils/swMessages'

const conv = (id: string) => ({
  id,
  name: id,
  unreadCount: 1,
  lastSeenMessageId: undefined,
})
const msg = (id: string, body: string) => ({
  id,
  from: `${id}@example.com`,
  body,
  timestamp: new Date(),
  isOutgoing: false,
})

// showConversationNotification is async (awaits the avatar URL before calling
// showWebNotification), so assertions must let queued microtasks settle.
// Three awaits cover the current dispatch chain depth (avatar-URL resolve →
// showWebNotification). If that chain grows another `await`, bump this count —
// the immediate-dispatch test would otherwise see 0 calls before the chain
// settles. (The windowed tests use vi.advanceTimersByTimeAsync, which drains
// microtasks between timers and isn't sensitive to this depth.)
const flushMicrotasks = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('useDesktopNotifications catch-up window', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    showWebNotification.mockClear()
    capturedOnConversationMessage = undefined
    currentStatus = 'connecting'
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('coalesces a reconnect burst into one notification per conversation', async () => {
    const { rerender } = renderHook(() => useDesktopNotifications())

    // Transition into online → catch-up window opens.
    act(() => {
      setStatus('online')
      rerender()
    })

    act(() => {
      capturedOnConversationMessage?.(conv('alice'), msg('a1', 'a'))
      capturedOnConversationMessage?.(conv('alice'), msg('a2', 'b'))
      capturedOnConversationMessage?.(conv('bob'), msg('b1', 'c'))
    })

    // Nothing fired yet — all buffered.
    expect(showWebNotification).not.toHaveBeenCalled()

    // Window closes after CATCHUP_WINDOW_MS (3000); async advance flushes the
    // awaited avatar-URL chain inside the flushed dispatches.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(showWebNotification).toHaveBeenCalledTimes(2) // alice + bob
  })

  it('dispatches immediately outside the catch-up window', async () => {
    const { rerender } = renderHook(() => useDesktopNotifications())
    // Commit the status-change render synchronously first, then advance time in a
    // separate async act (split acts avoid React 19's deferred-commit timing bug).
    act(() => {
      setStatus('online')
      rerender()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000) // window opens then closes
    })
    showWebNotification.mockClear()

    await act(async () => {
      capturedOnConversationMessage?.(conv('carol'), msg('c1', 'd'))
      await flushMicrotasks()
    })

    expect(showWebNotification).toHaveBeenCalledTimes(1)
  })

  it('surfaces the unread count in the body when a conversation has multiple unread', async () => {
    const { rerender } = renderHook(() => useDesktopNotifications())

    act(() => {
      setStatus('online')
      rerender()
    })

    // Use a conv with unreadCount: 3 to exercise the coalesced-body branch.
    // The web path keeps the plain title and moves the count into the body
    // (same-tag replacement swallows earlier messages, so the count belongs
    // in the body — see useDesktopNotifications.ts).
    const multiUnreadConv = { id: 'eve', name: 'eve', unreadCount: 3, lastSeenMessageId: undefined }
    act(() => {
      capturedOnConversationMessage?.(multiUnreadConv, msg('e1', 'hello'))
    })

    expect(showWebNotification).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(showWebNotification).toHaveBeenCalledTimes(1)
    const [title, options, nav] = showWebNotification.mock.calls[0]
    expect(title).toBe('eve')
    expect(options.body).toBe(newMessagesText('en', 3))
    expect(options.tag).toBe('eve')
    // The unread count travels in the nav/data payload so a later SW push
    // coalesces starting from this count instead of undercounting.
    expect(nav).toEqual({ from: 'eve', type: 'conversation', count: 3 })
  })

  it('drops buffered notifications when the connection leaves online', async () => {
    const { rerender } = renderHook(() => useDesktopNotifications())
    act(() => {
      setStatus('online')
      rerender()
    })
    act(() => {
      capturedOnConversationMessage?.(conv('dave'), msg('d1', 'e'))
    })

    // Commit the 'reconnecting' transition synchronously so its effect drops the
    // buffer and clears the timer BEFORE fake time advances.
    act(() => {
      setStatus('reconnecting')
      rerender()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })

    expect(showWebNotification).not.toHaveBeenCalled()
  })
})
