import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { invoke, createChannel, version } = vi.hoisted(() => ({
  invoke: vi.fn(),
  createChannel: vi.fn(),
  version: vi.fn(),
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-notification', async (importOriginal) => ({
  ...await importOriginal<typeof import('@tauri-apps/plugin-notification')>(),
  createChannel,
}))
vi.mock('@tauri-apps/plugin-os', () => ({ platform: () => 'android', version }))

import { postPluginNotification } from './postPluginNotification'
import { Importance } from '@tauri-apps/plugin-notification'
import { setPlatformForTesting } from '@/platform'
import { useSettingsStore } from '@/stores/settingsStore'

describe('postPluginNotification', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>
  let restorePlatform: () => void

  beforeEach(() => {
    vi.clearAllMocks()
    invoke.mockResolvedValue(null)
    createChannel.mockResolvedValue(undefined)
    version.mockReturnValue('8.0.0')
    restorePlatform = setPlatformForTesting({ shell: 'mobile', os: 'android' })
    useSettingsStore.setState({ soundEnabled: true })
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errorSpy.mockRestore()
    restorePlatform()
  })

  it('invokes the plugin notify command with the options verbatim', async () => {
    invoke.mockResolvedValue(null)

    await postPluginNotification({
      title: 'Alice',
      body: 'hello',
      extra: { navType: 'conversation', navTarget: 'alice@example.com' },
    })

    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
      options: {
        title: 'Alice',
        body: 'hello',
        extra: { navType: 'conversation', navTarget: 'alice@example.com' },
      },
    })
    expect(createChannel).not.toHaveBeenCalled()
  })

  it.each(['conversation', 'room', 'contact-request', 'room-invitation', 'voice-request'])(
    'uses a silent channel for %s when sound is disabled', async (navType) => {
      useSettingsStore.setState({ soundEnabled: false })
      const options = { title: 'Fluux', body: 'hello', extra: { navType, navTarget: 'alice@example.com' } }

      await postPluginNotification(options)

      expect(createChannel).toHaveBeenCalledWith({
        id: 'fluux-silent',
        name: expect.any(String),
        importance: Importance.Low,
        vibration: false,
      })
      expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
        options: { ...options, channelId: 'fluux-silent' },
      })
      expect(options).not.toHaveProperty('channelId')
    },
  )

  it('waits for the channel to exist before posting', async () => {
    useSettingsStore.setState({ soundEnabled: false })
    let finish!: () => void
    createChannel.mockReturnValue(new Promise<void>(resolve => { finish = resolve }))

    const posting = postPluginNotification({ title: 'Alice' })
    expect(invoke).not.toHaveBeenCalled()
    finish()
    await posting
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('uses the default channel again after sound is enabled', async () => {
    useSettingsStore.setState({ soundEnabled: false })
    await postPluginNotification({ title: 'Silent' })
    useSettingsStore.setState({ soundEnabled: true })

    await postPluginNotification({ title: 'Audible' })

    expect(createChannel).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenLastCalledWith('plugin:notification|notify', {
      options: { title: 'Audible' },
    })
  })

  it('does not fall back to an audible notification if channel creation fails', async () => {
    useSettingsStore.setState({ soundEnabled: false })
    createChannel.mockRejectedValue(new Error('channel permission denied'))

    await expect(postPluginNotification({ title: 'Alice' })).resolves.toBeUndefined()

    expect(invoke).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('preserves the older Android delivery path without unsupported channels', async () => {
    useSettingsStore.setState({ soundEnabled: false })
    version.mockReturnValue('7.1.2')

    await postPluginNotification({ title: 'Alice' })

    expect(createChannel).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', { options: { title: 'Alice' } })
  })

  it('attempts silent delivery when the Android release cannot be identified', async () => {
    useSettingsStore.setState({ soundEnabled: false })
    version.mockReturnValue('Unknown')

    await postPluginNotification({ title: 'Alice' })

    expect(createChannel).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', {
      options: { title: 'Alice', channelId: 'fluux-silent' },
    })
  })

  it('does not create an Android channel on iOS', async () => {
    useSettingsStore.setState({ soundEnabled: false })
    const restoreIOS = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    try {
      await postPluginNotification({ title: 'Alice' })
      expect(createChannel).not.toHaveBeenCalled()
      expect(version).not.toHaveBeenCalled()
      expect(invoke).toHaveBeenCalledWith('plugin:notification|notify', { options: { title: 'Alice' } })
    } finally {
      restoreIOS()
    }
  })

  // The defect this module exists to fix: the plugin's own sendNotification()
  // is synchronous and drops the invoke promise, so a rejected notify command
  // left no trace anywhere. Logging it puts the failure in fluux.log, which
  // main.rs feeds from the webview console.
  it('logs a rejected notify command instead of swallowing it', async () => {
    invoke.mockRejectedValue(new Error('notification.notify not allowed by ACL'))

    await postPluginNotification({ title: 'Alice', body: 'hello' })

    expect(errorSpy).toHaveBeenCalledTimes(1)
    const logged = errorSpy.mock.calls[0].join(' ')
    expect(logged).toContain('not allowed by ACL')
  })

  it('does not reject when the command fails, so callers stay fire-and-forget', async () => {
    invoke.mockRejectedValue(new Error('boom'))

    await expect(postPluginNotification({ title: 'Alice' })).resolves.toBeUndefined()
  })

  // Control: a successful post must stay silent, or the assertion above would
  // pass for a module that logs unconditionally.
  it('logs nothing when the command succeeds', async () => {
    invoke.mockResolvedValue(null)

    await postPluginNotification({ title: 'Alice', body: 'hello' })

    expect(errorSpy).not.toHaveBeenCalled()
  })
})
