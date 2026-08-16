/**
 * XMPPClient Nickname Tests
 *
 * Tests for own nickname storage via XEP-0172 (User Nickname):
 * - fetchOwnNickname() - retrieve nickname from PEP
 * - publishOwnNickname() - store nickname in PEP
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient, bindStoresForTesting } from '../XMPPClient'
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
        _setInstance: (instance: MockXmppClient | any) => { clientInstance = instance },
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

describe('XMPPClient Nickname', () => {
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
    bindStoresForTesting(xmppClient, mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('fetchOwnNickname', () => {
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

    it('should update store when nickname exists in PEP', async () => {
      const nicknameResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'http://jabber.org/protocol/nick' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'current' },
                  children: [
                    {
                      name: 'nick',
                      attrs: { xmlns: 'http://jabber.org/protocol/nick' },
                      text: 'My Nickname'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(nicknameResponse)

      await xmppClient.profile.fetchOwnNickname()

      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-nickname', { nickname: 'My Nickname' })
    })

    it('should not update store when nickname is not set', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('item-not-found')
      )

      await xmppClient.profile.fetchOwnNickname()

      expect(emitSDKSpy).not.toHaveBeenCalledWith('connection:own-nickname', expect.anything())
    })
  })

  describe('publishOwnNickname', () => {
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

    it('should publish nickname to PEP', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.publishOwnNickname('New Nickname')

      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // Find the publishOwnNickname call (type='set' with pubsub publish)
      const calls = mockXmppClientInstance.iqCaller.request.mock.calls
      const setCall = calls.find((call: any) => {
        const arg = call[0]
        return arg.attrs?.type === 'set' &&
          arg.children?.some((c: any) => c.name === 'pubsub')
      })

      expect(setCall).toBeDefined()
      const callArg = setCall![0]
      expect(callArg.name).toBe('iq')
      expect(callArg.attrs.type).toBe('set')

      // Find pubsub element
      const pubsub = callArg.children.find((c: any) => c.name === 'pubsub')
      expect(pubsub).toBeDefined()

      // Find publish element
      const publish = pubsub.children.find((c: any) => c.name === 'publish')
      expect(publish).toBeDefined()
      expect(publish.attrs.node).toBe('http://jabber.org/protocol/nick')
    })

    it('should update local store after successful publish', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.publishOwnNickname('New Nickname')

      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-nickname', { nickname: 'New Nickname' })
    })

    it('should trim whitespace from nickname', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.publishOwnNickname('  Trimmed Nickname  ')

      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-nickname', { nickname: 'Trimmed Nickname' })
    })

    it('should throw when nickname is empty', async () => {
      await expect(xmppClient.profile.publishOwnNickname(''))
        .rejects.toThrow('Nickname cannot be empty')
    })

    it('should throw when nickname is only whitespace', async () => {
      await expect(xmppClient.profile.publishOwnNickname('   '))
        .rejects.toThrow('Nickname cannot be empty')
    })

    it('should throw when not connected', async () => {
      await xmppClient.disconnect()

      await expect(xmppClient.profile.publishOwnNickname('Test'))
        .rejects.toThrow('Not connected')
    })

    it('should handle server errors gracefully', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('forbidden')
      )

      await expect(xmppClient.profile.publishOwnNickname('Test'))
        .rejects.toThrow('forbidden')
    })
  })

  describe('fetchContactNickname', () => {
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

    it('should return nickname when contact has one set in PEP', async () => {
      const nicknameResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'http://jabber.org/protocol/nick' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'current' },
                  children: [
                    {
                      name: 'nick',
                      attrs: { xmlns: 'http://jabber.org/protocol/nick' },
                      text: 'Contact Nickname'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(nicknameResponse)

      const result = await xmppClient.profile.fetchContactNickname('contact@example.com')

      expect(result).toBe('Contact Nickname')
    })

    it('should NOT update roster store with contact nickname (regression test)', async () => {
      // This is the key regression test: fetchContactNickname should NOT overwrite
      // the roster name. The roster name is set by the local user and should be
      // preserved. The PEP nickname is the contact's self-published name.
      const nicknameResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'http://jabber.org/protocol/nick' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'current' },
                  children: [
                    {
                      name: 'nick',
                      attrs: { xmlns: 'http://jabber.org/protocol/nick' },
                      text: 'Contact PEP Nickname'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(nicknameResponse)

      await xmppClient.profile.fetchContactNickname('contact@example.com')

      // Roster store should NOT be updated - the roster name is set by the local user
      expect(mockStores.roster.updateContact).not.toHaveBeenCalled()
    })

    it('should return null when contact has no nickname set', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('item-not-found')
      )

      const result = await xmppClient.profile.fetchContactNickname('contact@example.com')

      expect(result).toBeNull()
    })

    it('should return null when PEP response has no nick element', async () => {
      const emptyResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'http://jabber.org/protocol/nick' },
              children: []
            }
          ]
        }
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResponse)

      const result = await xmppClient.profile.fetchContactNickname('contact@example.com')

      expect(result).toBeNull()
    })

    it('should send IQ to contact JID', async () => {
      const nicknameResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'http://jabber.org/protocol/nick' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'current' },
                  children: [
                    {
                      name: 'nick',
                      attrs: { xmlns: 'http://jabber.org/protocol/nick' },
                      text: 'Contact Nickname'
                    }
                  ]
                }
              ]
            }
          ]
        }
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(nicknameResponse)

      await xmppClient.profile.fetchContactNickname('contact@example.com')

      // Verify an IQ request was made
      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()
    })
  })

  describe('clearOwnNickname', () => {
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

    it('should send retract IQ to remove nickname', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.clearOwnNickname()

      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // Find the clearOwnNickname call (type='set' with pubsub retract)
      const calls = mockXmppClientInstance.iqCaller.request.mock.calls
      const retractCall = calls.find((call: any) => {
        const arg = call[0]
        return arg.attrs?.type === 'set' &&
          arg.children?.some((c: any) =>
            c.name === 'pubsub' &&
            c.children?.some((cc: any) => cc.name === 'retract')
          )
      })

      expect(retractCall).toBeDefined()
      const callArg = retractCall![0]
      expect(callArg.name).toBe('iq')
      expect(callArg.attrs.type).toBe('set')

      // Find pubsub element
      const pubsub = callArg.children.find((c: any) => c.name === 'pubsub')
      expect(pubsub).toBeDefined()

      // Find retract element
      const retract = pubsub.children.find((c: any) => c.name === 'retract')
      expect(retract).toBeDefined()
      expect(retract.attrs.node).toBe('http://jabber.org/protocol/nick')
    })

    it('should clear local store after successful retract', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.clearOwnNickname()

      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-nickname', { nickname: null })
    })

    it('should throw when not connected', async () => {
      await xmppClient.disconnect()

      await expect(xmppClient.profile.clearOwnNickname())
        .rejects.toThrow('Not connected')
    })

    it('should handle server errors gracefully', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('item-not-found')
      )

      await expect(xmppClient.profile.clearOwnNickname())
        .rejects.toThrow('item-not-found')
    })
  })
})
