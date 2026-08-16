/**
 * XMPPClient Password Tests
 *
 * Tests for password change via XEP-0077 (In-Band Registration):
 * - changePassword() - change user's password on the server
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

describe('XMPPClient Password', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    bindStoresForTesting(xmppClient, mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('changePassword', () => {
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
      // Clear mock calls from connect
      mockXmppClientInstance.iqCaller.request.mockClear()
    })

    it('should send password change IQ with correct structure', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.changePassword('newpassword123')

      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      const calls = mockXmppClientInstance.iqCaller.request.mock.calls
      expect(calls.length).toBe(1)

      const callArg = calls[0][0]
      expect(callArg.name).toBe('iq')
      expect(callArg.attrs.type).toBe('set')
      expect(callArg.attrs.to).toBe('example.com')

      // Find query element
      const query = callArg.children.find((c: any) => c.name === 'query')
      expect(query).toBeDefined()
      expect(query.attrs.xmlns).toBe('jabber:iq:register')

      // Find username element
      const username = query.children.find((c: any) => c.name === 'username')
      expect(username).toBeDefined()

      // Find password element
      const password = query.children.find((c: any) => c.name === 'password')
      expect(password).toBeDefined()
    })

    it('should use local part of JID as username', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.changePassword('newpassword123')

      const callArg = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      const query = callArg.children.find((c: any) => c.name === 'query')
      const username = query.children.find((c: any) => c.name === 'username')

      // The username should be 'user' (from user@example.com)
      expect(username.children[0]).toBe('user')
    })

    it('should send password to correct domain', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.changePassword('newpassword123')

      const callArg = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      expect(callArg.attrs.to).toBe('example.com')
    })

    it('should include new password in request', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.profile.changePassword('mynewsecretpassword')

      const callArg = mockXmppClientInstance.iqCaller.request.mock.calls[0][0]
      const query = callArg.children.find((c: any) => c.name === 'query')
      const password = query.children.find((c: any) => c.name === 'password')

      expect(password.children[0]).toBe('mynewsecretpassword')
    })

    it('should throw when not connected', async () => {
      await xmppClient.disconnect()

      await expect(xmppClient.profile.changePassword('newpassword'))
        .rejects.toThrow('Not connected')
    })

    it('should throw when server returns error', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('not-allowed')
      )

      await expect(xmppClient.profile.changePassword('newpassword'))
        .rejects.toThrow('not-allowed')
    })

    it('should throw when server returns forbidden error', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('forbidden')
      )

      await expect(xmppClient.profile.changePassword('newpassword'))
        .rejects.toThrow('forbidden')
    })

    it('should resolve successfully when server accepts password change', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await expect(xmppClient.profile.changePassword('newpassword'))
        .resolves.toBeUndefined()
    })
  })
})
