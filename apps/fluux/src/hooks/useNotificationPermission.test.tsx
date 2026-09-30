/**
 * The notification permission gate is module-level shared state. It must re-arm
 * the once-per-session prompt AND re-sync the gate when the ACCOUNT changes
 * (login of a different account, logout→login) — otherwise a grant/deny from a
 * previous account carries over and the gate goes stale. A plain reconnect (same
 * account) must NOT re-prompt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

const { nativePermissionRead, nativePermissionRequest } = vi.hoisted(() => ({
  nativePermissionRead: vi.fn(),
  nativePermissionRequest: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: nativePermissionRead,
  requestPermission: nativePermissionRequest,
}))
vi.mock('@/utils/tauriPlatform', () => ({
  isMacOSDesktop: vi.fn().mockResolvedValue(false),
}))

// Controllable connection store. The hook reads status + jid via selectors.
let connState: { status: string; jid: string | null } = { status: 'offline', jid: null }

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (s: typeof connState) => unknown) => selector(connState),
}))

type NotificationStub = { permission: string; requestPermission: ReturnType<typeof vi.fn> }

function stubNotification(initial: string): ReturnType<typeof vi.fn> {
  const requestPermission = vi.fn().mockImplementation(async () => {
    ;(globalThis as unknown as { Notification: NotificationStub }).Notification.permission = 'granted'
    return 'granted'
  })
  ;(globalThis as unknown as { Notification: unknown }).Notification = Object.assign(function () {}, {
    permission: initial,
    requestPermission,
  })
  return requestPermission
}

function setNotificationPermission(p: string) {
  ;(globalThis as unknown as { Notification: NotificationStub }).Notification.permission = p
}

describe('useNotificationPermission — account switch re-arms the gate', () => {
  beforeEach(() => {
    vi.resetModules() // fresh module-level latch + gate per test
    connState = { status: 'offline', jid: null }
  })

  it('auto-prompts once per account, re-prompts on account switch, NOT on reconnect', async () => {
    const requestPermission = stubNotification('default')
    const { useNotificationPermission } = await import('./useNotificationPermission')
    const { rerender } = renderHook(() => useNotificationPermission())

    // Account A online → one prompt.
    await act(async () => {
      connState = { status: 'online', jid: 'a@example.com' }
      rerender()
    })
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1))

    // Plain reconnect (same account): offline → online, same jid → no re-prompt.
    await act(async () => {
      connState = { status: 'connecting', jid: 'a@example.com' }
      rerender()
    })
    await act(async () => {
      connState = { status: 'online', jid: 'a@example.com' }
      rerender()
    })
    expect(requestPermission).toHaveBeenCalledTimes(1)

    // Switch to account B (OS state back to "default" so the prompt is
    // observable) → the JID-keyed latch re-arms and prompts again.
    setNotificationPermission('default')
    await act(async () => {
      connState = { status: 'online', jid: 'b@example.com' }
      rerender()
    })
    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(2))
  })

  it('re-syncs the gate to the live OS permission on account switch', async () => {
    stubNotification('default')
    const { useNotificationPermission, getNotificationPermissionGranted } = await import(
      './useNotificationPermission'
    )
    const { rerender } = renderHook(() => useNotificationPermission())

    // Account A grants → gate open.
    await act(async () => {
      connState = { status: 'online', jid: 'a@example.com' }
      rerender()
    })
    await waitFor(() => expect(getNotificationPermissionGranted()).toBe(true))

    // OS permission revoked while signed in; switching account must re-sync the
    // gate instead of carrying the stale grant.
    setNotificationPermission('denied')
    await act(async () => {
      connState = { status: 'online', jid: 'b@example.com' }
      rerender()
    })
    await waitFor(() => expect(getNotificationPermissionGranted()).toBe(false))
  })

  it('reads and requests Android permission through the notification plugin', async () => {
    const webRequest = stubNotification('granted')
    const { setPlatformForTesting } = await import('@/platform')
    const restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    try {
      nativePermissionRead.mockResolvedValue(false)
      nativePermissionRequest.mockResolvedValue('granted')
      const {
        refreshNotificationPermission,
        requestNotificationPermission,
        getNotificationPermissionGranted,
      } = await import('./useNotificationPermission')

      expect(await refreshNotificationPermission()).toBe(false)
      expect(getNotificationPermissionGranted()).toBe(false)
      expect(nativePermissionRead).toHaveBeenCalledTimes(1)
      expect(await requestNotificationPermission()).toBe(true)
      expect(getNotificationPermissionGranted()).toBe(true)
      expect(nativePermissionRequest).toHaveBeenCalledTimes(1)
      expect(webRequest).not.toHaveBeenCalled()
    } finally {
      restorePlatform()
    }
  })
})
