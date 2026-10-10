import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setPlatformForTesting } from '@/platform'
import { useSettingsStore } from '@/stores/settingsStore'
import { startIOSNotificationSounds, useIOSSoundSettingsStore } from './notificationSounds'
const connection = vi.hoisted(() => {
  let state = { jid: null as string | null }
  const listeners = new Set<() => void>()
  return { getState: () => state, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    setState: (next: typeof state) => { state = next; listeners.forEach(listener => listener()) } }
})
vi.mock('@fluux/sdk', () => ({ connectionStore: connection }))
const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
let stop = () => {}
let restore = () => {}
const flush = async () => { await vi.waitFor(() => expect(invoke).toHaveBeenCalled()); await new Promise(resolve => setTimeout(resolve, 0)) }
beforeEach(() => {
  localStorage.clear()
  invoke.mockClear()
  restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
  connection.setState({ jid: 'me@example.com/phone' })
  useSettingsStore.setState({ soundEnabled: true })
  useIOSSoundSettingsStore.getState().setAccount(null)
})
afterEach(() => { stop(); restore() })
describe('native notification sound preferences', () => {
  it('mirrors the active account and honours the app sound toggle and silent tone', async () => {
    stop = startIOSNotificationSounds()
    await flush()
    useIOSSoundSettingsStore.getState().setTone('silent')
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('plugin:push|set_notification_sound', { settings: { account: 'me@example.com', enabled: true, tone: 'silent' } }))
    useSettingsStore.getState().setSoundEnabled(false)
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('plugin:push|set_notification_sound', { settings: { account: 'me@example.com', enabled: false, tone: 'silent' } }))
    expect(invoke.mock.calls.every(([command]) => command === 'plugin:push|set_notification_sound')).toBe(true)
  })
  it('keeps tone choices per account, clears ownership on switch/logout, and drops stale writes', async () => {
    stop = startIOSNotificationSounds()
    await flush()
    useIOSSoundSettingsStore.getState().setTone('bell')
    connection.setState({ jid: 'other@example.com/phone' })
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('plugin:push|set_notification_sound', { settings: { account: 'other@example.com', enabled: true, tone: 'default' } }))
    expect(invoke).toHaveBeenCalledWith('plugin:push|set_notification_sound', { settings: { account: null, enabled: true, tone: 'default' } })
    connection.setState({ jid: 'me@example.com/phone' })
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('plugin:push|set_notification_sound', { settings: { account: 'me@example.com', enabled: true, tone: 'bell' } }))
    connection.setState({ jid: null })
    await vi.waitFor(() => expect(invoke).toHaveBeenLastCalledWith('plugin:push|set_notification_sound', { settings: { account: null, enabled: true, tone: 'default' } }))
  })
  it('has no native side effects on web or Android', async () => {
    restore(); restore = setPlatformForTesting({ shell: 'web', os: 'ios' })
    stop = startIOSNotificationSounds()
    useSettingsStore.getState().setSoundEnabled(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(invoke).not.toHaveBeenCalled()
  })
})
