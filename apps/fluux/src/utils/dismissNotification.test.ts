import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { isMacOSDesktop, invoke } = vi.hoisted(() => ({
  isMacOSDesktop: vi.fn(),
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/utils/tauriPlatform', () => ({ isMacOSDesktop }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { dismissNotification } from './dismissNotification'

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

describe('dismissNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => setTauri(false))

  it('macOS: invokes the native command with the conversation identifier', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    setTauri(true)
    await dismissNotification('conversation', 'alice@example.com')
    expect(invoke).toHaveBeenCalledWith('remove_delivered_notifications', {
      identifiers: ['conversation:alice@example.com'],
    })
  })

  it('macOS: uses the room identifier for rooms', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    setTauri(true)
    await dismissNotification('room', 'team@conf.example.com')
    expect(invoke).toHaveBeenCalledWith('remove_delivered_notifications', {
      identifiers: ['room:team@conf.example.com'],
    })
  })

  it('Windows/Linux Tauri: no-op (no native command, no throw)', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(true)
    await expect(dismissNotification('conversation', 'alice@example.com')).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('Web: closes service-worker notifications matching the conversation tag', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(false)
    const close = vi.fn()
    const getNotifications = vi.fn().mockResolvedValue([{ close }, { close }])
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ getNotifications }) },
    })
    await dismissNotification('conversation', 'alice@example.com')
    expect(getNotifications).toHaveBeenCalledWith({ tag: 'alice@example.com' })
    expect(close).toHaveBeenCalledTimes(2)
    delete (navigator as unknown as Record<string, unknown>).serviceWorker
  })

  it('Web: uses the room- tag for rooms', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(false)
    const close = vi.fn()
    const getNotifications = vi.fn().mockResolvedValue([{ close }])
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ getNotifications }) },
    })
    await dismissNotification('room', 'team@conf.example.com')
    expect(getNotifications).toHaveBeenCalledWith({ tag: 'room-team@conf.example.com' })
    delete (navigator as unknown as Record<string, unknown>).serviceWorker
  })

  it('swallows errors from the platform call', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    setTauri(true)
    invoke.mockRejectedValueOnce(new Error('boom'))
    await expect(dismissNotification('conversation', 'alice@example.com')).resolves.toBeUndefined()
  })
})
