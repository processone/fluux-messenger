/**
 * NotificationsSettings — the permanent "open system notification settings"
 * shortcut.
 *
 * The OS notification pane is reachable from the panel whenever the app is
 * already registered with the system notification center (permission granted
 * or denied), on every desktop (Tauri) build. It stays hidden while the
 * permission was never requested (macOS `default`/notdetermined) — there the
 * in-card Enable button is the correct first action and the app isn't listed
 * in System Settings yet — and on the web build, which has no OS pane to open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// Mutable mock state — `mock`-prefixed so vitest permits referencing them
// inside the hoisted vi.mock factories.
let mockIsTauri = true
let mockIsMac = true
let mockPermState = 'granted'
const mockInvoke = vi.fn(async (cmd: string) =>
  cmd === 'notification_permission_state' ? mockPermState : undefined,
)

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnection: () => ({
      webPushStatus: 'unavailable',
      webPushEnabled: false,
      isConnected: false,
    }),
    useXMPPContext: () => ({ client: {} }),
  }
})

vi.mock('./types', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./types')>()
  return { ...actual, isTauri: () => mockIsTauri }
})

vi.mock('@/utils/tauriPlatform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/tauriPlatform')>()
  return { ...actual, isMacOSDesktop: () => Promise.resolve(mockIsMac) }
})

vi.mock('@/hooks/useNotificationPermission', () => ({
  refreshNotificationPermission: vi.fn().mockResolvedValue(true),
  requestNotificationPermission: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/hooks/useWebPush', () => ({
  isWebPushSupported: false,
  requestWebPushRegistration: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

import { NotificationsSettings } from './NotificationsSettings'

const LINK = 'settings.openSystemNotificationSettings'

describe('NotificationsSettings — system notification settings link', () => {
  beforeEach(() => {
    mockIsTauri = true
    mockIsMac = true
    mockPermState = 'granted'
    mockInvoke.mockClear()
  })

  it('shows the OS-settings link when notifications are enabled (macOS, granted)', async () => {
    render(<NotificationsSettings />)

    expect(await screen.findByText(LINK)).toBeInTheDocument()
    // Sanity: the status really reads "enabled" — i.e. this is the granted case
    // from the user's screenshot, which previously had no link at all.
    expect(screen.getByText('settings.notificationEnabled')).toBeInTheDocument()
  })

  it('shows the link when permission is denied', async () => {
    mockPermState = 'denied'

    render(<NotificationsSettings />)

    expect(await screen.findByText(LINK)).toBeInTheDocument()
  })

  it('opens the OS pane via the native command when the link is clicked', async () => {
    // Regression: the link previously went through the shell `open` plugin,
    // whose scope rejects the x-apple.systempreferences: scheme, so the click
    // silently failed. It must now invoke the native open_notification_settings.
    render(<NotificationsSettings />)
    const link = await screen.findByRole('button', { name: LINK })
    mockInvoke.mockClear() // drop the initial permission-state probe

    fireEvent.click(link)

    await waitFor(() =>
      expect(mockInvoke).toHaveBeenCalledWith('open_notification_settings'),
    )
  })

  it('reports the failure in the UI when no OS settings pane could be opened', async () => {
    // Regression (#1072): on non-GNOME Linux the native command fails with
    // ENOENT and the error died in console.error, so the button did nothing at
    // all from the user's side. The failure must now be visible.
    render(<NotificationsSettings />)
    const link = await screen.findByRole('button', { name: LINK })
    // Reject the click, not the initial permission probe that already ran.
    mockInvoke.mockRejectedValueOnce(new Error('no notification settings command available'))

    fireEvent.click(link)

    expect(
      await screen.findByText('settings.openSystemNotificationSettingsFailed'),
    ).toBeInTheDocument()
  })

  it('clears a previous failure message when a later attempt succeeds', async () => {
    render(<NotificationsSettings />)
    const link = await screen.findByRole('button', { name: LINK })
    mockInvoke.mockRejectedValueOnce(new Error('no notification settings command available'))

    fireEvent.click(link)
    await screen.findByText('settings.openSystemNotificationSettingsFailed')

    fireEvent.click(link)

    await waitFor(() =>
      expect(
        screen.queryByText('settings.openSystemNotificationSettingsFailed'),
      ).not.toBeInTheDocument(),
    )
  })

  it('hides the link while permission was never requested (macOS default), offering Enable instead', async () => {
    mockPermState = 'default'

    render(<NotificationsSettings />)

    // The native Enable button is the correct first action in this state…
    expect(await screen.findByText('settings.requestPermission')).toBeInTheDocument()
    // …and the system-settings link must not appear yet.
    expect(screen.queryByText(LINK)).not.toBeInTheDocument()
  })

  it('does not render the link in the web build (not Tauri)', async () => {
    mockIsTauri = false
    mockIsMac = false

    render(<NotificationsSettings />)

    // The description always renders; once it's present the async permission
    // check has settled, so the absence of the link is meaningful. The web
    // build uses the platform-neutral copy (no "desktop" wording).
    await screen.findByText('settings.notificationDescriptionWeb')
    expect(screen.queryByText(LINK)).not.toBeInTheDocument()
  })

  it('uses the desktop wording on the Tauri build and the neutral wording on web', async () => {
    render(<NotificationsSettings />)

    expect(await screen.findByText('settings.notificationStatus')).toBeInTheDocument()
    expect(screen.getByText('settings.notificationDescription')).toBeInTheDocument()
    expect(screen.queryByText('settings.notificationStatusWeb')).not.toBeInTheDocument()
  })
})
