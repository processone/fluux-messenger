/**
 * XMPPClient Own Avatar Tests
 *
 * Tests for own avatar fetching via XEP-0084 (User Avatar):
 * - fetchOwnAvatar() - retrieve own avatar from PEP (metadata + data)
 * - Proper two-step process: fetch metadata first to get hash, then fetch data
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import type { Room, RoomOccupant } from '../types/room'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

/** Base64-encode a small byte array, for crafting avatar payloads with real magic bytes. */
const toBase64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes))

// Minimal payloads whose leading bytes identify a non-png image format.
const GIF_BASE64 = toBase64([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]) // "GIF89a"
const WEBP_BASE64 = toBase64([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
]) // "RIFF....WEBP"

let mockXmppClientInstance: MockXmppClient

// Use vi.hoisted to create the mock factory at hoist time
const { mockClientFactory, mockXmlFn } = vi.hoisted(() => {
  let clientInstance: MockXmppClient | null = null
  return {
    mockClientFactory: Object.assign(
      vi.fn(() => clientInstance),
      {
        _setInstance: (instance: MockXmppClient | null) => { clientInstance = instance },
      }
    ),
    mockXmlFn: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
      name,
      attrs: attrs || {},
      children,
      toString: () => `<${name}/>`,
    })),
  }
})

// Mock @xmpp/client module
vi.mock('@xmpp/client', () => ({
  client: mockClientFactory,
  xml: mockXmlFn,
}))

// Mock @xmpp/debug
vi.mock('@xmpp/debug', () => ({
  default: vi.fn(),
}))

// Mock avatar cache
vi.mock('../../utils/avatarCache', () => ({
  getCachedAvatar: vi.fn().mockResolvedValue(null),
  cacheAvatar: vi.fn().mockResolvedValue('blob:cached-url'),
  saveAvatarHash: vi.fn().mockResolvedValue(undefined),
  getAvatarHash: vi.fn().mockResolvedValue(null),
  getAllAvatarHashes: vi.fn().mockResolvedValue([]),
  tryGetAllAvatarHashes: vi.fn().mockResolvedValue([]),
  saveRoomOccupantAvatarHash: vi.fn().mockResolvedValue(undefined),
  getRoomOccupantAvatarHashes: vi.fn().mockResolvedValue([]),
  seedRoomOccupantAvatarHashes: vi.fn().mockResolvedValue(new Map()),
  refreshAllBlobUrls: vi.fn().mockResolvedValue(new Map()),
  // Negative cache functions
  hasNoAvatar: vi.fn().mockResolvedValue(false),
  markNoAvatar: vi.fn().mockResolvedValue(undefined),
  clearNoAvatar: vi.fn().mockResolvedValue(undefined),
  // PEP-forbidden domain cache functions
  isPepForbiddenDomain: vi.fn().mockReturnValue(false),
  markPepForbiddenDomain: vi.fn().mockResolvedValue(undefined),
  loadPepForbiddenDomains: vi.fn().mockResolvedValue(undefined),
}))

