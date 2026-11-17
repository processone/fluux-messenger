/** Controlled OS responses for the Notifications panel browser journey.
 * These SDK-shaped states never query or change the computer's permissions.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { setPlatformForTesting } from '@/platform'

export function installNotificationSettingsFixture(authorization = 'granted', badges = 'disabled') {
  const fixture = {
    authorization, badges, calls: [] as string[], failOpen: false, failRead: false,
    savePath: '/disposable/fluux-badge-diagnostics.json' as string | null,
    saveOptions: [] as unknown[], writes: [] as string[], failWrite: false,
  }
  setPlatformForTesting({ shell: 'desktop', os: 'macos' })
  Object.assign(window, { __TAURI_OS_PLUGIN_INTERNALS__: { platform: 'macos', version: '26.0' } })
  mockWindows('main')
  mockIPC((command, args) => {
    fixture.calls.push(command)
    if (command === 'notification_settings_state') {
      if (fixture.failRead) throw new Error('Settings read failed')
      return { authorization: fixture.authorization, badges: fixture.badges }
    }
    if (command === 'notification_permission_state') return fixture.authorization
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
    // The full desktop shell also lists pending shares. No shares in this fixture.
    if (command === 'plugin:share-inbox|list') return []
    return undefined
  }, { shouldMockEvents: true })
  return fixture
}
