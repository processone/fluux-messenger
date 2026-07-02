import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { isMacOSDesktop, invoke, active, removeActive } = vi.hoisted(() => ({
  isMacOSDesktop: vi.fn(),
  invoke: vi.fn().mockResolvedValue(undefined),
  active: vi.fn().mockResolvedValue([]),
  removeActive: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/utils/tauriPlatform', () => ({ isMacOSDesktop }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-notification', () => ({ active, removeActive }))

import { dismissNotification } from './dismissNotification'

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

describe('dismissNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    active.mockResolvedValue([])
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

  it('Windows/Linux Tauri: removes plugin notifications matching the tag', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(true)
    const match = { id: 1, tag: 'alice@example.com' }
    active.mockResolvedValue([match, { id: 2, tag: 'room-other@conf' }])
    await dismissNotification('conversation', 'alice@example.com')
    expect(invoke).not.toHaveBeenCalled()
    expect(removeActive).toHaveBeenCalledWith([match])
  })

  it('Windows/Linux Tauri: maps rooms to the room-<jid> tag', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(true)
    const match = { id: 3, tag: 'room-team@conf.example.com' }
    active.mockResolvedValue([match, { id: 4, tag: 'alice@example.com' }])
    await dismissNotification('room', 'team@conf.example.com')
    expect(removeActive).toHaveBeenCalledWith([match])
  })

  it('Windows/Linux Tauri: no-op when no notification matches the tag', async () => {
    isMacOSDesktop.mockResolvedValue(false)
    setTauri(true)
    active.mockResolvedValue([{ id: 9, tag: 'bob@example.com' }])
    await dismissNotification('conversation', 'alice@example.com')
    expect(removeActive).not.toHaveBeenCalled()
  })

  it('Web: closes service-worker notifications matching the tag', async () => {
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

  it('swallows errors from the platform call', async () => {
    isMacOSDesktop.mockResolvedValue(true)
    setTauri(true)
    invoke.mockRejectedValueOnce(new Error('boom'))
    await expect(dismissNotification('conversation', 'alice@example.com')).resolves.toBeUndefined()
  })
})
