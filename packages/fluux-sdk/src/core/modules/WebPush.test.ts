/**
 * WebPush Module Tests
 *
 * Tests for p1:push web push notification protocol:
 * - VAPID service discovery
 * - Push subscription registration
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  getDefaultIQResponse,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

let mockXmppClientInstance: MockXmppClient

// Mock @xmpp/client module
vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))

// Mock @xmpp/debug
vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

// Import after mocking
import { client as xmppClientFactory } from '@xmpp/client'

describe('WebPush Module', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  // Helper to connect the client for testing
  const connectClient = async () => {
    // Default mock: return empty responses for all IQ requests
    mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
      const defaultResponse = getDefaultIQResponse(iq)
      if (defaultResponse) return defaultResponse
      return createMockElement('iq', { type: 'result' })
    })

    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'password',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    vi.clearAllMocks()
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  }


  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    vi.mocked(xmppClientFactory).mockReturnValue(mockXmppClientInstance as any)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('queryServices', () => {
    it('should send correct IQ and parse services response', async () => {
      await connectClient()

      const servicesResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'services',
          attrs: { xmlns: 'p1:push:webpush' },
          children: [
            { name: 'service', attrs: { vapid: 'BLGqpNUtQ0750nR69uYAX3vhV6fl1-gTMROiWiSTaDPh', appid: 'fluux.io' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(servicesResponse)

      const services = await xmppClient.webPush.queryServices()

      expect(services).toHaveLength(1)
      expect(services[0]).toEqual({
        vapidKey: 'BLGqpNUtQ0750nR69uYAX3vhV6fl1-gTMROiWiSTaDPh',
        appId: 'fluux.io',
      })
    })

    it('should parse multiple services', async () => {
      await connectClient()

      const servicesResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'services',
          attrs: { xmlns: 'p1:push:webpush' },
          children: [
            { name: 'service', attrs: { vapid: 'KEY_1', appid: 'app1' } },
            { name: 'service', attrs: { vapid: 'KEY_2', appid: 'app2' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(servicesResponse)

      const services = await xmppClient.webPush.queryServices()

      expect(services).toHaveLength(2)
      expect(services[0].appId).toBe('app1')
      expect(services[1].appId).toBe('app2')
    })

    it('should emit connection:webpush-services SDK event', async () => {
      await connectClient()

      const servicesResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'services',
          attrs: { xmlns: 'p1:push:webpush' },
          children: [
            { name: 'service', attrs: { vapid: 'VAPID_KEY', appid: 'test' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(servicesResponse)

      await xmppClient.webPush.queryServices()

      expect(emitSDKSpy).toHaveBeenCalledWith('connection:webpush-services', {
        services: [{ vapidKey: 'VAPID_KEY', appId: 'test' }],
      })
    })

    it('should return empty array when no services element', async () => {
      await connectClient()

      const emptyResponse = createMockElement('iq', { type: 'result' })
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResponse)

      const services = await xmppClient.webPush.queryServices()

      expect(services).toEqual([])
    })

    it('should filter out services with missing vapid or appid', async () => {
      await connectClient()

      const servicesResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'services',
          attrs: { xmlns: 'p1:push:webpush' },
          children: [
            { name: 'service', attrs: { vapid: 'KEY_1', appid: 'valid' } },
            { name: 'service', attrs: { vapid: '', appid: 'no-vapid' } },
            { name: 'service', attrs: { vapid: 'KEY_3' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(servicesResponse)

      const services = await xmppClient.webPush.queryServices()

      expect(services).toHaveLength(1)
      expect(services[0].appId).toBe('valid')
    })

    it('should handle IQ error gracefully', async () => {
      await connectClient()

      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('Service unavailable'))

      const services = await xmppClient.webPush.queryServices()

      expect(services).toEqual([])
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:webpush-services', { services: [] })
    })

    it('should return empty array when not connected', async () => {
      // Don't connect - JID is null
      const services = await xmppClient.webPush.queryServices()
      expect(services).toEqual([])
    })

    it('should log console event on success', async () => {
      await connectClient()

      const servicesResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'services',
          attrs: { xmlns: 'p1:push:webpush' },
          children: [
            { name: 'service', attrs: { vapid: 'KEY', appid: 'app' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(servicesResponse)

      await xmppClient.webPush.queryServices()

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: expect.stringContaining('1 VAPID service(s) available'),
        category: 'connection',
      })
    })
  })

  describe('registerSubscription', () => {
    it('should send correct registration IQ with endpoint#p256dh#auth format', async () => {
      await connectClient()

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.webPush.registerSubscription(
        'https://fcm.googleapis.com/fcm/send/abc123',
        'p256dh_key_value',
        'auth_secret_value',
        'fluux.io'
      )

      // Verify IQ was sent
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(1)

      const sentIQ = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      expect(sentIQ.attrs.type).toBe('set')

      // Check push element
      const pushEl = sentIQ.children[0]
      expect(pushEl.name).toBe('push')
      expect(pushEl.attrs.xmlns).toBe('p1:push')

      // Check body element
      const bodyEl = pushEl.children.find((c: any) => c.name === 'body')
      expect(bodyEl.attrs.send).toBe('all')
      expect(bodyEl.attrs.groupchat).toBe('true')
      expect(bodyEl.attrs.from).toBe('name')

      // Check offline element
      const offlineEl = pushEl.children.find((c: any) => c.name === 'offline')
      expect(offlineEl).toBeDefined()

      // Check notification element
      const notificationEl = pushEl.children.find((c: any) => c.name === 'notification')
      expect(notificationEl).toBeDefined()

      const typeEl = notificationEl.children.find((c: any) => c.name === 'type')
      expect(typeEl).toBeDefined()

      const idEl = notificationEl.children.find((c: any) => c.name === 'id')
      expect(idEl).toBeDefined()

      // Check appid element
      const appidEl = pushEl.children.find((c: any) => c.name === 'appid')
      expect(appidEl).toBeDefined()
    })

    it('should emit connection:webpush-status as registered on success', async () => {
      await connectClient()

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.webPush.registerSubscription(
        'https://fcm.googleapis.com/fcm/send/abc123',
        'p256dh_key',
        'auth_key',
        'fluux.io'
      )

      expect(emitSDKSpy).toHaveBeenCalledWith('connection:webpush-status', {
        status: 'registered',
      })
    })

    it('should log console event on successful registration', async () => {
      await connectClient()

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.webPush.registerSubscription(
        'https://fcm.googleapis.com/fcm/send/abc123',
        'p256dh_key',
        'auth_key',
        'fluux.io'
      )

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: 'Web Push subscription registered',
        category: 'connection',
      })
    })

    it('should throw on IQ error', async () => {
      await connectClient()

      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('Forbidden'))

      await expect(
        xmppClient.webPush.registerSubscription(
          'https://fcm.googleapis.com/fcm/send/abc123',
          'p256dh_key',
          'auth_key',
          'fluux.io'
        )
      ).rejects.toThrow('Forbidden')
    })

    it('should throw when not connected', async () => {
      // Don't connect
      await expect(
        xmppClient.webPush.registerSubscription(
          'https://fcm.googleapis.com/fcm/send/abc123',
          'p256dh_key',
          'auth_key',
          'fluux.io'
        )
      ).rejects.toThrow('Not connected')
    })
  })
})
