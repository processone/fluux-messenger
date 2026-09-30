import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockInvoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: mockInvoke }))

import { postNativeDesktopNotification } from './nativeNotification'
import { useSettingsStore } from '@/stores/settingsStore'

const NOTIFICATION = {
  title: 'Sender',
  body: 'Message',
  navType: 'conversation',
  navTarget: 'sender@example.com',
  messageId: 'm1',
  accountId: 'me@example.com',
  avatarPath: null,
}

describe('postNativeDesktopNotification', () => {
  beforeEach(() => {
    mockInvoke.mockReset().mockResolvedValue(undefined)
  })
  afterEach(() => {
    useSettingsStore.setState({ soundEnabled: true })
  })

  it('asks the native backend for a silent notification when the sound option is off', async () => {
    useSettingsStore.setState({ soundEnabled: false })
    await postNativeDesktopNotification(NOTIFICATION)
    expect(mockInvoke).toHaveBeenCalledWith('post_notification', { ...NOTIFICATION, silent: true })
  })

  it('lets the system alert play when the sound option is on', async () => {
    useSettingsStore.setState({ soundEnabled: true })
    await postNativeDesktopNotification(NOTIFICATION)
    expect(mockInvoke).toHaveBeenCalledWith('post_notification', { ...NOTIFICATION, silent: false })
  })
})
