import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { isMobileTauri, invoke } = vi.hoisted(() => ({
  isMobileTauri: vi.fn().mockResolvedValue(false),
  invoke: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/utils/tauriPlatform', () => ({ isMobileTauri }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@fluux/sdk', () => ({
  connectionStore: { getState: () => ({ jid: 'me@example.com/resource' }) },
  getBareJid: (jid: string) => jid.split('/')[0],
}))

import { dismissNotification } from './dismissNotification'

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

describe('dismissNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isMobileTauri.mockResolvedValue(false)
  })
  afterEach(() => setTauri(false))

  it('desktop: invokes the native command with the scoped conversation', async () => {
    setTauri(true)
    await dismissNotification('conversation', 'alice@example.com')
    expect(invoke).toHaveBeenCalledWith('dismiss_notifications', {
      navType: 'conversation',
      navTarget: 'alice@example.com',
      accountId: 'me@example.com',
    })
  })

  it('desktop: scopes room dismissal to the current account', async () => {
    setTauri(true)
    await dismissNotification('room', 'team@conf.example.com')
    expect(invoke).toHaveBeenCalledWith('dismiss_notifications', {
      navType: 'room',
      navTarget: 'team@conf.example.com',
      accountId: 'me@example.com',
    })
  })

  it('mobile Tauri: remains a no-op', async () => {
    isMobileTauri.mockResolvedValue(true)
    setTauri(true)
    await expect(dismissNotification('conversation', 'alice@example.com')).resolves.toBeUndefined()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('Web: closes service-worker notifications matching the conversation tag', async () => {
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
    setTauri(true)
    invoke.mockRejectedValueOnce(new Error('boom'))
    await expect(dismissNotification('conversation', 'alice@example.com')).resolves.toBeUndefined()
  })
})
