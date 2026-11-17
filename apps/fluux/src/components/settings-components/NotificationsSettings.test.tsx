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
let mockBadges = 'enabled'
const mockGetTrayStatus = vi.fn().mockResolvedValue({ enabled: true, available: true })
const mockInvoke = vi.fn<(cmd: string) => Promise<any>>(async (cmd: string) =>
  cmd === 'notification_settings_state'
    ? { authorization: mockPermState === 'default' ? 'notdetermined' : mockPermState, badges: mockBadges }
    : undefined,
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
import { refreshNotificationPermission, requestNotificationPermission } from '@/hooks/useNotificationPermission'
import { act } from '@testing-library/react'
import { useSettingsStore } from '@/stores/settingsStore'

const mockSaveBadgeDiagnostics = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@/utils/badgeDiagnosticsExport', () => ({ saveBadgeDiagnostics: mockSaveBadgeDiagnostics }))

const LINK = 'settings.openSystemNotificationSettings'

describe('NotificationsSettings — system notification settings link', () => {
  beforeEach(() => {
    usePlatform('desktop')
    mockIsMac = true
    mockPermState = 'granted'
    mockBadges = 'enabled'
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

// Intent: the approved macOS badge-warning proposal. SDK-shaped settings
// fixtures exercise the panel boundary; they do not assert visible Dock output.
describe('NotificationsSettings — macOS badge warnings', () => {
  beforeEach(() => {
    usePlatform('desktop')
    mockIsMac = true
    mockPermState = 'granted'
    mockBadges = 'enabled'
    mockInvoke.mockClear()
    vi.mocked(requestNotificationPermission).mockClear()
    vi.mocked(refreshNotificationPermission).mockClear()
    useSettingsStore.setState({ soundEnabled: true, inAppBannerEnabled: true })
  })

  it.each([
    ['denied', 'enabled', 'settings.notificationDeniedMac'],
    ['granted', 'disabled', 'settings.badgesDisabledMac'],
    ['granted', 'enabled', 'settings.badgesEnabled'],
    ['default', 'disabled', 'settings.notificationDefault'],
    ['unknown', 'disabled', 'settings.notificationUnknownMac'],
    ['unsupported', 'unsupported', 'settings.notificationUnsupportedMac'],
    ['granted', 'unknown', 'settings.badgesUnknown'],
    ['granted', 'unsupported', 'settings.badgesUnsupported'],
    ['future-value', 'enabled', 'settings.notificationUnknownMac'],
    ['granted', 'future-value', 'settings.badgesUnknown'],
  ])('distinguishes %s authorization and %s badges', async (authorization, badges, text) => {
    mockPermState = authorization
    mockBadges = badges
    render(<NotificationsSettings />)
    expect(await screen.findByText(text)).toBeVisible()
    expect(screen.queryByText('settings.badgesDisabledMac') !== null).toBe(authorization === 'granted' && badges === 'disabled')
    expect(screen.queryByText('settings.requestPermission') !== null).toBe(authorization === 'default')
    expect(screen.queryByText('settings.notificationEnabled') !== null).toBe(authorization === 'granted')
    expect(requestNotificationPermission).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalledWith('open_notification_settings')
    expect(useSettingsStore.getState().soundEnabled).toBe(true)
    expect(useSettingsStore.getState().inAppBannerEnabled).toBe(true)
  })

  it('shows an unreadable state on a rejected native read, never Enable or enabled', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('settings read unavailable'))
    render(<NotificationsSettings />)
    expect(await screen.findByText('settings.notificationUnknownMac')).toBeVisible()
    expect(screen.queryByText('settings.notificationEnabled')).toBeNull()
    expect(screen.queryByText('settings.requestPermission')).toBeNull()
    expect(requestNotificationPermission).not.toHaveBeenCalled()
  })

  it('refreshes on focus and visible return, clearing the warning after restoration', async () => {
    mockBadges = 'disabled'
    render(<NotificationsSettings />)
    await screen.findByText('settings.badgesDisabledMac')
    mockBadges = 'enabled'
    fireEvent.focus(window)
    expect(await screen.findByText('settings.badgesEnabled')).toBeVisible()
    expect(screen.queryByText('settings.badgesDisabledMac')).toBeNull()
    mockPermState = 'denied'
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
    expect(await screen.findByText('settings.notificationDeniedMac')).toBeVisible()
    expect(refreshNotificationPermission).toHaveBeenCalled()
    expect(requestNotificationPermission).not.toHaveBeenCalled()
    expect(mockInvoke).not.toHaveBeenCalledWith('open_notification_settings')
  })

  it('does not let an older native response replace the restored state', async () => {
    let finish!: (state: any) => void
    mockInvoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<NotificationsSettings />)
    await waitFor(() => expect(finish).toBeTypeOf('function'))
    fireEvent.focus(window)
    await screen.findByText('settings.badgesEnabled')
    await act(async () => finish({ authorization: 'denied', badges: 'disabled' }))
    expect(screen.queryByText('settings.notificationDeniedMac')).toBeNull()
    expect(screen.getByText('settings.badgesEnabled')).toBeVisible()
  })

  it('keeps explicit activation and rereads badges after the request', async () => {
    mockPermState = 'default'
    render(<NotificationsSettings />)
    const button = await screen.findByRole('button', { name: 'settings.requestPermission' })
    expect(requestNotificationPermission).not.toHaveBeenCalled()
    mockPermState = 'granted'
    mockBadges = 'disabled'
    fireEvent.click(button)
    expect(await screen.findByText('settings.badgesDisabledMac')).toBeVisible()
    expect(requestNotificationPermission).toHaveBeenCalledTimes(1)
  })

  it('keeps the existing link and visible opening failure for blocked badges', async () => {
    mockBadges = 'disabled'
    render(<NotificationsSettings />)
    await screen.findByText('settings.badgesDisabledMac')
    expect(mockInvoke).not.toHaveBeenCalledWith('open_notification_settings')
    mockInvoke.mockRejectedValueOnce(new Error('opening failed'))
    fireEvent.click(screen.getByRole('button', { name: LINK }))
    expect(await screen.findByText('settings.openSystemNotificationSettingsFailed')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: LINK }))
    await waitFor(() => expect(screen.queryByText('settings.openSystemNotificationSettingsFailed')).toBeNull())
  })
})

