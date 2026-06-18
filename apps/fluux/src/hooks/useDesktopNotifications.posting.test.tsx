import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

// vi.mock factories are hoisted to top of file, so mocks that reference vi.fn()
// vars must be declared with vi.hoisted() to be available before hoisting.
const {
  invoke,
  sendNotification,
  onAction,
  listen,
  isMacOSDesktop,
  platform,
  navigateToConversation,
  navigateToRoom,
} = vi.hoisted(() => ({
  invoke: vi.fn().mockResolvedValue(null),
  sendNotification: vi.fn(),
  onAction: vi.fn(() => Promise.resolve({ unregister: vi.fn() })),
  listen: vi.fn(() => Promise.resolve(() => {})),
  isMacOSDesktop: vi.fn(),
  platform: vi.fn().mockResolvedValue('macos'),
  navigateToConversation: vi.fn(),
  navigateToRoom: vi.fn(),
}))

// Capture the handlers the hook registers with useNotificationEvents.
let handlers: {
  onConversationMessage?: (conv: unknown, msg: unknown) => unknown
  onRoomMessage?: (room: unknown, msg: unknown) => unknown
} = {}

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@tauri-apps/plugin-notification', () => ({ sendNotification, onAction }))
vi.mock('@tauri-apps/plugin-os', () => ({ platform }))
vi.mock('@/utils/tauriPlatform', () => ({ isMacOSDesktop }))
vi.mock('@/utils/notificationAvatar', () => ({ getNotificationAvatarUrl: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/utils/messagePreviewText', () => ({ formatLocalizedPreview: () => 'body text' }))
vi.mock('@/utils/notificationDebug', () => ({ notificationDebug: { desktopNotification: vi.fn() } }))
vi.mock('@/utils/webNotification', () => ({ showWebNotification: vi.fn() }))
vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation, navigateToRoom, navigateToContact: vi.fn() }),
}))
vi.mock('./useNotificationPermission', () => ({
  isTauri: true,
  useNotificationPermission: () => {},
  getNotificationPermissionGranted: () => true,
}))
vi.mock('./useNotificationEvents', () => ({
  useNotificationEvents: (h: typeof handlers) => { handlers = h },
}))
vi.mock('@fluux/sdk', () => ({
  rosterStore: { getState: () => ({ getContact: () => undefined }) },
  usePresence: () => ({ presenceStatus: 'online' }),
  useConnectionStatus: () => ({ status: 'disconnected' }),
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

import { useDesktopNotifications } from './useDesktopNotifications'

describe('useDesktopNotifications posting + guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers = {}
    platform.mockResolvedValue('macos')
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('posts a conversation via the native command on macOS', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.({ id: 'alice@example.com', name: 'Alice' }, { from: 'alice@example.com' })
    expect(invoke).toHaveBeenCalledWith('post_notification', {
      title: 'Alice',
      body: 'body text',
      navType: 'conversation',
      navTarget: 'alice@example.com',
      avatarPath: null,
    })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('posts a room via the native command on macOS', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    renderHook(() => useDesktopNotifications())
    await handlers.onRoomMessage?.({ jid: 'team@conf.example.com', name: 'Team' }, { nick: 'bob' })
    expect(invoke).toHaveBeenCalledWith('post_notification', {
      title: 'bob @ Team',
      body: 'body text',
      navType: 'room',
      navTarget: 'team@conf.example.com',
      avatarPath: null,
    })
    expect(sendNotification).not.toHaveBeenCalled()
  })

  it('posts via the plugin (sendNotification) on non-macOS Tauri', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    renderHook(() => useDesktopNotifications())
    await handlers.onConversationMessage?.({ id: 'alice@example.com', name: 'Alice' }, { from: 'alice@example.com' })
    expect(sendNotification).toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalledWith('post_notification', expect.anything())
  })

  it('does NOT call onAction on macOS desktop (mobile-only guard)', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    platform.mockResolvedValue('macos')
    renderHook(() => useDesktopNotifications())
    await vi.waitFor(() => expect(listen).toHaveBeenCalled())
    // let the mobile IIFE resolve its dynamic import + platform() before asserting the negative
    await new Promise((r) => setTimeout(r, 0))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('DOES call onAction on mobile (ios)', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    platform.mockResolvedValue('ios')
    renderHook(() => useDesktopNotifications())
    await vi.waitFor(() => expect(onAction).toHaveBeenCalled())
  })
})
