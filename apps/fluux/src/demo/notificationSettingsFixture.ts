/** Controlled OS responses for the Notifications panel browser journey.
 * These SDK-shaped states never query or change the computer's permissions.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { setPlatformForTesting, type PlatformOS, type PlatformShell } from '@/platform'

export function installNotificationSettingsFixture(
  authorization = 'granted', badges = 'disabled',
  host: { shell: PlatformShell; os: PlatformOS } = { shell: 'desktop', os: 'macos' },
) {
  const fixture = {
    authorization, badges, alerts: 'enabled', sounds: 'enabled', alertStyle: 'banner', calls: [] as string[], failOpen: false, failRead: false,
    savePath: '/disposable/fluux-badge-diagnostics.json' as string | null,
    saveOptions: [] as unknown[], writes: [] as string[], failWrite: false,
    shares: [] as { path: string; name: string }[],
  }
  setPlatformForTesting(host)
  Object.assign(window, { __TAURI_OS_PLUGIN_INTERNALS__: { platform: host.os, version: '26.0' } })
  mockWindows('main')
  mockIPC((command, args) => {
    fixture.calls.push(command)
    if (command === 'notification_settings_state') {
      if (fixture.failRead) throw new Error('Settings read failed')
      return { authorization: fixture.authorization, badges: fixture.badges, alerts: fixture.alerts, sounds: fixture.sounds, alertStyle: fixture.alertStyle }
    }
    if (command === 'notification_permission_state') return fixture.authorization
    if (command === 'plugin:notification|is_permission_granted') return fixture.authorization === 'granted'
    if (command === 'get_tray_status') return { enabled: true, available: true }
    if (command === 'request_notification_permission') {
      fixture.authorization = 'granted'
      return 'granted'
    }
    if (command === 'open_notification_settings' && fixture.failOpen) throw new Error('Opening failed')
    if (command === 'plugin:dialog|save') {
      fixture.saveOptions.push(args)
      return fixture.savePath
    }
    if (command === 'plugin:fs|write_file') {
      if (fixture.failWrite) throw new Error('Disposable file write denied')
      fixture.writes.push(new TextDecoder().decode(args as unknown as Uint8Array))
    }
    if (command === 'plugin:path|resolve_directory') return '/disposable/cache'
    if (command === 'plugin:path|join') return (args as { paths: string[] }).paths.join('/')
    if (command === 'plugin:share-sheet|share_file') {
      fixture.shares.push(args as { path: string; name: string })
    }
    // The full desktop shell also lists pending shares. No shares in this fixture.
    if (command === 'plugin:share-inbox|list') return []
    return undefined
  }, { shouldMockEvents: true })
  return fixture
}
