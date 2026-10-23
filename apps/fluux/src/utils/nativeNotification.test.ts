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

// Source intent: #1386 requires eligibility checks after asynchronous native donation,
// and a single scheduling decision without an accidental legacy resend.
describe('communication prototype prepare/commit boundary', () => {
  const payload = { ...NOTIFICATION, communication: { senderId: 'sender@example.com', senderName: 'Sender' } }
  beforeEach(() => { mockInvoke.mockReset().mockResolvedValue(null); vi.stubGlobal('__FLUUX_COMMUNICATION_PROTOTYPE__', true) })
  afterEach(() => { vi.unstubAllGlobals() })

  // FLM-110 F2: a production/Dev host must not prepare even if a caller supplies metadata.
  it('posts directly on the legacy path when the host has not enabled the prototype', async () => {
    vi.unstubAllGlobals()
    const eligible = vi.fn()
    await postNativeDesktopNotification(payload, eligible)
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual(['post_notification'])
    expect(mockInvoke.mock.calls[0][1]).not.toHaveProperty('communication')
    expect(eligible).not.toHaveBeenCalled()
  })

  // Captain's F1 choice: a null preparation must not add an eligibility check to normal builds.
  it.each([true, false])('keeps legacy eligibility when preparation returns null (callback would return %s)', async (allowed) => {
    const eligible = vi.fn().mockResolvedValue(allowed)
    await postNativeDesktopNotification(payload, eligible)
    expect(eligible).not.toHaveBeenCalled()
    expect(mockInvoke.mock.calls.at(-1)?.[1]).not.toHaveProperty('communication')
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual(['prepare_communication_notification', 'post_notification'])
  })

  it.each([true, false])('commits only the prepared token when current eligibility is %s', async (allowed) => {
    mockInvoke.mockResolvedValueOnce('prepared-token')
    const eligible = vi.fn().mockResolvedValue(allowed)
    await postNativeDesktopNotification(payload, eligible)
    expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual(['prepare_communication_notification', 'finish_communication_notification'])
    expect(mockInvoke).toHaveBeenLastCalledWith('finish_communication_notification', { token: 'prepared-token', commit: allowed })
  })

  it('does not resend a suppressed duplicate', async () => {
    mockInvoke.mockResolvedValueOnce('')
    await postNativeDesktopNotification(payload)
    expect(mockInvoke).toHaveBeenCalledTimes(1)
  })

  it('cancels the token if revalidation fails unexpectedly', async () => {
    mockInvoke.mockResolvedValueOnce('prepared-token')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await postNativeDesktopNotification(payload, async () => { throw new Error('state unavailable') })
      expect(mockInvoke).toHaveBeenLastCalledWith('finish_communication_notification', { token: 'prepared-token', commit: false })
      expect(mockInvoke.mock.calls.some(([command]) => command === 'post_notification')).toBe(false)
    } finally { log.mockRestore() }
  })

  it('does not retry an ambiguous commit failure', async () => {
    mockInvoke.mockResolvedValueOnce('prepared-token').mockRejectedValueOnce(new Error('response lost'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await postNativeDesktopNotification(payload)
      expect(mockInvoke.mock.calls.map(([command]) => command)).toEqual(['prepare_communication_notification', 'finish_communication_notification'])
    } finally { log.mockRestore() }
  })
})
