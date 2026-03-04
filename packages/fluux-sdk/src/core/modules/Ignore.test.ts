/**
 * Ignore PEP Tests
 *
 * Tests for per-room ignored users storage via XEP-0223 (Private PubSub Storage):
 * - fetchIgnoredUsersForRoom() - retrieve ignored users for a specific room
 * - setIgnoredUsers() - store ignored users list in PEP with private access
 * - removeIgnoredUsers() - retract a room's ignored users item
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

describe('Ignore', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings

  beforeEach(() => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    mockStores = createMockStores()
    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('fetchIgnoredUsersForRoom', () => {
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

    it('should return ignored users when PEP item exists', async () => {
      const response = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:fluux:ignored-users:0' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'room@conference.example.com' },
                  children: [
                    {
                      name: 'ignored-users',
                      attrs: { xmlns: 'urn:xmpp:fluux:ignored-users:0' },
                      children: [
                        { name: 'user', attrs: { identifier: 'occ-123', name: 'Alice', jid: 'alice@example.com' } },
                        { name: 'user', attrs: { identifier: 'bob@example.com', name: 'Bob' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(response)

      const result = await xmppClient.ignore.fetchIgnoredUsersForRoom('room@conference.example.com')

      expect(result).toEqual([
        { identifier: 'occ-123', displayName: 'Alice', jid: 'alice@example.com' },
        { identifier: 'bob@example.com', displayName: 'Bob' },
      ])
    })

    it('should return empty array when PEP node does not exist', async () => {
      mockXmppClientInstance.iqCaller.request.mockRejectedValue(
        new Error('item-not-found')
      )

      const result = await xmppClient.ignore.fetchIgnoredUsersForRoom('room@conference.example.com')

      expect(result).toEqual([])
    })

    it('should return empty array when item has no ignored-users element', async () => {
      const emptyResponse = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:fluux:ignored-users:0' },
              children: [],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(emptyResponse)

      const result = await xmppClient.ignore.fetchIgnoredUsersForRoom('room@conference.example.com')

      expect(result).toEqual([])
    })

    it('should skip users with missing identifier or name', async () => {
      const response = createMockElement('iq', { type: 'result' }, [
        {
          name: 'pubsub',
          attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
          children: [
            {
              name: 'items',
              attrs: { node: 'urn:xmpp:fluux:ignored-users:0' },
              children: [
                {
                  name: 'item',
                  attrs: { id: 'room@conference.example.com' },
                  children: [
                    {
                      name: 'ignored-users',
                      attrs: { xmlns: 'urn:xmpp:fluux:ignored-users:0' },
                      children: [
                        { name: 'user', attrs: { identifier: 'valid-id', name: 'Valid' } },
                        { name: 'user', attrs: { name: 'NoIdentifier' } },
                        { name: 'user', attrs: { identifier: 'no-name' } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCaller.request.mockResolvedValue(response)

      const result = await xmppClient.ignore.fetchIgnoredUsersForRoom('room@conference.example.com')

      expect(result).toEqual([
        { identifier: 'valid-id', displayName: 'Valid' },
      ])
    })

    it('should return empty array when not connected', async () => {
      await xmppClient.disconnect()

      const result = await xmppClient.ignore.fetchIgnoredUsersForRoom('room@conference.example.com')

      expect(result).toEqual([])
    })
  })

  describe('setIgnoredUsers', () => {
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

    it('should publish ignored users with XEP-0223 options', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.ignore.setIgnoredUsers('room@conference.example.com', [
        { identifier: 'occ-123', displayName: 'Alice', jid: 'alice@example.com' },
        { identifier: 'bob@example.com', displayName: 'Bob' },
      ])

      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // Find the set call with pubsub publish
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

      // Find publish element with correct node
      const publish = pubsub.children.find((c: any) => c.name === 'publish')
      expect(publish).toBeDefined()
      expect(publish.attrs.node).toBe('urn:xmpp:fluux:ignored-users:0')

      // Find publish-options element (XEP-0223)
      const publishOptions = pubsub.children.find((c: any) => c.name === 'publish-options')
      expect(publishOptions).toBeDefined()
    })

    it('should include jid attribute when present', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.ignore.setIgnoredUsers('room@conference.example.com', [
        { identifier: 'occ-123', displayName: 'Alice', jid: 'alice@example.com' },
      ])

      // The xml() mock captures arguments — verify user element has jid attr
      const userCalls = mockXmlFn.mock.calls.filter((call: any) => call[0] === 'user')
      expect(userCalls.length).toBeGreaterThan(0)
      const userAttrs = userCalls[0][1] as Record<string, string>
      expect(userAttrs.identifier).toBe('occ-123')
      expect(userAttrs.name).toBe('Alice')
      expect(userAttrs.jid).toBe('alice@example.com')
    })

    it('should omit jid attribute when not present', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.ignore.setIgnoredUsers('room@conference.example.com', [
        { identifier: 'occ-456', displayName: 'Charlie' },
      ])

      const userCalls = mockXmlFn.mock.calls.filter((call: any) => call[0] === 'user')
      expect(userCalls.length).toBeGreaterThan(0)
      const userAttrs = userCalls[0][1] as Record<string, string>
      expect(userAttrs.identifier).toBe('occ-456')
      expect(userAttrs.name).toBe('Charlie')
      expect(userAttrs.jid).toBeUndefined()
    })

    it('should throw when not connected', async () => {
      await xmppClient.disconnect()

      await expect(
        xmppClient.ignore.setIgnoredUsers('room@conference.example.com', [
          { identifier: 'occ-123', displayName: 'Alice' },
        ])
      ).rejects.toThrow('Not connected')
    })
  })

  describe('removeIgnoredUsers', () => {
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

    it('should send retract IQ for the room', async () => {
      mockXmppClientInstance.iqCaller.request.mockResolvedValue(
        createMockElement('iq', { type: 'result' })
      )

      await xmppClient.ignore.removeIgnoredUsers('room@conference.example.com')

      expect(mockXmppClientInstance.iqCaller.request).toHaveBeenCalled()

      // Find the retract call
      const calls = mockXmppClientInstance.iqCaller.request.mock.calls
      const retractCall = calls.find((call: any) => {
        const arg = call[0]
        return arg.attrs?.type === 'set' &&
          arg.children?.some((c: any) =>
            c.name === 'pubsub' &&
            c.children?.some((p: any) => p.name === 'retract')
          )
      })

      expect(retractCall).toBeDefined()
      const callArg = retractCall![0]

      const pubsub = callArg.children.find((c: any) => c.name === 'pubsub')
      const retract = pubsub.children.find((c: any) => c.name === 'retract')
      expect(retract).toBeDefined()
      expect(retract.attrs.node).toBe('urn:xmpp:fluux:ignored-users:0')
    })

    it('should throw when not connected', async () => {
      await xmppClient.disconnect()

      await expect(
        xmppClient.ignore.removeIgnoredUsers('room@conference.example.com')
      ).rejects.toThrow('Not connected')
    })
  })
})
