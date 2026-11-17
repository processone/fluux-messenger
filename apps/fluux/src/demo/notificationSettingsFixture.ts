/** Controlled OS responses for the Notifications panel browser journey.
 * These SDK-shaped states never query or change the computer's permissions.
 */
import { mockIPC, mockWindows } from '@tauri-apps/api/mocks'
import { setPlatformForTesting } from '@/platform'

export function installNotificationSettingsFixture(authorization = 'granted', badges = 'disabled') {
  const fixture = { authorization, badges, calls: [] as string[], failOpen: false, failRead: false }
  setPlatformForTesting({ shell: 'desktop', os: 'macos' })
  Object.assign(window, { __TAURI_OS_PLUGIN_INTERNALS__: { platform: 'macos', version: '26.0' } })
  mockWindows('main')
  mockIPC(command => {
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
    // The full desktop shell also lists pending shares. No shares in this fixture.
    if (command === 'plugin:share-inbox|list') return []
    return undefined
  }, { shouldMockEvents: true })
  return fixture
}
