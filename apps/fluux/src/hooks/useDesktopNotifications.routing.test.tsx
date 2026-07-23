import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const navigateToConversation = vi.fn()
const navigateToRoom = vi.fn()
let eventCb: ((e: { payload: unknown }) => void) | undefined
const drainResult = { current: null as unknown }

vi.mock('@tauri-apps/api/event', () => ({
  listen: (_name: string, cb: (e: { payload: unknown }) => void) => {
    eventCb = cb
    return Promise.resolve(() => {})
  },
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (cmd: string) =>
    cmd === 'take_pending_notification_target'
      ? Promise.resolve(drainResult.current)
      : Promise.resolve(null),
}))
vi.mock('@tauri-apps/plugin-notification', () => ({
  sendNotification: vi.fn(),
  onAction: vi.fn(() => Promise.resolve({ unregister: vi.fn() })),
}))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => Promise.resolve('macos') }))
vi.mock('./useNavigateToTarget', () => ({
  useNavigateToTarget: () => ({ navigateToConversation, navigateToRoom, navigateToContact: vi.fn() }),
}))
vi.mock('./useNotificationPermission', () => ({
  isTauri: true,
  useNotificationPermission: () => {},
  getNotificationPermissionGranted: () => true,
}))
vi.mock('./useNotificationEvents', () => ({ useNotificationEvents: vi.fn() }))
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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))

import { useDesktopNotifications } from './useDesktopNotifications'

describe('useDesktopNotifications click routing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventCb = undefined
    drainResult.current = null
    ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  })
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  })

  it('routes a notification-activated event through the shared router', async () => {
    renderHook(() => useDesktopNotifications())
    await vi.waitFor(() => expect(eventCb).toBeTypeOf('function'))
    eventCb!({
      payload: {
        navType: 'room',
        navTarget: 'team@conf.example.com',
        messageId: 'room-message-1',
        accountId: 'me@example.com',
      },
    })
    expect(navigateToRoom).toHaveBeenCalledWith(
      'team@conf.example.com',
      'room-message-1',
    )
  })

  it('drains a pending target on startup', async () => {
    drainResult.current = { navType: 'conversation', navTarget: 'a@example.com' }
    renderHook(() => useDesktopNotifications())
    await vi.waitFor(() =>
      expect(navigateToConversation).toHaveBeenCalledWith('a@example.com', undefined),
    )
  })

  it('ignores a stale notification belonging to another account', async () => {
    renderHook(() => useDesktopNotifications())
    await vi.waitFor(() => expect(eventCb).toBeTypeOf('function'))
    eventCb!({
      payload: {
        navType: 'conversation',
        navTarget: 'alice@example.com',
        accountId: 'other@example.com',
      },
    })
    expect(navigateToConversation).not.toHaveBeenCalled()
  })
})
