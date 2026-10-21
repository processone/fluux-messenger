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
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

// Mutable mock state — `mock`-prefixed so vitest permits referencing them
// inside the hoisted vi.mock factories.
let mockWebPushSupported = false
let mockConnection = { webPushStatus: 'unavailable', webPushEnabled: false, isConnected: false }
let mockIsMac = true
let mockPermState = 'granted'
const mockGetTrayStatus = vi.fn().mockResolvedValue({ enabled: true, available: true })
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
    useConnection: () => mockConnection,
    useXMPPContext: () => ({ client: {} }),
  }
})

vi.mock('@/utils/tauriPlatform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/tauriPlatform')>()
  return { ...actual, isMacOSDesktop: () => Promise.resolve(mockIsMac) }
})

import { setPlatformForTesting, type PlatformOS, type PlatformShell } from '@/platform'

// One seam for the platform, shared with the app code under test.
let restorePlatform: (() => void) | undefined
function usePlatform(shell: PlatformShell, os: PlatformOS = 'macos') {
  restorePlatform?.()
  restorePlatform = setPlatformForTesting({ shell, os })
}

vi.mock('@/utils/windowBehavior', () => ({
  getTrayStatus: () => mockGetTrayStatus(),
}))

vi.mock('@/hooks/useNotificationPermission', () => ({
  refreshNotificationPermission: vi.fn().mockResolvedValue(true),
  requestNotificationPermission: vi.fn().mockResolvedValue(true),
}))

vi.mock('@/hooks/useWebPush', () => ({
  get isWebPushSupported() { return mockWebPushSupported },
  requestWebPushRegistration: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))
vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn().mockResolvedValue(true),
}))

import { NotificationsSettings } from './NotificationsSettings'
import { useSettingsStore } from '@/stores/settingsStore'

const LINK = 'settings.openSystemNotificationSettings'

describe('NotificationsSettings — system notification settings link', () => {
  beforeEach(() => {
    usePlatform('desktop')
    mockIsMac = true
    mockPermState = 'granted'
    mockGetTrayStatus.mockReset().mockResolvedValue({ enabled: true, available: true })
    useSettingsStore.setState({ keepInSystemTray: true })
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
    usePlatform('web')
    mockIsMac = false

    render(<NotificationsSettings />)

    await waitFor(() => expect(screen.queryByText('settings.notificationChecking')).not.toBeInTheDocument())
    expect(screen.getByText('settings.notificationStatusWeb')).toBeInTheDocument()
    expect(screen.queryByText(LINK)).not.toBeInTheDocument()
  })

  it('uses the desktop status wording on the Tauri build', async () => {
    render(<NotificationsSettings />)

    expect(await screen.findByText('settings.notificationStatus')).toBeInTheDocument()
    expect(screen.queryByText('settings.notificationStatusWeb')).not.toBeInTheDocument()
  })

  it('reads Android permission without offering the desktop settings command', async () => {
    usePlatform('mobile', 'android')
    mockIsMac = false

    render(<NotificationsSettings />)

    expect(await screen.findByText('settings.notificationEnabled')).toBeInTheDocument()
    expect(screen.queryByText(LINK)).not.toBeInTheDocument()
    expect(mockInvoke).not.toHaveBeenCalled()
  })

  it('shows and updates the tray preference on Windows', async () => {
    usePlatform('desktop', 'windows')
    mockIsMac = false
    render(<NotificationsSettings />)

    const toggle = await screen.findByRole('switch', {
      name: 'settings.systemTray.keepInTray',
    })
    expect(toggle).toBeEnabled()
    fireEvent.click(toggle)
    expect(useSettingsStore.getState().keepInSystemTray).toBe(false)
    expect(screen.getByText('settings.systemTray.descriptionWindows')).toBeInTheDocument()
  })

  it('keeps Linux close-to-tray unavailable without a StatusNotifier host', async () => {
    usePlatform('desktop', 'linux')
    mockIsMac = false
    mockGetTrayStatus.mockResolvedValue({ enabled: true, available: false })
    render(<NotificationsSettings />)

    const toggle = await screen.findByRole('switch', {
      name: 'settings.systemTray.keepInTray',
    })
    expect(toggle).toBeDisabled()
    expect(screen.getByText('settings.systemTray.descriptionLinux')).toBeInTheDocument()
    expect(screen.getByText('settings.systemTray.unavailableLinux')).toBeInTheDocument()
  })
})