// Captain's relocation request: export belongs to macOS Notifications, without
// depending on authorization or opening the advanced XMPP console.
describe('NotificationsSettings — badge diagnostics download', () => {
  beforeEach(() => {
    usePlatform('desktop')
    mockIsMac = true
    mockBadges = 'disabled'
    mockSaveBadgeDiagnostics.mockClear()
  })

  it.each([
    ['granted', 'settings.notificationEnabled'],
    ['denied', 'settings.notificationDeniedMac'],
    ['default', 'settings.notificationDefault'],
    ['unknown', 'settings.notificationUnknownMac'],
    ['unsupported', 'settings.notificationUnsupportedMac'],
  ])(
    'keeps export available for %s permission, only saving on a click', async (authorization, statusText) => {
      mockPermState = authorization
      render(<NotificationsSettings />)
      await screen.findByText(statusText)
      const button = screen.getByRole('button', { name: 'console.exportBadgeDiagnostics' })
      expect(button).toBeEnabled()
      expect(mockSaveBadgeDiagnostics).not.toHaveBeenCalled()
      fireEvent.click(button)
      expect(mockSaveBadgeDiagnostics).toHaveBeenCalledExactlyOnceWith('console.exportBadgeDiagnosticsFailed')
    },
  )

  it('keeps this macOS export out of other-platform permission panels', async () => {
    usePlatform('desktop', 'windows')
    mockIsMac = false
    render(<NotificationsSettings />)
    await screen.findByText('settings.notificationEnabled')
    expect(screen.queryByRole('button', { name: 'console.exportBadgeDiagnostics' })).toBeNull()
    expect(mockSaveBadgeDiagnostics).not.toHaveBeenCalled()
  })
})

describe('NotificationsSettings — notification sound', () => {
  beforeEach(() => {
    usePlatform('desktop')
    mockIsMac = true
    mockPermState = 'granted'
    mockBadges = 'enabled'
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
