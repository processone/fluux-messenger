import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { showWebNotification } from './webNotification'

const NotificationCtor = vi.fn()

function setServiceWorker(container: unknown) {
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container })
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('showWebNotification', () => {
  beforeEach(() => {
    NotificationCtor.mockReset()
    NotificationCtor.mockImplementation(function () { return { close: vi.fn() } })
    vi.stubGlobal('Notification', NotificationCtor)
  })
  afterEach(() => {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker
    vi.unstubAllGlobals()
  })

  it('shows through the service worker registration when one is registered', async () => {
    const registration = { showNotification: vi.fn().mockResolvedValue(undefined) }
    setServiceWorker({
      getRegistration: vi.fn().mockResolvedValue(registration),
      ready: Promise.resolve(registration),
    })
    await showWebNotification('Title', { body: 'Body', tag: 't' }, { from: 'a@example.com', type: 'conversation' })
    expect(registration.showNotification).toHaveBeenCalledWith('Title', {
      body: 'Body', tag: 't', data: { from: 'a@example.com', type: 'conversation' },
    })
    expect(NotificationCtor).not.toHaveBeenCalled()
  })

  it('falls back to the constructor when the browser supports service workers but none is registered', async () => {
    // `ready` never settles without a registration.
    setServiceWorker({ getRegistration: vi.fn().mockResolvedValue(undefined), ready: new Promise(() => {}) })
    void showWebNotification('Title', { body: 'Body', tag: 't' })
    await flush()
    expect(NotificationCtor).toHaveBeenCalledWith('Title', { body: 'Body', tag: 't' })
  })

  it('falls back to the constructor when the service worker rejects', async () => {
    const registration = { showNotification: vi.fn().mockRejectedValue(new TypeError('no active worker')) }
    setServiceWorker({ getRegistration: vi.fn().mockResolvedValue(registration), ready: Promise.resolve(registration) })
    await showWebNotification('Title', { body: 'Body' })
    expect(NotificationCtor).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the browser rejects the constructor', async () => {
    NotificationCtor.mockImplementation(function () {
      throw new TypeError("Failed to construct 'Notification': Illegal constructor.")
    })
    await expect(showWebNotification('Title', { body: 'Body' })).resolves.toBeUndefined()
  })
})