describe('NotificationsSettings — notification sound', () => {
  beforeEach(() => {
    usePlatform('desktop')
    mockIsMac = true
    mockPermState = 'granted'
    useSettingsStore.setState({ soundEnabled: true })
  })

  it('renders the sound toggle reflecting the store', async () => {
    render(<NotificationsSettings />)
    await screen.findByText(LINK)

    expect(screen.getByText('settings.soundDescription')).toBeInTheDocument()
    expect(screen.getByRole('switch', { name: 'settings.sound' })).toHaveAttribute('aria-checked', 'true')
  })

  it('turns the sound off when the toggle is clicked', async () => {
    render(<NotificationsSettings />)
    await screen.findByText(LINK)

    fireEvent.click(screen.getByRole('switch', { name: 'settings.sound' }))

    expect(useSettingsStore.getState().soundEnabled).toBe(false)
  })
})


describe('NotificationsSettings — hierarchy', () => {
  beforeEach(() => {
    usePlatform('web')
    mockIsMac = false
    mockWebPushSupported = true
    mockConnection = { webPushStatus: 'registered', webPushEnabled: true, isConnected: true }
    vi.stubGlobal('Notification', { permission: 'granted' })
  })
  afterEach(() => {
    mockWebPushSupported = false
    mockConnection = { webPushStatus: 'unavailable', webPushEnabled: false, isConnected: false }
    vi.unstubAllGlobals()
  })

  it('separates permission, background delivery and sounds in that order', async () => {
    render(<NotificationsSettings />)
    await screen.findByText('settings.notificationEnabled')
    const permission = screen.getByRole('heading', { name: 'settings.notificationPermission' }).closest('section')!
    const background = screen.getByRole('heading', { name: 'settings.webPushStatus' }).closest('section')!
    const sounds = screen.getByRole('heading', { name: 'settings.soundsSection' }).closest('section')!
    expect(within(permission).getByText('settings.notificationEnabled')).toBeVisible()
    expect(within(permission).queryByText('settings.webPush_registered')).toBeNull()
    expect(within(background).getByRole('button', { name: 'settings.webPushDisable' })).toBeVisible()
    expect(within(sounds).getByRole('switch', { name: 'settings.sound' })).toBeVisible()
    expect(permission.compareDocumentPosition(background) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(background.compareDocumentPosition(sounds) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('directs a denied browser permission to site settings while preserving the distinct push state', async () => {
    vi.stubGlobal('Notification', { permission: 'denied' })
    render(<NotificationsSettings />)
    expect(await screen.findByText('settings.notificationDeniedWeb')).toBeVisible()
    expect(screen.queryByText('settings.notificationDenied')).toBeNull()
    expect(screen.queryByText(LINK)).toBeNull()
    expect(screen.getByText('settings.webPush_registered')).toBeVisible()
  })

  it.each([
    ['available', true, 'settings.webPushEnable'],
    ['registered', true, 'settings.webPushDisable'],
    ['disabled', false, 'settings.webPushReEnable'],
  ] as const)('keeps the contextual action for %s delivery', async (status, enabled, action) => {
    mockConnection = { webPushStatus: status, webPushEnabled: enabled, isConnected: true }
    render(<NotificationsSettings />)
    await screen.findByText('settings.notificationEnabled')
    expect(screen.getByRole('button', { name: action })).toBeVisible()
  })

  it('keeps the iOS preview explanation separate from delivery and sounds', async () => {
    usePlatform('mobile', 'ios')
    render(<NotificationsSettings />)
    await screen.findByText('settings.iosPermission.granted')
    const previews = screen.getByRole('heading', { name: 'settings.messagePreviews' }).closest('section')!
    expect(within(previews).getByText('settings.oxNotificationPreviewDescription')).toBeVisible()
    expect(within(previews).queryByRole('switch', { name: 'settings.sound' })).toBeNull()
    expect(screen.getByRole('switch', { name: 'settings.closedAppPush.title' })).toBeVisible()
  })
})