describe('XMPPClient Own Avatar', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('fetchOwnAvatar', () => {
    beforeEach(async () => {
      // Connect the client first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should first fetch metadata to get hash, then fetch data', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock metadata response
      const metadataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'abc123hash' },
                  children: [
                    {
                      name: 'metadata',
                      attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                      children: [
                        {
                          name: 'info',
                          attrs: { id: 'abc123hash', type: 'image/png', bytes: '1024' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      // Mock data response
      const dataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:data' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'abc123hash' },
                  children: [
                    {
                      name: 'data',
                      attrs: { xmlns: 'urn:xmpp:avatar:data' },
                      text: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request
        .mockResolvedValueOnce(metadataResponse)
        .mockResolvedValueOnce(dataResponse)

      await xmppClient.profile.fetchOwnAvatar()

      // Should have made 2 IQ requests: metadata then data
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(2)

      // First call should query metadata node
      const firstCall = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      expect(firstCall.attrs.type).toBe('get')
      const firstPubsub = firstCall.children.find((c: { name: string }) => c.name === 'pubsub')
      const firstItems = firstPubsub?.children?.find((c: { name: string }) => c.name === 'items')
      expect(firstItems?.attrs?.node).toBe('urn:xmpp:avatar:metadata')

      // Second call should query data node with the hash from metadata
      const secondCall = mockXmppClientInstance.iqCaller.request.mock.calls[1][0]
      expect(secondCall.attrs.type).toBe('get')
      const secondPubsub = secondCall.children.find((c: { name: string }) => c.name === 'pubsub')
      const secondItems = secondPubsub?.children?.find((c: { name: string }) => c.name === 'items')
      expect(secondItems?.attrs?.node).toBe('urn:xmpp:avatar:data')
      const item = secondItems?.children?.find((c: { name: string }) => c.name === 'item')
      expect(item?.attrs?.id).toBe('abc123hash')

      // Should update store with cached URL
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-avatar', { avatar: 'blob:cached-url', hash: 'abc123hash' })
    })

    it('should not fetch data if metadata has no avatar (empty)', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock empty metadata response (no avatar set)
      const emptyMetadataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  children: [
                    {
                      name: 'metadata',
                      attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                      // No info child means no avatar
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyMetadataResponse)

      await xmppClient.profile.fetchOwnAvatar()

      // Should only make 1 request (metadata), not follow up with data request
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(1)
      expect(emitSDKSpy).not.toHaveBeenCalledWith('connection:own-avatar', expect.anything())
    })

    it('should handle metadata fetch error gracefully', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()

      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('item-not-found')
      )

      // Should not throw
      await expect(xmppClient.profile.fetchOwnAvatar()).resolves.not.toThrow()

      // Should not update store
      expect(emitSDKSpy).not.toHaveBeenCalledWith('connection:own-avatar', expect.anything())
    })

    it('should use cached avatar if available', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock cache hit
      const { getCachedAvatar } = await import('../../utils/avatarCache')
      vi.mocked(getCachedAvatar).mockResolvedValueOnce('blob:cached-existing')

      // Mock metadata response
      const metadataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'abc123hash' },
                  children: [
                    {
                      name: 'metadata',
                      attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                      children: [
                        {
                          name: 'info',
                          attrs: { id: 'abc123hash', type: 'image/png', bytes: '1024' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(metadataResponse)

      await xmppClient.profile.fetchOwnAvatar()

      // Should only make 1 request (metadata), skip data fetch because of cache
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(1)
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-avatar', { avatar: 'blob:cached-existing', hash: 'abc123hash' })
    })

    it('caches the own avatar with its sniffed type, overriding a mislabeled <info type>', async () => {
      mockXmppClientInstance.iqCaller.request.mockClear()

      const { getCachedAvatar, cacheAvatar } = await import('../../utils/avatarCache')
      vi.mocked(getCachedAvatar).mockResolvedValue(null)
      vi.mocked(cacheAvatar).mockResolvedValue('blob:own-gif')

      // Metadata advertises image/png...
      const metadataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'own-hash' },
                  children: [
                    {
                      name: 'metadata',
                      attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                      children: [
                        { name: 'info', attrs: { id: 'own-hash', type: 'image/png', bytes: '128' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])
      // ...but the actual bytes are a GIF.
      const dataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:data' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'own-hash' },
                  children: [
                    { name: 'data', attrs: { xmlns: 'urn:xmpp:avatar:data' }, text: GIF_BASE64 },
                  ],
                },
              ],
            },
          ],
        },
      ])
      mockXmppClientInstance.iqCaller.request
        .mockResolvedValueOnce(metadataResponse)
        .mockResolvedValueOnce(dataResponse)

      await xmppClient.profile.fetchOwnAvatar()

      // The advertised image/png is only a fallback; the GIF bytes win.
      expect(cacheAvatar).toHaveBeenCalledWith('own-hash', GIF_BASE64, 'image/gif')
    })
  })

  describe('fetchContactAvatarMetadata', () => {
    beforeEach(async () => {
      // Connect the client first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should fetch contact avatar metadata from XEP-0084 PEP', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock metadata response
      const metadataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'contact-avatar-hash' },
                  children: [
                    {
                      name: 'metadata',
                      attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                      children: [
                        {
                          name: 'info',
                          attrs: { id: 'contact-avatar-hash', type: 'image/png', bytes: '2048' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      // Mock the follow-up avatar data fetch (triggered by avatarMetadataUpdate event)
      mockXmppClientInstance.iqCaller.request
        .mockResolvedValueOnce(metadataResponse) // First: metadata query
        .mockRejectedValue(new Error('not found')) // Subsequent: data fetch fails (ok for test)

      const result = await xmppClient.profile.fetchContactAvatarMetadata('contact@example.com')

      // Should return the hash
      expect(result).toBe('contact-avatar-hash')

      // First call should be the metadata query to contact's JID
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()
      const call = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      expect(call.attrs.to).toBe('contact@example.com')
      expect(call.attrs.type).toBe('get')
    })

    it('should fallback to vCard when contact has no XEP-0084 avatar', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock empty metadata response (no XEP-0084 avatar)
      const emptyMetadataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  children: [
                    {
                      name: 'metadata',
                      attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                      // No info child means no avatar
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      // Mock vCard response with avatar
      const vcardResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'vCard',
          attrs: { xmlns: 'vcard-temp' },
          children: [
            {
              name: 'PHOTO',
              children: [
                { name: 'TYPE', text: 'image/jpeg' },
                { name: 'BINVAL', text: 'base64avatardata' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request
        .mockResolvedValueOnce(emptyMetadataResponse) // First: XEP-0084 metadata
        .mockResolvedValueOnce(vcardResponse) // Second: vCard fallback

      const result = await xmppClient.profile.fetchContactAvatarMetadata('contact@example.com')

      expect(result).toBeNull() // No XEP-0084 hash returned

      // Should have made 2 requests: XEP-0084 metadata + vCard
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(2)

      // Second call should be vCard query
      const vcardCall = mockXmppClientInstance.iqCaller.request.mock.calls[1][0]
      expect(vcardCall.attrs.to).toBe('contact@example.com')
      const vcard = vcardCall.children.find((c: { name: string }) => c.name === 'vCard')
      expect(vcard?.attrs?.xmlns).toBe('vcard-temp')
    })

    it('should fallback to vCard when XEP-0084 returns error (item-not-found)', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock vCard response with avatar
      const vcardResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'vCard',
          attrs: { xmlns: 'vcard-temp' },
          children: [
            {
              name: 'PHOTO',
              children: [
                { name: 'TYPE', text: 'image/png' },
                { name: 'BINVAL', text: 'anotherbase64data' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request
        .mockRejectedValueOnce(new Error('item-not-found')) // First: XEP-0084 fails
        .mockResolvedValueOnce(vcardResponse) // Second: vCard fallback

      const result = await xmppClient.profile.fetchContactAvatarMetadata('contact@example.com')

      expect(result).toBeNull() // No XEP-0084 hash returned

      // Should have made 2 requests: XEP-0084 metadata (failed) + vCard
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(2)

      // Second call should be vCard query
      const vcardCall = mockXmppClientInstance.iqCaller.request.mock.calls[1][0]
      const vcard = vcardCall.children.find((c: { name: string }) => c.name === 'vCard')
      expect(vcard?.attrs?.xmlns).toBe('vcard-temp')
    })

    it('should NOT fetch vCard when XEP-0084 succeeds', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock successful metadata response
      const metadataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'xep0084-hash' },
                  children: [
                    {
                      name: 'metadata',
                      attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                      children: [
                        {
                          name: 'info',
                          attrs: { id: 'xep0084-hash', type: 'image/png', bytes: '1024' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      // Mock the follow-up avatar data fetch (triggered by avatarMetadataUpdate event)
      const dataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:data' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'xep0084-hash' },
                  children: [
                    {
                      name: 'data',
                      attrs: { xmlns: 'urn:xmpp:avatar:data' },
                      text: 'iVBORw0KGgo=', // base64 PNG data
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request
        .mockResolvedValueOnce(metadataResponse) // 1st: XEP-0084 metadata
        .mockResolvedValueOnce(dataResponse) // 2nd: XEP-0084 data (from avatarMetadataUpdate event)

      const result = await xmppClient.profile.fetchContactAvatarMetadata('contact@example.com')

      expect(result).toBe('xep0084-hash')

      // Wait for async operations from the event listener to complete
      await vi.runAllTimersAsync()

      // Should have made 2 requests: XEP-0084 metadata + XEP-0084 data (from event)
      // No vCard query should be made when XEP-0084 succeeds
      const calls = mockXmppClientInstance.iqCaller.request.mock.calls
      expect(calls.length).toBeGreaterThanOrEqual(1)

      // Verify no vCard query was made (vCard uses 'vcard-temp' namespace)
      const hasVcardCall = calls.some((call: any[]) => {
        const iq = call[0]
        return iq.children?.some((child: { name: string; attrs?: { xmlns?: string } }) =>
          child.name === 'vCard' && child.attrs?.xmlns === 'vcard-temp'
        )
      })
      expect(hasVcardCall).toBe(false)
    })

    it('should emit avatarMetadataUpdate event when avatar found', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock metadata response
      const metadataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:metadata' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'contact-avatar-hash' },
                  children: [
                    {
                      name: 'metadata',
                      attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                      children: [
                        {
                          name: 'info',
                          attrs: { id: 'contact-avatar-hash', type: 'image/png', bytes: '2048' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      // Mock subsequent fetchAvatarData to prevent unhandled promise
      mockXmppClientInstance.iqCaller.request
        .mockResolvedValueOnce(metadataResponse)
        .mockRejectedValue(new Error('not found'))

      // Track emitted events
      const emittedEvents: Array<{ jid: string; hash: string | null }> = []
      xmppClient.on('avatarMetadataUpdate', (jid, hash) => {
        emittedEvents.push({ jid, hash })
      })

      await xmppClient.profile.fetchContactAvatarMetadata('contact@example.com')

      // Should emit event with the hash
      expect(emittedEvents).toContainEqual({
        jid: 'contact@example.com',
        hash: 'contact-avatar-hash',
      })
    })
  })

  describe('fetchRoomAvatar', () => {
    beforeEach(async () => {
      // Connect the client first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should fetch room avatar via vCard and cache it', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()
      emitSDKSpy.mockClear()

      const { cacheAvatar, saveAvatarHash } = await import('../../utils/avatarCache')
      vi.mocked(cacheAvatar).mockResolvedValue('blob:room-avatar-cached')

      // Mock vCard response with avatar
      const vcardResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'vCard',
          attrs: { xmlns: 'vcard-temp' },
          children: [
            {
              name: 'PHOTO',
              children: [
                { name: 'TYPE', text: 'image/jpeg' },
                { name: 'BINVAL', text: 'base64roomavatardata' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(vcardResponse)

      await xmppClient.profile.fetchRoomAvatar('room@conference.example.com', 'known-hash-123')

      // Should cache the avatar
      expect(cacheAvatar).toHaveBeenCalledWith('known-hash-123', 'base64roomavatardata', 'image/jpeg')

      // Should save the hash mapping
      expect(saveAvatarHash).toHaveBeenCalledWith('room@conference.example.com', 'known-hash-123', 'room')

      // Should emit room:updated with avatar
      expect(emitSDKSpy).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.com',
        updates: { avatar: 'blob:room-avatar-cached', avatarHash: 'known-hash-123' },
      })
    })

    it('should use cached avatar if available for known hash', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()
      emitSDKSpy.mockClear()

      const { getCachedAvatar } = await import('../../utils/avatarCache')
      vi.mocked(getCachedAvatar).mockResolvedValueOnce('blob:cached-room-avatar')

      await xmppClient.profile.fetchRoomAvatar('room@conference.example.com', 'cached-hash')

      // Should NOT make vCard request when cached
      expect(mockXmppClientInstance.iqCaller.request).not.toHaveBeenCalled()

      // Should emit room:updated with cached avatar
      expect(emitSDKSpy).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.com',
        updates: { avatar: 'blob:cached-room-avatar', avatarHash: 'cached-hash' },
      })
    })

    it('should generate hash if none provided from presence', async () => {
      // Clear any calls from connection setup
      mockXmppClientInstance.iqCaller.request.mockClear()
      emitSDKSpy.mockClear()

      const { cacheAvatar, saveAvatarHash } = await import('../../utils/avatarCache')
      vi.mocked(cacheAvatar).mockResolvedValue('blob:generated-hash-avatar')

      // Mock vCard response
      const vcardResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'vCard',
          attrs: { xmlns: 'vcard-temp' },
          children: [
            {
              name: 'PHOTO',
              children: [
                { name: 'BINVAL', text: 'base64data' },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(vcardResponse)

      // Call without known hash
      await xmppClient.profile.fetchRoomAvatar('room@conference.example.com')

      // Should have called cacheAvatar with a generated hash (UUID)
      expect(cacheAvatar).toHaveBeenCalledWith(
        expect.any(String), // generated hash
        'base64data',
        'image/png' // default mime type
      )

      // Should save the hash mapping
      expect(saveAvatarHash).toHaveBeenCalledWith(
        'room@conference.example.com',
        expect.any(String),
        'room'
      )
    })
  })

  describe('restoreAllRoomAvatarHashes', () => {
    beforeEach(async () => {
      // Connect the client first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should restore room avatar from cache for bookmarked rooms', async () => {
      emitSDKSpy.mockClear()

      const { getAllAvatarHashes, getCachedAvatar } = await import('../../utils/avatarCache')
      vi.mocked(getAllAvatarHashes).mockResolvedValue([
        { jid: 'room1@conference.example.com', hash: 'hash1', type: 'room' },
        { jid: 'room2@conference.example.com', hash: 'hash2', type: 'room' },
      ])
      vi.mocked(getCachedAvatar)
        .mockResolvedValueOnce('blob:room1-avatar')
        .mockResolvedValueOnce('blob:room2-avatar')

      // Mock room store to return rooms without avatars
      mockStores.room.getRoom
        .mockReturnValueOnce({ jid: 'room1@conference.example.com', name: 'Room 1', nickname: '', joined: false, isBookmarked: false, occupants: new Map(), messages: [], unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() })
        .mockReturnValueOnce({ jid: 'room2@conference.example.com', name: 'Room 2', nickname: '', joined: false, isBookmarked: false, occupants: new Map(), messages: [], unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>() })

      await xmppClient.profile.restoreAllRoomAvatarHashes()

      // Should emit room:updated for both rooms with avatars
      expect(emitSDKSpy).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room1@conference.example.com',
        updates: { avatar: 'blob:room1-avatar', avatarHash: 'hash1' },
      })
      expect(emitSDKSpy).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room2@conference.example.com',
        updates: { avatar: 'blob:room2-avatar', avatarHash: 'hash2' },
      })
    })

    it('should set only avatarHash if blob not in cache', async () => {
      emitSDKSpy.mockClear()

      const { getAllAvatarHashes, getCachedAvatar } = await import('../../utils/avatarCache')
      vi.mocked(getAllAvatarHashes).mockResolvedValue([
        { jid: 'room@conference.example.com', hash: 'hash-no-blob', type: 'room' },
      ])
      vi.mocked(getCachedAvatar).mockResolvedValue(null) // No blob in cache

      // Mock room store to return room without avatar
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.com',
        name: 'Room',
        nickname: '',
        joined: false,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
      })

      await xmppClient.profile.restoreAllRoomAvatarHashes()

      // Should emit room:updated with just the hash (no blob)
      expect(emitSDKSpy).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.com',
        updates: { avatarHash: 'hash-no-blob' },
      })
    })

    it('should skip rooms not in store', async () => {
      emitSDKSpy.mockClear()

      const { getAllAvatarHashes } = await import('../../utils/avatarCache')
      vi.mocked(getAllAvatarHashes).mockResolvedValue([
        { jid: 'unknown-room@conference.example.com', hash: 'hash', type: 'room' },
      ])

      // Mock room store to return undefined (room not in store)
      mockStores.room.getRoom.mockReturnValue(undefined)

      await xmppClient.profile.restoreAllRoomAvatarHashes()

      // Should NOT emit room:updated for unknown rooms
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:updated', expect.anything())
    })

    it('should skip rooms that already have avatarHash', async () => {
      emitSDKSpy.mockClear()

      const { getAllAvatarHashes } = await import('../../utils/avatarCache')
      vi.mocked(getAllAvatarHashes).mockResolvedValue([
        { jid: 'room@conference.example.com', hash: 'new-hash', type: 'room' },
      ])

      // Mock room store to return room WITH existing avatarHash
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.com',
        name: 'Room',
        nickname: '',
        joined: false,
        isBookmarked: false,
        occupants: new Map(),
        messages: [],
        unreadCount: 0,
        mentionsCount: 0,
        typingUsers: new Set<string>(),
        avatarHash: 'existing-hash', // Already has hash
      })

      await xmppClient.profile.restoreAllRoomAvatarHashes()

      // Should NOT emit room:updated for rooms with existing hash
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:updated', expect.anything())
    })
  })

  describe('refreshAllAvatarBlobUrls', () => {
    beforeEach(async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should refresh stale blob URLs for contacts and rooms', async () => {
      emitSDKSpy.mockClear()

      const { refreshAllBlobUrls, tryGetAllAvatarHashes } = await import('../../utils/avatarCache')
      vi.mocked(refreshAllBlobUrls).mockResolvedValue(new Map([
        ['hash-c1', 'blob:fresh-contact1'],
        ['hash-r1', 'blob:fresh-room1'],
      ]))
      vi.mocked(tryGetAllAvatarHashes).mockResolvedValue([
        { jid: 'alice@example.com', hash: 'hash-c1', type: 'contact' },
        { jid: 'room@conference.example.com', hash: 'hash-r1', type: 'room' },
      ])

      mockStores.roster.getContact.mockReturnValue({ jid: 'alice@example.com', name: 'Alice', presence: 'offline', subscription: 'both', avatarHash: 'hash-c1' })
      mockStores.room.getRoom.mockReturnValue({
        jid: 'room@conference.example.com', name: 'Room', nickname: '',
        joined: true, isBookmarked: false, occupants: new Map(),
        messages: [], unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>(),
        avatarHash: 'hash-r1',
      })

      await xmppClient.profile.refreshAllAvatarBlobUrls()

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:avatar', {
        jid: 'alice@example.com', avatar: 'blob:fresh-contact1', avatarHash: 'hash-c1',
      })
      expect(emitSDKSpy).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.com',
        updates: { avatar: 'blob:fresh-room1', avatarHash: 'hash-r1' },
      })
    })

    it('should skip entities not in store', async () => {
      emitSDKSpy.mockClear()

      const { refreshAllBlobUrls, tryGetAllAvatarHashes } = await import('../../utils/avatarCache')
      vi.mocked(refreshAllBlobUrls).mockResolvedValue(new Map([['hash1', 'blob:url']]))
      vi.mocked(tryGetAllAvatarHashes).mockResolvedValue([
        { jid: 'unknown@example.com', hash: 'hash1', type: 'contact' },
      ])
      mockStores.roster.getContact.mockReturnValue(undefined)

      await xmppClient.profile.refreshAllAvatarBlobUrls()

      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:avatar', expect.anything())
    })

    it('should be a no-op when no cached avatars exist', async () => {
      emitSDKSpy.mockClear()

      const { refreshAllBlobUrls } = await import('../../utils/avatarCache')
      vi.mocked(refreshAllBlobUrls).mockResolvedValue(new Map())

      await xmppClient.profile.refreshAllAvatarBlobUrls()

      expect(emitSDKSpy).not.toHaveBeenCalled()
    })

    it('does not seed a failed hash-store read as an empty snapshot', async () => {
      const {
        refreshAllBlobUrls,
        tryGetAllAvatarHashes,
        seedRoomOccupantAvatarHashes,
      } = await import('../../utils/avatarCache')
      vi.mocked(refreshAllBlobUrls).mockResolvedValue(
        new Map([['hash-other', 'blob:fresh-other']])
      )
      vi.mocked(tryGetAllAvatarHashes).mockResolvedValueOnce(null)
      vi.mocked(seedRoomOccupantAvatarHashes).mockClear()

      await xmppClient.profile.refreshAllAvatarBlobUrls()

      expect(seedRoomOccupantAvatarHashes).toHaveBeenCalledWith(null)
    })

    it('should refresh stale blob URLs for MUC occupants', async () => {
      emitSDKSpy.mockClear()

      const { refreshAllBlobUrls, tryGetAllAvatarHashes } = await import('../../utils/avatarCache')
      vi.mocked(refreshAllBlobUrls).mockResolvedValue(new Map([['hash-o1', 'blob:fresh-occupant1']]))
      // Occupant avatars are NOT in the contact/room hash store, so this stays empty.
      vi.mocked(tryGetAllAvatarHashes).mockResolvedValue([])

      // A joined room whose occupant's avatar blob URL went stale after wake.
      // refreshAllBlobUrls revoked the old blobs; occupants must be re-pointed.
      const occupants = new Map<string, RoomOccupant>([
        ['Alice', { nick: 'Alice', affiliation: 'none', role: 'participant', avatar: 'blob:stale-occupant', avatarHash: 'hash-o1' }],
        ['Bob', { nick: 'Bob', affiliation: 'none', role: 'participant' }], // no avatarHash → must be skipped
        ['Carol', { nick: 'Carol', affiliation: 'none', role: 'participant', avatar: 'blob:stale', avatarHash: 'hash-unknown' }], // hash not refreshed → skipped
      ])
      mockStores.room.joinedRooms.mockReturnValue([
        {
          jid: 'room@conf.example.com', name: 'Room', nickname: '',
          joined: true, isBookmarked: false, occupants,
          messages: [], unreadCount: 0, mentionsCount: 0, typingUsers: new Set<string>(),
        } as Room,
      ])

      await xmppClient.profile.refreshAllAvatarBlobUrls()

      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-avatar', {
        roomJid: 'room@conf.example.com',
        nick: 'Alice',
        avatar: 'blob:fresh-occupant1',
        avatarHash: 'hash-o1',
      })
      // Occupants without a hash, or whose hash wasn't refreshed, must not emit.
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:occupant-avatar', expect.objectContaining({ nick: 'Bob' }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:occupant-avatar', expect.objectContaining({ nick: 'Carol' }))
    })

    it('groups persisted occupant aliases once for every joined room', async () => {
      emitSDKSpy.mockClear()

      const {
        refreshAllBlobUrls,
        tryGetAllAvatarHashes,
        getRoomOccupantAvatarHashes,
        seedRoomOccupantAvatarHashes,
      } = await import('../../utils/avatarCache')
      const mappings = [
        { jid: 'encoded-a', hash: 'hash-a', type: 'occupant' as const },
        { jid: 'encoded-b', hash: 'hash-b', type: 'occupant' as const },
      ]
      vi.mocked(tryGetAllAvatarHashes).mockClear()
      vi.mocked(seedRoomOccupantAvatarHashes).mockClear()
      vi.mocked(refreshAllBlobUrls).mockResolvedValue(new Map([
        ['hash-a', 'blob:fresh-a'],
        ['hash-b', 'blob:fresh-b'],
      ]))
      vi.mocked(tryGetAllAvatarHashes).mockResolvedValue(mappings)
      vi.mocked(seedRoomOccupantAvatarHashes).mockResolvedValueOnce(new Map([
        ['room-a@conf.example.com', new Map([['occ-a', 'hash-a']])],
        ['room-b@conf.example.com', new Map([['occ-b', 'hash-b']])],
      ]))
      vi.mocked(getRoomOccupantAvatarHashes).mockClear()

      mockStores.room.joinedRooms.mockReturnValue([
        {
          jid: 'room-a@conf.example.com',
          occupants: new Map(),
          occupantIdToNick: new Map([['occ-a', 'Alice']]),
        } as Room,
        {
          jid: 'room-b@conf.example.com',
          occupants: new Map(),
        } as Room,
      ])

      await xmppClient.profile.refreshAllAvatarBlobUrls()

      expect(tryGetAllAvatarHashes).toHaveBeenCalledTimes(1)
      expect(seedRoomOccupantAvatarHashes).toHaveBeenCalledTimes(1)
      expect(seedRoomOccupantAvatarHashes).toHaveBeenCalledWith(mappings)
      expect(getRoomOccupantAvatarHashes).not.toHaveBeenCalled()
      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-avatar', {
        roomJid: 'room-a@conf.example.com',
        nick: 'Alice',
        occupantId: 'occ-a',
        avatar: 'blob:fresh-a',
        avatarHash: 'hash-a',
      })
      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-avatar', {
        roomJid: 'room-b@conf.example.com',
        occupantId: 'occ-b',
        avatar: 'blob:fresh-b',
        avatarHash: 'hash-b',
      })
    })

    it('re-points a roster contact whose hash the mapping store missed', async () => {
      emitSDKSpy.mockClear()

      const { refreshAllBlobUrls, tryGetAllAvatarHashes } = await import('../../utils/avatarCache')
      // A fresh URL exists for the contact's hash, but the IndexedDB mapping
      // store does NOT list this JID (e.g. the avatar arrived via MUC
      // vcard-temp presence, not a PEP/vCard fetch). The mapping loop misses it;
      // the roster-store safety net must still re-point its dead blob.
      vi.mocked(refreshAllBlobUrls).mockResolvedValue(new Map([['hash-seb', 'blob:fresh-seb']]))
      vi.mocked(tryGetAllAvatarHashes).mockResolvedValue([])
      mockStores.roster.sortedContacts.mockReturnValue([
        { jid: 'seb@example.com', name: 'Seb', presence: 'online', subscription: 'both', avatar: 'blob:dead-seb', avatarHash: 'hash-seb' },
      ])

      await xmppClient.profile.refreshAllAvatarBlobUrls()

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:avatar', {
        jid: 'seb@example.com', avatar: 'blob:fresh-seb', avatarHash: 'hash-seb',
      })
    })

    it('re-fetches a roster contact whose cached avatar bytes are gone', async () => {
      emitSDKSpy.mockClear()

      const { refreshAllBlobUrls, tryGetAllAvatarHashes } = await import('../../utils/avatarCache')
      // Another contact is cached (so the size-0 short-circuit doesn't fire), but
      // Seb's hash has no fresh URL → his bytes were evicted from IndexedDB.
      // His pointer is a now-dead blob, so the safety net must re-fetch to heal.
      vi.mocked(refreshAllBlobUrls).mockResolvedValue(new Map([['hash-other', 'blob:other']]))
      vi.mocked(tryGetAllAvatarHashes).mockResolvedValue([])
      const fetchSpy = vi.spyOn(xmppClient.profile, 'fetchAvatarData').mockResolvedValue()
      mockStores.roster.sortedContacts.mockReturnValue([
        { jid: 'seb@example.com', name: 'Seb', presence: 'online', subscription: 'both', avatar: 'blob:dead-seb', avatarHash: 'hash-seb' },
      ])

      await xmppClient.profile.refreshAllAvatarBlobUrls()

      expect(fetchSpy).toHaveBeenCalledWith('seb@example.com', 'hash-seb')
    })

    it('should re-point the current user\'s own avatar via connection:own-avatar', async () => {
      emitSDKSpy.mockClear()

      const { refreshAllBlobUrls, tryGetAllAvatarHashes } = await import('../../utils/avatarCache')
      vi.mocked(refreshAllBlobUrls).mockResolvedValue(new Map([['hash-self', 'blob:fresh-self']]))
      // The own avatar is stored in the hash store as a 'contact' under the
      // user's own bare JID (Profile.fetchOwnAvatar → saveAvatarHash(..., 'contact')).
      vi.mocked(tryGetAllAvatarHashes).mockResolvedValue([
        { jid: 'user@example.com', hash: 'hash-self', type: 'contact' },
      ])
      // The user is not in their own roster, so getContact misses.
      mockStores.roster.getContact.mockReturnValue(undefined)

      await xmppClient.profile.refreshAllAvatarBlobUrls()

      // Must re-point the own avatar through the connection store, not the roster.
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-avatar', {
        avatar: 'blob:fresh-self', hash: 'hash-self',
      })
      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:avatar', expect.objectContaining({ jid: 'user@example.com' }))
    })
  })

  describe('Negative Avatar Cache', () => {
    beforeEach(async () => {
      // Connect the client first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    describe('fetchVCardAvatar', () => {
      it('should skip query when JID is in negative cache', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(true) // JID has no avatar (cached)

        await xmppClient.profile.fetchVCardAvatar('noavatar@example.com')

        // Should NOT make any IQ request
        expect(mockXmppClientInstance.iqCaller.request).not.toHaveBeenCalled()
      })

      it('should mark JID in negative cache when vCard has no photo', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar, markNoAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache

        // Mock vCard response without PHOTO
        const vcardResponse = createMockElement('iq', { type: 'result' }, [
          {
            name: 'vCard',
            attrs: { xmlns: 'vcard-temp' },
            children: [
              { name: 'FN', text: 'John Doe' },
              // No PHOTO element
            ],
          },
        ])
        mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(vcardResponse)

        await xmppClient.profile.fetchVCardAvatar('nophoto@example.com')

        // Should mark the JID as having no avatar
        expect(markNoAvatar).toHaveBeenCalledWith('nophoto@example.com', 'contact')
      })

      it('should clear negative cache when vCard photo is found', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()
        emitSDKSpy.mockClear()

        const { hasNoAvatar, clearNoAvatar, cacheAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache
        vi.mocked(cacheAvatar).mockResolvedValue('blob:avatar-url')

        // Mock vCard response WITH PHOTO
        const vcardResponse = createMockElement('iq', { type: 'result' }, [
          {
            name: 'vCard',
            attrs: { xmlns: 'vcard-temp' },
            children: [
              {
                name: 'PHOTO',
                children: [
                  { name: 'TYPE', text: 'image/png' },
                  { name: 'BINVAL', text: 'base64avatardata' },
                ],
              },
            ],
          },
        ])
        mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(vcardResponse)

        await xmppClient.profile.fetchVCardAvatar('hasphoto@example.com')

        // Should clear the negative cache for this JID
        expect(clearNoAvatar).toHaveBeenCalledWith('hasphoto@example.com')
      })
    })

    describe('fetchContactAvatarMetadata', () => {
      it('should skip query when JID is in negative cache', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(true) // JID has no avatar (cached)

        const result = await xmppClient.profile.fetchContactAvatarMetadata('noavatar@example.com')

        // Should return null without making any IQ request
        expect(result).toBeNull()
        expect(mockXmppClientInstance.iqCaller.request).not.toHaveBeenCalled()
      })

      it('should mark JID in negative cache when neither XEP-0084 nor vCard has avatar', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar, markNoAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache

        // Mock empty XEP-0084 metadata response
        const emptyMetadataResponse = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:avatar:metadata' },
                children: [
                  {
                    name: 'item',
                    children: [
                      {
                        name: 'metadata',
                        attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                        // No info child means no avatar
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        // Mock vCard response without PHOTO
        const vcardResponse = createMockElement('iq', { type: 'result' }, [
          {
            name: 'vCard',
            attrs: { xmlns: 'vcard-temp' },
            children: [
              { name: 'FN', text: 'No Avatar User' },
              // No PHOTO element
            ],
          },
        ])

        mockXmppClientInstance.iqCaller.request
          .mockResolvedValueOnce(emptyMetadataResponse) // XEP-0084 empty
          .mockResolvedValueOnce(vcardResponse) // vCard also empty

        await xmppClient.profile.fetchContactAvatarMetadata('noavatar@example.com')

        // Should mark the JID as having no avatar (via vCard fallback path)
        expect(markNoAvatar).toHaveBeenCalledWith('noavatar@example.com', 'contact')
      })

      it('should clear negative cache when XEP-0084 avatar is found', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar, clearNoAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache

        // Mock successful XEP-0084 metadata response
        const metadataResponse = createMockElement('iq', { type: 'result' }, [
          {
            name: 'pubsub',
            attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
            children: [
              {
                name: 'items',
                attrs: { node: 'urn:xmpp:avatar:metadata' },
                children: [
                  {
                    name: 'item',
                    attrs: { id: 'found-hash' },
                    children: [
                      {
                        name: 'metadata',
                        attrs: { xmlns: 'urn:xmpp:avatar:metadata' },
                        children: [
                          {
                            name: 'info',
                            attrs: { id: 'found-hash', type: 'image/png', bytes: '1024' },
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ])

        mockXmppClientInstance.iqCaller.request
          .mockResolvedValueOnce(metadataResponse)
          .mockRejectedValue(new Error('not found')) // Subsequent calls fail (ok for test)

        await xmppClient.profile.fetchContactAvatarMetadata('hasavatar@example.com')

        // Should clear the negative cache for this JID
        expect(clearNoAvatar).toHaveBeenCalledWith('hasavatar@example.com')
      })
    })

    describe('fetchRoomAvatar', () => {
      it('should skip query when room JID is in negative cache (no known hash)', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(true) // Room has no avatar (cached)

        await xmppClient.profile.fetchRoomAvatar('noavatar@conference.example.com')

        // Should NOT make any IQ request
        expect(mockXmppClientInstance.iqCaller.request).not.toHaveBeenCalled()
      })

      it('should NOT check negative cache when known hash is provided', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar, getCachedAvatar } = await import('../../utils/avatarCache')
        vi.mocked(getCachedAvatar).mockResolvedValueOnce('blob:cached-avatar')

        await xmppClient.profile.fetchRoomAvatar('room@conference.example.com', 'known-hash')

        // Should NOT check negative cache when hash is provided
        expect(hasNoAvatar).not.toHaveBeenCalled()
      })

      it('should mark room JID in negative cache when vCard has no photo', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar, markNoAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache

        // Mock vCard response without PHOTO
        const vcardResponse = createMockElement('iq', { type: 'result' }, [
          {
            name: 'vCard',
            attrs: { xmlns: 'vcard-temp' },
            children: [
              { name: 'FN', text: 'Conference Room' },
              // No PHOTO element
            ],
          },
        ])
        mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(vcardResponse)

        await xmppClient.profile.fetchRoomAvatar('noavatar@conference.example.com')

        // Should mark the room JID as having no avatar
        expect(markNoAvatar).toHaveBeenCalledWith('noavatar@conference.example.com', 'room')
      })

      it('should mark room JID in negative cache on item-not-found error', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar, markNoAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache

        // Mock item-not-found error
        mockXmppClientInstance.iqCaller.request.mockRejectedValueOnce(new Error('item-not-found'))

        await xmppClient.profile.fetchRoomAvatar('noavatar@conference.example.com')

        // Should mark the room JID as having no avatar
        expect(markNoAvatar).toHaveBeenCalledWith('noavatar@conference.example.com', 'room')
      })

      it('should clear negative cache when room avatar is found', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar, clearNoAvatar, cacheAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache
        vi.mocked(cacheAvatar).mockResolvedValue('blob:room-avatar')

        // Mock vCard response WITH PHOTO
        const vcardResponse = createMockElement('iq', { type: 'result' }, [
          {
            name: 'vCard',
            attrs: { xmlns: 'vcard-temp' },
            children: [
              {
                name: 'PHOTO',
                children: [
                  { name: 'TYPE', text: 'image/png' },
                  { name: 'BINVAL', text: 'base64roomavatardata' },
                ],
              },
            ],
          },
        ])
        mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(vcardResponse)

        await xmppClient.profile.fetchRoomAvatar('hasavatar@conference.example.com')

        // Should clear the negative cache for this room JID
        expect(clearNoAvatar).toHaveBeenCalledWith('hasavatar@conference.example.com')
      })
    })

    describe('fetchOccupantAvatar', () => {
      it('records only the room-scoped stable alias when cached bytes satisfy an occupant avatar', async () => {
        const {
          getCachedAvatar,
          saveAvatarHash,
          saveRoomOccupantAvatarHash,
        } = await import('../../utils/avatarCache')
        vi.mocked(getCachedAvatar).mockResolvedValueOnce('blob:shared-avatar')

        await xmppClient.profile.fetchOccupantAvatar(
          'room@conference.example.com',
          'CurrentNick',
          'shared-hash',
          'person@example.com/resource',
          'opaque-occupant-id',
        )

        expect(saveAvatarHash).not.toHaveBeenCalled()
        expect(saveRoomOccupantAvatarHash).toHaveBeenCalledWith(
          'room@conference.example.com',
          'opaque-occupant-id',
          'shared-hash',
        )
        expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-avatar', {
          roomJid: 'room@conference.example.com',
          nick: 'CurrentNick',
          occupantId: 'opaque-occupant-id',
          avatar: 'blob:shared-avatar',
          avatarHash: 'shared-hash',
        })
      })

      it('should clear negative cache and proceed when presence advertises avatar hash', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { clearNoAvatar, getCachedAvatar } = await import('../../utils/avatarCache')
        vi.mocked(getCachedAvatar).mockResolvedValueOnce(null) // Not in avatar cache

        // Mock XEP-0084 PEP response with avatar data
        const avatarData = 'base64avatardata'
        const pepResponse = createMockElement('iq', { type: 'result' }, [
          { name: 'pubsub', attrs: { xmlns: 'http://jabber.org/protocol/pubsub' }, children: [
            { name: 'items', children: [
              { name: 'item', attrs: { id: 'some-hash' }, children: [
                { name: 'data', attrs: { xmlns: 'urn:xmpp:avatar:data' }, text: avatarData },
              ] },
            ] },
          ] },
        ])
        mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(pepResponse)

        await xmppClient.profile.fetchOccupantAvatar(
          'room@conference.example.com',
          'TestUser',
          'some-hash',
          'realuser@example.com'
        )

        // Should clear the negative cache since presence advertises an avatar
        expect(clearNoAvatar).toHaveBeenCalledWith('realuser@example.com')
        // Should proceed to fetch avatar via IQ
        expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()
      })

      it('should cache forbidden error from XEP-0084 when vCard also fails', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar, markNoAvatar, getCachedAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache
        vi.mocked(getCachedAvatar).mockResolvedValueOnce(null) // No cached avatar

        // First call: XEP-0084 returns forbidden
        // Second call: vCard also returns forbidden
        mockXmppClientInstance.iqCaller.request
          .mockRejectedValueOnce(new Error('forbidden'))
          .mockRejectedValueOnce(new Error('forbidden'))

        await xmppClient.profile.fetchOccupantAvatar(
          'room@conference.example.com',
          'PrivateUser',
          'private-hash',
          'private@example.com'
        )

        // Should mark the realJid as no-avatar due to forbidden errors
        expect(markNoAvatar).toHaveBeenCalledWith('private@example.com', 'contact')
      })

      it('should cache empty vCard response after forbidden XEP-0084', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { hasNoAvatar, markNoAvatar, getCachedAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache
        vi.mocked(getCachedAvatar).mockResolvedValueOnce(null) // No cached avatar

        // Mock empty vCard response (no PHOTO)
        const emptyVcardResponse = createMockElement('iq', { type: 'result' }, [
          {
            name: 'vCard',
            attrs: { xmlns: 'vcard-temp' },
            children: [],
          },
        ])

        mockXmppClientInstance.iqCaller.request
          .mockRejectedValueOnce(new Error('forbidden')) // XEP-0084 forbidden
          .mockResolvedValueOnce(emptyVcardResponse) // vCard empty

        await xmppClient.profile.fetchOccupantAvatar(
          'room@conference.example.com',
          'NoAvatarUser',
          'some-hash',
          'noavatar@example.com'
        )

        // Should mark as no-avatar due to empty vCard
        expect(markNoAvatar).toHaveBeenCalledWith('noavatar@example.com', 'contact')
      })

      it('should clear negative cache when avatar is successfully fetched', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()
        emitSDKSpy.mockClear()

        const { hasNoAvatar, clearNoAvatar, getCachedAvatar, cacheAvatar } = await import('../../utils/avatarCache')
        vi.mocked(hasNoAvatar).mockResolvedValueOnce(false) // Not in cache
        vi.mocked(getCachedAvatar).mockResolvedValueOnce(null) // No cached avatar
        vi.mocked(cacheAvatar).mockResolvedValue('blob:occupant-avatar')

        // Mock vCard response WITH PHOTO
        const vcardResponse = createMockElement('iq', { type: 'result' }, [
          {
            name: 'vCard',
            attrs: { xmlns: 'vcard-temp' },
            children: [
              {
                name: 'PHOTO',
                children: [
                  { name: 'TYPE', text: 'image/png' },
                  { name: 'BINVAL', text: 'base64avatardata' },
                ],
              },
            ],
          },
        ])

        mockXmppClientInstance.iqCaller.request
          .mockRejectedValueOnce(new Error('item-not-found')) // XEP-0084 not found
          .mockResolvedValueOnce(vcardResponse) // vCard has avatar

        await xmppClient.profile.fetchOccupantAvatar(
          'room@conference.example.com',
          'HasAvatar',
          'avatar-hash',
          'hasavatar@example.com'
        )

        // Should clear negative cache and emit avatar
        expect(clearNoAvatar).toHaveBeenCalledWith('hasavatar@example.com')
        expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-avatar', {
          roomJid: 'room@conference.example.com',
          nick: 'HasAvatar',
          avatar: 'blob:occupant-avatar',
          avatarHash: 'avatar-hash',
        })
      })

      it('caches a non-png occupant PEP avatar with the MIME type sniffed from its bytes', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { getCachedAvatar, cacheAvatar } = await import('../../utils/avatarCache')
        vi.mocked(getCachedAvatar).mockResolvedValueOnce(null)
        vi.mocked(cacheAvatar).mockResolvedValue('blob:webp-occupant')

        // Occupant PEP data node carries WebP bytes (no advertised type on the wire).
        const pepResponse = createMockElement('iq', { type: 'result' }, [
          { name: 'pubsub', attrs: { xmlns: 'http://jabber.org/protocol/pubsub' }, children: [
            { name: 'items', children: [
              { name: 'item', attrs: { id: 'webp-hash' }, children: [
                { name: 'data', attrs: { xmlns: 'urn:xmpp:avatar:data' }, text: WEBP_BASE64 },
              ] },
            ] },
          ] },
        ])
        mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(pepResponse)

        await xmppClient.profile.fetchOccupantAvatar(
          'room@conference.example.com',
          'WebpUser',
          'webp-hash',
          'webpuser@example.com'
        )

        expect(cacheAvatar).toHaveBeenCalledWith('webp-hash', WEBP_BASE64, 'image/webp')
      })
    })

    describe('fetchOccupantAvatar saves JID→hash mapping', () => {
      it('should save avatar hash mapping when PEP fetch succeeds with real JID', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { getCachedAvatar, cacheAvatar, saveAvatarHash } = await import('../../utils/avatarCache')
        vi.mocked(getCachedAvatar).mockReset().mockResolvedValue(null)
        vi.mocked(cacheAvatar).mockReset().mockResolvedValue('blob:pep-avatar')
        vi.mocked(saveAvatarHash).mockReset().mockResolvedValue(undefined)

        const avatarData = 'base64avatardata'
        const pepResponse = createMockElement('iq', { type: 'result' }, [
          { name: 'pubsub', attrs: { xmlns: 'http://jabber.org/protocol/pubsub' }, children: [
            { name: 'items', children: [
              { name: 'item', attrs: { id: 'occ-hash' }, children: [
                { name: 'data', attrs: { xmlns: 'urn:xmpp:avatar:data' }, text: avatarData },
              ] },
            ] },
          ] },
        ])
        mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(pepResponse)

        await xmppClient.profile.fetchOccupantAvatar(
          'room@conference.example.com',
          'User',
          'occ-hash',
          'user@example.com/res'
        )

        expect(saveAvatarHash).toHaveBeenCalledWith('user@example.com', 'occ-hash', 'contact')
      })

      it('should save avatar hash mapping when vCard fetch succeeds with real JID', async () => {
        mockXmppClientInstance.iqCaller.request.mockClear()

        const { getCachedAvatar, cacheAvatar, saveAvatarHash } = await import('../../utils/avatarCache')
        vi.mocked(getCachedAvatar).mockReset().mockResolvedValue(null)
        vi.mocked(cacheAvatar).mockReset().mockResolvedValue('blob:vcard-avatar')
        vi.mocked(saveAvatarHash).mockReset().mockResolvedValue(undefined)

        const vcardResponse = createMockElement('iq', { type: 'result' }, [
          { name: 'vCard', attrs: { xmlns: 'vcard-temp' }, children: [
            { name: 'PHOTO', children: [
              { name: 'TYPE', text: 'image/jpeg' },
              { name: 'BINVAL', text: 'base64vcarddata' },
            ] },
          ] },
        ])

        mockXmppClientInstance.iqCaller.request
          .mockRejectedValueOnce(new Error('item-not-found')) // PEP fails
          .mockResolvedValueOnce(vcardResponse) // vCard succeeds

        await xmppClient.profile.fetchOccupantAvatar(
          'room@conference.example.com',
          'User2',
          'vcard-hash',
          'user2@example.com'
        )

        expect(saveAvatarHash).toHaveBeenCalledWith('user2@example.com', 'vcard-hash', 'contact')
      })
    })

    describe('restoreOccupantAvatarsFromCache', () => {
      it('restores an offline anonymous occupant through its room-scoped occupant-id', async () => {
        emitSDKSpy.mockClear()

        const {
          getRoomOccupantAvatarHashes,
          getCachedAvatar,
        } = await import('../../utils/avatarCache')
        vi.mocked(getRoomOccupantAvatarHashes).mockResolvedValueOnce([
          { occupantId: 'offline-opaque-id', hash: 'offline-hash' },
        ])
        vi.mocked(getCachedAvatar).mockResolvedValueOnce('blob:offline-avatar')

        mockStores.room.getRoom.mockReturnValue({
          jid: 'room@conference.example.com',
          occupants: new Map(),
        } as any)

        await xmppClient.profile.restoreOccupantAvatarsFromCache(
          'room@conference.example.com'
        )

        expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-avatar', {
          roomJid: 'room@conference.example.com',
          occupantId: 'offline-opaque-id',
          avatar: 'blob:offline-avatar',
          avatarHash: 'offline-hash',
        })
      })

      it('includes the live nick when a stable restore matches an online occupant', async () => {
        emitSDKSpy.mockClear()

        const {
          getRoomOccupantAvatarHashes,
          getCachedAvatar,
        } = await import('../../utils/avatarCache')
        vi.mocked(getRoomOccupantAvatarHashes).mockResolvedValueOnce([
          { occupantId: 'online-opaque-id', hash: 'online-hash' },
        ])
        vi.mocked(getCachedAvatar).mockResolvedValueOnce('blob:online-avatar')

        mockStores.room.getRoom.mockReturnValue({
          jid: 'room@conference.example.com',
          occupants: new Map([
            ['Alice', {
              nick: 'Alice',
              occupantId: 'online-opaque-id',
              affiliation: 'none',
              role: 'participant',
            }],
          ]),
          occupantIdToNick: new Map([['online-opaque-id', 'Alice']]),
        } as any)

        await xmppClient.profile.restoreOccupantAvatarsFromCache(
          'room@conference.example.com'
        )

        expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-avatar', {
          roomJid: 'room@conference.example.com',
          nick: 'Alice',
          occupantId: 'online-opaque-id',
          avatar: 'blob:online-avatar',
          avatarHash: 'online-hash',
        })
      })

      it('restores optimistically while room anonymity disco is unresolved', async () => {
        emitSDKSpy.mockClear()
        ;(xmppClient.profile as any).deps.privacyOptions = {
          disableOccupantAvatarsInAnonymousRooms: true,
        }

        const {
          getRoomOccupantAvatarHashes,
          getCachedAvatar,
        } = await import('../../utils/avatarCache')
        vi.mocked(getRoomOccupantAvatarHashes).mockResolvedValueOnce([
          { occupantId: 'pending-disco-id', hash: 'pending-disco-hash' },
        ])
        vi.mocked(getCachedAvatar).mockResolvedValueOnce('blob:pending-disco')

        mockStores.room.getRoom.mockReturnValue({
          jid: 'room@conference.example.com',
          isNonAnonymous: undefined,
          occupants: new Map(),
        } as any)

        await xmppClient.profile.restoreOccupantAvatarsFromCache(
          'room@conference.example.com'
        )

        expect(emitSDKSpy).toHaveBeenCalledWith(
          'room:occupant-avatar',
          expect.objectContaining({ occupantId: 'pending-disco-id' }),
        )
      })

      it('should restore cached avatar for occupant with real JID but no avatar', async () => {
        emitSDKSpy.mockClear()

        const { getAvatarHash, getCachedAvatar } = await import('../../utils/avatarCache')
        vi.mocked(getAvatarHash).mockReset().mockResolvedValue(null)
        vi.mocked(getCachedAvatar).mockReset().mockResolvedValue(null)
        vi.mocked(getAvatarHash).mockResolvedValueOnce('cached-hash')
        vi.mocked(getCachedAvatar).mockResolvedValueOnce('blob:restored-avatar')

        mockStores.room.getRoom.mockReturnValue({
          jid: 'room@conference.example.com',
          occupants: new Map([
            ['dwd', { nick: 'dwd', jid: 'dwd@example.com/res', affiliation: 'member', role: 'participant' }],
          ]),
        } as any)

        await xmppClient.profile.restoreOccupantAvatarsFromCache('room@conference.example.com')

        expect(getAvatarHash).toHaveBeenCalledWith('dwd@example.com')
        expect(getCachedAvatar).toHaveBeenCalledWith('cached-hash')
        expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-avatar', {
          roomJid: 'room@conference.example.com',
          nick: 'dwd',
          avatar: 'blob:restored-avatar',
          avatarHash: 'cached-hash',
        })
      })

      it('should skip occupants that already have an avatar', async () => {
        const { getAvatarHash } = await import('../../utils/avatarCache')
        vi.mocked(getAvatarHash).mockReset().mockResolvedValue(null)

        mockStores.room.getRoom.mockReturnValue({
          jid: 'room@conference.example.com',
          occupants: new Map([
            ['user1', { nick: 'user1', jid: 'user1@example.com', avatar: 'blob:existing', affiliation: 'member', role: 'participant' }],
          ]),
        } as any)

        await xmppClient.profile.restoreOccupantAvatarsFromCache('room@conference.example.com')

        expect(getAvatarHash).not.toHaveBeenCalled()
      })

      it('should skip occupants without a real JID', async () => {
        const { getAvatarHash } = await import('../../utils/avatarCache')
        vi.mocked(getAvatarHash).mockReset().mockResolvedValue(null)

        mockStores.room.getRoom.mockReturnValue({
          jid: 'room@conference.example.com',
          occupants: new Map([
            ['anon', { nick: 'anon', affiliation: 'none', role: 'participant' }],
          ]),
        } as any)

        await xmppClient.profile.restoreOccupantAvatarsFromCache('room@conference.example.com')

        expect(getAvatarHash).not.toHaveBeenCalled()
      })

      it('should skip occupants with no cached avatar hash', async () => {
        emitSDKSpy.mockClear()

        const { getAvatarHash } = await import('../../utils/avatarCache')
        vi.mocked(getAvatarHash).mockReset().mockResolvedValueOnce(null)

        mockStores.room.getRoom.mockReturnValue({
          jid: 'room@conference.example.com',
          occupants: new Map([
            ['newuser', { nick: 'newuser', jid: 'newuser@example.com', affiliation: 'member', role: 'participant' }],
          ]),
        } as any)

        await xmppClient.profile.restoreOccupantAvatarsFromCache('room@conference.example.com')

        expect(emitSDKSpy).not.toHaveBeenCalledWith('room:occupant-avatar', expect.anything())
      })
    })
  })

  describe('fetchAvatarData cache dedup', () => {
    beforeEach(async () => {
      // Connect the client first
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should return cached avatar without network request when hash is in cache', async () => {
      mockXmppClientInstance.iqCaller.request.mockClear()
      emitSDKSpy.mockClear()

      const { getCachedAvatar } = await import('../../utils/avatarCache')
      vi.mocked(getCachedAvatar).mockResolvedValueOnce('blob:already-cached')

      await xmppClient.profile.fetchAvatarData('contact@example.com', 'cached-hash')

      // Should NOT make any IQ request
      expect(mockXmppClientInstance.iqCaller.request).not.toHaveBeenCalled()

      // Should emit avatar update with cached URL
      expect(emitSDKSpy).toHaveBeenCalledWith('roster:avatar', {
        jid: 'contact@example.com',
        avatar: 'blob:already-cached',
        avatarHash: 'cached-hash',
      })
    })

    it('should fetch from network when hash is NOT in cache', async () => {
      mockXmppClientInstance.iqCaller.request.mockClear()
      emitSDKSpy.mockClear()

      const { getCachedAvatar, cacheAvatar, saveAvatarHash } = await import('../../utils/avatarCache')
      vi.mocked(getCachedAvatar).mockResolvedValueOnce(null)
      vi.mocked(cacheAvatar).mockResolvedValueOnce('blob:newly-fetched')

      // Mock PEP data response
      const dataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:data' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'new-hash' },
                  children: [
                    {
                      name: 'data',
                      attrs: { xmlns: 'urn:xmpp:avatar:data' },
                      text: 'iVBORw0KGgo=',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(dataResponse)

      await xmppClient.profile.fetchAvatarData('contact@example.com', 'new-hash')

      // Should have made network request
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalledTimes(1)

      // Should cache the fetched avatar to IndexedDB
      expect(cacheAvatar).toHaveBeenCalledWith('new-hash', 'iVBORw0KGgo=', 'image/png')
      expect(saveAvatarHash).toHaveBeenCalledWith('contact@example.com', 'new-hash', 'contact')
    })

    it('caches a non-png PEP avatar with the MIME type sniffed from its bytes', async () => {
      mockXmppClientInstance.iqCaller.request.mockClear()
      emitSDKSpy.mockClear()

      const { getCachedAvatar, cacheAvatar } = await import('../../utils/avatarCache')
      vi.mocked(getCachedAvatar).mockResolvedValueOnce(null)
      vi.mocked(cacheAvatar).mockResolvedValueOnce('blob:gif-avatar')

      // PEP data node carries GIF bytes (XEP-0084 data responses have no type).
      const dataResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:avatar:data' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'gif-hash' },
                  children: [
                    { name: 'data', attrs: { xmlns: 'urn:xmpp:avatar:data' }, text: GIF_BASE64 },
                  ],
                },
              ],
            },
          ],
        },
      ])
      mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(dataResponse)

      await xmppClient.profile.fetchAvatarData('contact@example.com', 'gif-hash')

      // Cached as image/gif, not the old hardcoded image/png.
      expect(cacheAvatar).toHaveBeenCalledWith('gif-hash', GIF_BASE64, 'image/gif')
    })
  })

  describe('avatarMetadataUpdate event dedup', () => {
    beforeEach(async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online', { jid: { toString: () => 'user@example.com/resource' } })
      await connectPromise
    })

    it('should skip fetch when contact already has the same avatar hash and avatar', async () => {
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock roster store to return a contact with existing avatar
      mockStores.roster.getContact.mockReturnValue({
        jid: 'contact@example.com',
        name: 'Contact',
        subscription: 'both',
        presence: 'online',
        avatar: 'blob:existing-avatar',
        avatarHash: 'same-hash',
      })

      // Emit avatarMetadataUpdate with same hash
      ;(xmppClient as any).emit('avatarMetadataUpdate', 'contact@example.com', 'same-hash')

      // Allow any pending promises to resolve
      await vi.runAllTimersAsync()

      // Should NOT trigger any network request
      expect(mockXmppClientInstance.iqCaller.request).not.toHaveBeenCalled()
    })

    it('should fetch when contact has different avatar hash', async () => {
      mockXmppClientInstance.iqCaller.request.mockClear()

      const { getCachedAvatar } = await import('../../utils/avatarCache')
      vi.mocked(getCachedAvatar).mockResolvedValueOnce(null)

      // Mock roster store to return a contact with different avatar
      mockStores.roster.getContact.mockReturnValue({
        jid: 'contact@example.com',
        name: 'Contact',
        subscription: 'both',
        presence: 'online',
        avatar: 'blob:old-avatar',
        avatarHash: 'old-hash',
      })

      // Emit avatarMetadataUpdate with new hash
      ;(xmppClient as any).emit('avatarMetadataUpdate', 'contact@example.com', 'new-hash')

      // Allow async operations
      await vi.runAllTimersAsync()

      // Should trigger network request (cache miss + hash mismatch)
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()
    })

    it('should fetch when contact has no avatar yet', async () => {
      mockXmppClientInstance.iqCaller.request.mockClear()

      const { getCachedAvatar } = await import('../../utils/avatarCache')
      vi.mocked(getCachedAvatar).mockResolvedValueOnce(null)

      // Mock roster store to return a contact without avatar
      mockStores.roster.getContact.mockReturnValue({
        jid: 'contact@example.com',
        name: 'Contact',
        subscription: 'both',
        presence: 'online',
      })

      // Emit avatarMetadataUpdate
      ;(xmppClient as any).emit('avatarMetadataUpdate', 'contact@example.com', 'first-hash')

      await vi.runAllTimersAsync()

      // Should trigger network request
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()
    })
  })

})
