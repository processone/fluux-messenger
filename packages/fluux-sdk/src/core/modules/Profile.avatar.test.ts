/**
 * XMPPClient Own Avatar Tests
 *
 * Tests for own avatar fetching via XEP-0084 (User Avatar):
 * - fetchOwnAvatar() - retrieve own avatar from PEP (metadata + data)
 * - Proper two-step process: fetch metadata first to get hash, then fetch data
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  type MockXmppClient,
  type MockStoreBindings,
} from '../test-utils'

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
  // Negative cache functions
  hasNoAvatar: vi.fn().mockResolvedValue(false),
  markNoAvatar: vi.fn().mockResolvedValue(undefined),
  clearNoAvatar: vi.fn().mockResolvedValue(undefined),
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
