/**
 * Regression (#536 follow-up): on web, the Settings "Request permission" button
 * must update the SHARED runtime gate (getNotificationPermissionGranted) — the
 * same source of truth the posting path reads — not just local component state.
 * The original handler called a local requestWebNotificationPermission() that
 * only set component state, so a web user who granted from Settings stayed
 * suppressed until the window refocused (the macOS handler was already correct).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { NotificationsSettings } from './NotificationsSettings'
import { getNotificationPermissionGranted } from '@/hooks/useNotificationPermission'

// The component reads the client + connection via the SDK; stub just what it uses.
vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnection: () => ({ webPushStatus: undefined, webPushEnabled: false, isConnected: false }),
    useXMPPContext: () => ({ client: {} }),
  }
})

// Web context (not Tauri, not macOS) so the in-page "Request permission" button renders.
vi.mock('./types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./types')>()
  return { ...actual, isTauri: () => false }
})
vi.mock('@/utils/tauriPlatform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/tauriPlatform')>()
  return { ...actual, isMacOSDesktop: vi.fn().mockResolvedValue(false) }
})

describe('NotificationsSettings — web permission gate (#536)', () => {
  beforeEach(() => {
    // jsdom has no Notification API; stub a web one in the "default" state whose
    // requestPermission() grants (and flips permission, like a real browser).
    const requestPermission = vi.fn().mockImplementation(async () => {
      ;(globalThis as unknown as { Notification: { permission: string } }).Notification.permission = 'granted'
      return 'granted'
    })
    ;(globalThis as unknown as { Notification: unknown }).Notification = Object.assign(function () {}, {
      permission: 'default',
      requestPermission,
    })
  })

  it('updates the shared runtime gate when the user grants from the web Settings button', async () => {
    render(<NotificationsSettings />)

    // The effect reads permission='default' and renders the in-page button.
    const button = await screen.findByRole('button', { name: 'settings.requestPermission' })

    // Before granting, the shared posting gate is closed.
    expect(getNotificationPermissionGranted()).toBe(false)

    fireEvent.click(button)

    // After granting via Settings, the shared gate must be open immediately —
    // no window-refocus required.
    await waitFor(() => {
      expect(getNotificationPermissionGranted()).toBe(true)
    })
  })
})
