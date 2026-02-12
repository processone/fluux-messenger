/**
 * XMPPClient HTTP Upload Tests
 *
 * Tests for XEP-0363 HTTP File Upload: service discovery via disco#items/info,
 * upload slot requests, and error handling.
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

describe('XMPPClient HTTP Upload', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  // Helper to wait for async operations
  const waitForAsyncOps = async () => {
    const flushOnce = () => new Promise(resolve => process.nextTick(resolve))
    for (let i = 0; i < 5; i++) {
      await flushOnce()
      await vi.advanceTimersByTimeAsync(10)
    }
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

  describe('discoverHttpUploadService', () => {
    it('should discover HTTP Upload service from server items', async () => {
      // Mock server disco#info (no upload feature on server itself)
      const serverInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/disco#info' } },
          ],
        },
      ])

      // Mock disco#items response with upload service
      const itemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [
            { name: 'item', attrs: { jid: 'conference.example.com' } },
            { name: 'item', attrs: { jid: 'upload.example.com' } },
            { name: 'item', attrs: { jid: 'pubsub.example.com' } },
          ],
        },
      ])

      // Mock disco#info responses - only upload service has HTTP Upload feature
      const conferenceInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
          ],
        },
      ])

      const uploadInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'store', type: 'file', name: 'HTTP File Upload' } },
            { name: 'feature', attrs: { var: 'urn:xmpp:http:upload:0' } },
          ],
        },
      ])

      // Set up mock to return different responses based on the IQ target
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const to = iq.attrs?.to
        const xmlns = iq.children?.[0]?.attrs?.xmlns
        // Server disco#info (first check for upload on server itself)
        if (to === 'example.com' && xmlns === 'http://jabber.org/protocol/disco#info') {
          return serverInfoResponse
        }
        // Server disco#items (fallback to check components)
        if (to === 'example.com' && xmlns === 'http://jabber.org/protocol/disco#items') {
          return itemsResponse
        } else if (to === 'conference.example.com') {
          return conferenceInfoResponse
        } else if (to === 'upload.example.com') {
          return uploadInfoResponse
        }
        // Return default response for common IQ types (bookmarks, vcard, etc.)
        const defaultResponse = getDefaultIQResponse(iq)
        if (defaultResponse) return defaultResponse
        throw new Error('Service unavailable')
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      // Verify HTTP upload service was emitted
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:http-upload-service', {
        service: {
          jid: 'upload.example.com',
          maxFileSize: undefined,
        }
      })
    })

    it('should discover HTTP Upload service directly on server domain (Prosody http_file_share)', async () => {
      // Mock disco#info response on server domain with HTTP Upload feature
      // This is how Prosody's http_file_share module advertises the service
      const serverInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'identity', attrs: { category: 'server', type: 'im', name: 'Prosody' } },
            { name: 'feature', attrs: { var: 'urn:xmpp:http:upload:0' } },
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/disco#info' } },
            {
              name: 'x',
              attrs: { xmlns: 'jabber:x:data', type: 'result' },
              children: [
                {
                  name: 'field',
                  attrs: { var: 'FORM_TYPE', type: 'hidden' },
                  children: [{ name: 'value', text: 'urn:xmpp:http:upload:0' }],
                },
                {
                  name: 'field',
                  attrs: { var: 'max-file-size' },
                  children: [{ name: 'value', text: '104857600' }], // 100 MB
                },
              ],
            },
          ],
        },
      ])

      // disco#items should not be needed since we find upload on server itself
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const to = iq.attrs?.to
        const xmlns = iq.children?.[0]?.attrs?.xmlns
        if (to === 'example.com' && xmlns === 'http://jabber.org/protocol/disco#info') {
          return serverInfoResponse
        }
        const defaultResponse = getDefaultIQResponse(iq)
        if (defaultResponse) return defaultResponse
        throw new Error('Service unavailable')
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      // Verify HTTP upload service was discovered on server domain itself
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:http-upload-service', {
        service: {
          jid: 'example.com',
          maxFileSize: 104857600,
        }
      })
    })

    it('should extract max-file-size from disco#info x-data form', async () => {
      // Server disco#info without upload feature
      const serverInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/disco#info' } },
          ],
        },
      ])

      const itemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [
            { name: 'item', attrs: { jid: 'upload.example.com' } },
          ],
        },
      ])

      // disco#info with max-file-size in x-data form (XEP-0363 extension)
      const uploadInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'urn:xmpp:http:upload:0' } },
            {
              name: 'x',
              attrs: { xmlns: 'jabber:x:data', type: 'result' },
              children: [
                {
                  name: 'field',
                  attrs: { var: 'FORM_TYPE', type: 'hidden' },
                  children: [{ name: 'value', text: 'urn:xmpp:http:upload:0' }],
                },
                {
                  name: 'field',
                  attrs: { var: 'max-file-size' },
                  children: [{ name: 'value', text: '52428800' }], // 50 MB
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const to = iq.attrs?.to
        const xmlns = iq.children?.[0]?.attrs?.xmlns
        if (to === 'example.com' && xmlns === 'http://jabber.org/protocol/disco#info') {
          return serverInfoResponse
        }
        if (to === 'example.com' && xmlns === 'http://jabber.org/protocol/disco#items') {
          return itemsResponse
        }
        if (to === 'upload.example.com') return uploadInfoResponse
        const defaultResponse = getDefaultIQResponse(iq)
        if (defaultResponse) return defaultResponse
        throw new Error('Service unavailable')
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      expect(emitSDKSpy).toHaveBeenCalledWith('connection:http-upload-service', {
        service: {
          jid: 'upload.example.com',
          maxFileSize: 52428800,
        }
      })
    })

    it('should handle server with no HTTP Upload service', async () => {
      // Server disco#info without upload feature
      const serverInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/disco#info' } },
          ],
        },
      ])

      const itemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [
            { name: 'item', attrs: { jid: 'conference.example.com' } },
            { name: 'item', attrs: { jid: 'pubsub.example.com' } },
          ],
        },
      ])

      const genericInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const to = iq.attrs?.to
        const xmlns = iq.children?.[0]?.attrs?.xmlns
        // Server disco#info (first check for upload on server itself)
        if (to === 'example.com' && xmlns === 'http://jabber.org/protocol/disco#info') {
          return serverInfoResponse
        }
        // Server disco#items (fallback to check components)
        if (to === 'example.com' && xmlns === 'http://jabber.org/protocol/disco#items') {
          return itemsResponse
        }
        return genericInfoResponse
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      // connection:http-upload-service should be emitted with null (no service found)
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:http-upload-service', { service: null })
    })

    it('should handle disco#items query failure gracefully', async () => {
      // Suppress expected warning logs
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.spyOn(console, 'error').mockImplementation(() => {})

      // Fail disco requests but allow other common IQ types
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const xmlns = iq.children?.[0]?.attrs?.xmlns
        if (xmlns === 'http://jabber.org/protocol/disco#info' || xmlns === 'http://jabber.org/protocol/disco#items') {
          throw new Error('Service unavailable')
        }
        const defaultResponse = getDefaultIQResponse(iq)
        if (defaultResponse) return defaultResponse
        throw new Error('Service unavailable')
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      // Should not crash and should emit service as null
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:http-upload-service', { service: null })
    })

    it('should continue checking items if one fails disco#info query', async () => {
      // Silence expected console output from MUC discovery failure
      vi.spyOn(console, 'error').mockImplementation(() => {})

      const itemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [
            { name: 'item', attrs: { jid: 'broken.example.com' } },
            { name: 'item', attrs: { jid: 'upload.example.com' } },
          ],
        },
      ])

      const uploadInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'urn:xmpp:http:upload:0' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const to = iq.attrs?.to
        if (to === 'example.com') return itemsResponse
        if (to === 'broken.example.com') throw new Error('Service unavailable')
        if (to === 'upload.example.com') return uploadInfoResponse
        const defaultResponse = getDefaultIQResponse(iq)
        if (defaultResponse) return defaultResponse
        throw new Error('Not found')
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      // Should still find upload service despite broken.example.com failure
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:http-upload-service', {
        service: {
          jid: 'upload.example.com',
          maxFileSize: undefined,
        }
      })
    })

    it('should handle empty disco#items response', async () => {
      const emptyItemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyItemsResponse)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      // Should be emitted with null when no items to check
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:http-upload-service', { service: null })
    })

    it('should log discovery success', async () => {
      const itemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [
            { name: 'item', attrs: { jid: 'upload.example.com' } },
          ],
        },
      ])

      const uploadInfoResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
          children: [
            { name: 'feature', attrs: { var: 'urn:xmpp:http:upload:0' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const to = iq.attrs?.to
        if (to === 'example.com') return itemsResponse
        if (to === 'upload.example.com') return uploadInfoResponse
        const defaultResponse = getDefaultIQResponse(iq)
        if (defaultResponse) return defaultResponse
        throw new Error('Not found')
      })

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()

      expect(emitSDKSpy).toHaveBeenCalledWith('console:event', {
        message: expect.stringContaining('HTTP Upload service discovered'),
        category: 'connection'
      })
    })
  })

  describe('requestUploadSlot', () => {
    beforeEach(async () => {
      // Set up a connected client with upload service available
      mockStores.connection.getHttpUploadService = vi.fn().mockReturnValue({
        jid: 'upload.example.com',
        maxFileSize: 52428800, // 50 MB
      })

      // Mock successful items discovery
      const itemsResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'query',
          attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
          children: [],
        },
      ])
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(itemsResponse)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsyncOps()
      vi.clearAllMocks()
    })

    it('should request upload slot and parse response', async () => {
      const slotResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'slot',
          attrs: { xmlns: 'urn:xmpp:http:upload:0' },
          children: [
            { name: 'put', attrs: { url: 'https://upload.example.com/put/abc123' } },
            { name: 'get', attrs: { url: 'https://upload.example.com/get/abc123' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(slotResponse)

      const slot = await xmppClient.discovery.requestUploadSlot('test.jpg', 1024, 'image/jpeg')

      expect(slot).toEqual({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/get/abc123',
        headers: undefined,
      })
    })

    it('should extract headers from PUT element', async () => {
      const slotResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'slot',
          attrs: { xmlns: 'urn:xmpp:http:upload:0' },
          children: [
            {
              name: 'put',
              attrs: { url: 'https://upload.example.com/put/abc123' },
              children: [
                { name: 'header', attrs: { name: 'Authorization' }, text: 'Bearer token123' },
                { name: 'header', attrs: { name: 'X-Custom' }, text: 'custom-value' },
              ],
            },
            { name: 'get', attrs: { url: 'https://upload.example.com/get/abc123' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(slotResponse)

      const slot = await xmppClient.discovery.requestUploadSlot('test.jpg', 1024, 'image/jpeg')

      expect(slot.headers).toEqual({
        'Authorization': 'Bearer token123',
        'X-Custom': 'custom-value',
      })
    })

    it('should send correct IQ request format', async () => {
      const slotResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'slot',
          attrs: { xmlns: 'urn:xmpp:http:upload:0' },
          children: [
            { name: 'put', attrs: { url: 'https://upload.example.com/put/abc123' } },
            { name: 'get', attrs: { url: 'https://upload.example.com/get/abc123' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(slotResponse)

      await xmppClient.discovery.requestUploadSlot('document.pdf', 5242880, 'application/pdf')

      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'iq',
          attrs: expect.objectContaining({
            type: 'get',
            to: 'upload.example.com',
          }),
          children: expect.arrayContaining([
            expect.objectContaining({
              name: 'request',
              attrs: expect.objectContaining({
                xmlns: 'urn:xmpp:http:upload:0',
                filename: 'document.pdf',
                size: '5242880',
                'content-type': 'application/pdf',
              }),
            }),
          ]),
        })
      )
    })

    it('should throw error when file exceeds max size', async () => {
      await expect(
        xmppClient.discovery.requestUploadSlot('huge.zip', 100000000, 'application/zip') // 100MB
      ).rejects.toThrow('File too large')
    })

    it('should throw error when upload service not available', async () => {
      mockStores.connection.getHttpUploadService = vi.fn().mockReturnValue(null)

      await expect(
        xmppClient.discovery.requestUploadSlot('test.jpg', 1024, 'image/jpeg')
      ).rejects.toThrow('HTTP Upload service not available')
    })

    it('should throw error when not connected', async () => {
      await xmppClient.disconnect()

      await expect(
        xmppClient.discovery.requestUploadSlot('test.jpg', 1024, 'image/jpeg')
      ).rejects.toThrow('Not connected')
    })

    it('should throw error when slot response is invalid (missing URLs)', async () => {
      const invalidSlotResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'slot',
          attrs: { xmlns: 'urn:xmpp:http:upload:0' },
          children: [
            { name: 'put', attrs: {} }, // Missing URL
            { name: 'get', attrs: { url: 'https://upload.example.com/get/abc123' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(invalidSlotResponse)

      await expect(
        xmppClient.discovery.requestUploadSlot('test.jpg', 1024, 'image/jpeg')
      ).rejects.toThrow('Invalid upload slot response')
    })

    it('should propagate server errors', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(new Error('quota-exceeded'))

      // Error instances are re-thrown directly
      await expect(
        xmppClient.discovery.requestUploadSlot('test.jpg', 1024, 'image/jpeg')
      ).rejects.toThrow('quota-exceeded')
    })

    it('should work without max file size limit', async () => {
      mockStores.connection.getHttpUploadService = vi.fn().mockReturnValue({
        jid: 'upload.example.com',
        maxFileSize: undefined, // No limit
      })

      const slotResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'slot',
          attrs: { xmlns: 'urn:xmpp:http:upload:0' },
          children: [
            { name: 'put', attrs: { url: 'https://upload.example.com/put/abc123' } },
            { name: 'get', attrs: { url: 'https://upload.example.com/get/abc123' } },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(slotResponse)

      // Should not throw even for large files when no limit is set
      const slot = await xmppClient.discovery.requestUploadSlot('huge.zip', 500000000, 'application/zip')
      expect(slot.putUrl).toBeDefined()
    })
  })
})
