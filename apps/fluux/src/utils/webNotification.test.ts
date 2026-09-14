import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { showWebNotification } from './webNotification'

class MockNotification {
  static instances: MockNotification[] = []
  close = vi.fn()
  onclick: (() => void) | null = null

  constructor(
    public title: string,
    public options?: NotificationOptions,
  ) {
    MockNotification.instances.push(this)
  }
}

const originalServiceWorker = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker')
const originalNotification = globalThis.Notification

function setServiceWorker(value: Partial<ServiceWorkerContainer> | undefined): void {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value,
  })
}

describe('showWebNotification', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockNotification.instances = []
    globalThis.Notification = MockNotification as unknown as typeof Notification
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.Notification = originalNotification
    if (originalServiceWorker) {
      Object.defineProperty(navigator, 'serviceWorker', originalServiceWorker)
    } else {
      Reflect.deleteProperty(navigator, 'serviceWorker')
    }
  })

  it('uses the service worker path when one is available', async () => {
    const showNotification = vi.fn().mockResolvedValue(undefined)
    setServiceWorker({
      ready: Promise.resolve({ showNotification } as unknown as ServiceWorkerRegistration),
    })

    await showWebNotification(
      'New message',
      { body: 'Hello', icon: '/icon.png', tag: 'conversation-alice' },
      { from: 'alice@example.com', type: 'conversation', count: 2 },
    )

    expect(showNotification).toHaveBeenCalledWith('New message', {
      body: 'Hello',
      icon: '/icon.png',
      tag: 'conversation-alice',
      data: { from: 'alice@example.com', type: 'conversation', count: 2 },
    })
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('falls back to the Notification constructor without a service worker', async () => {
    setServiceWorker(undefined)
    const onClick = vi.fn()

    await showWebNotification('New message', { body: 'Hello', onClick })

    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].options).toEqual({ body: 'Hello' })

    MockNotification.instances[0].onclick?.()
    expect(onClick).toHaveBeenCalledOnce()
    expect(MockNotification.instances[0].close).toHaveBeenCalledOnce()
  })

  it('does not leak the mobile Illegal constructor error', async () => {
    setServiceWorker(undefined)
    globalThis.Notification = class {
      constructor() {
        throw new TypeError('Illegal constructor')
      }
    } as unknown as typeof Notification

    await expect(showWebNotification('New message', { body: 'Hello' })).resolves.toBeUndefined()
  })
})
