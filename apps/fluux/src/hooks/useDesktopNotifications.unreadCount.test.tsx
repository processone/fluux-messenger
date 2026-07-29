/**
 * @vitest-environment jsdom
 *
 * Pins the deliberate split in useDesktopNotifications' unread-count handling:
 * the human-visible title formats through formatUnreadCount (covered in
 * useDesktopNotifications.posting.test.tsx, which mocks isTauri: true), while the
 * i18n plural argument and the web navigation payload's `count` field stay raw
 * numbers.
 * Formatting either of the latter would break ICU plural selection or turn a
 * machine-readable field into a string — a future "route every count through the
 * formatter" sweep must not touch them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const showWebNotification = vi.fn()

let handlers: {
  onConversationMessage?: (conv: unknown, msg: unknown) => unknown
  onRoomMessage?: (room: unknown, msg: unknown) => unknown
} = {}

vi.mock('./useNotificationEvents', () => ({
  useNotificationEvents: (h: typeof handlers) => { handlers = h },
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
  formatLocalizedPreview: () => 'body text',
}))
vi.mock('@/utils/notificationDebug', () => ({
  notificationDebug: { desktopNotification: vi.fn() },
}))
vi.mock('@/utils/notificationRouting', () => ({ routeNotificationTarget: vi.fn() }))
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}))
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    rosterStore: { getState: () => ({ getContact: () => undefined }) },
    connectionStore: { getState: () => ({ jid: 'me@example.com' }) },
    usePresence: () => ({ presenceStatus: 'online' }),
    useConnectionStatus: () => ({ status: 'disconnected' }),
  }
})

import { useDesktopNotifications } from './useDesktopNotifications'
import { newMessagesText } from '@/utils/swMessages'

describe('useDesktopNotifications saturated unread count', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
  })

  it('keeps the conversation plural argument and payload count numeric', async () => {
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.(
      { id: 'alice@example.com', name: 'Alice', unreadCount: 999 },
      { id: 'message-1', from: 'alice@example.com' },
    )
    const [title, options, payload] = showWebNotification.mock.calls[0]
    expect(title).toBe('Alice')
    // Plural selection ran on the number, not on the "999+" string.
    expect(options.body).toBe(newMessagesText('en', 999))
    expect(options.body).not.toContain('999+')
    expect(payload).toEqual({
      from: 'alice@example.com',
      type: 'conversation',
      count: 999,
    })
    expect(typeof payload.count).toBe('number')
  })

  it('keeps the room plural argument and payload count numeric', async () => {
    renderHook(() => useDesktopNotifications())
    await handlers.onRoomMessage?.(
      { jid: 'team@conf.example.com', name: 'Team', unreadCount: 1200 },
      { id: 'room-message-1', nick: 'bob' },
    )
    const [title, options, payload] = showWebNotification.mock.calls[0]
    // The coalesced room title is the room name — it never interpolates a count.
    expect(title).toBe('Team')
    expect(options.body).toBe(newMessagesText('en', 1200))
    expect(payload).toEqual({
      from: 'team@conf.example.com',
      type: 'room',
      count: 1200,
    })
    expect(typeof payload.count).toBe('number')
  })
})
