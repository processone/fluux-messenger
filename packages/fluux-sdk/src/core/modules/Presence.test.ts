/**
 * XMPPClient Presence Tests
 *
 * Tests for presence handling: regular presence updates, presence errors,
 * subscription requests, presence preservation on reconnect, and MUC presence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  createMockRoom,
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

describe('XMPPClient Presence', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

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

  // Helper to connect the client before testing presence handling
  async function connectClient() {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    vi.clearAllMocks()
  }

  describe('regular presence updates', () => {
    it('should update roster with online presence (full JID, show, priority)', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/resource',
      }, [])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      // SDK event: roster:presence with show=null (meaning online), priority defaults to 0
      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', {
        fullJid: 'contact@example.com/resource',
        show: null, // null = online
        priority: 0,
        statusMessage: undefined,
        lastInteraction: undefined,
        client: undefined
      })
    })

    it('should update roster with away presence', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/mobile',
      }, [
        { name: 'show', text: 'away' },
      ])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', {
        fullJid: 'contact@example.com/mobile',
        show: 'away',
        priority: 0,
        statusMessage: undefined,
        lastInteraction: undefined,
        client: undefined
      })
    })

    it('should pass xa show value to store', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/desktop',
      }, [
        { name: 'show', text: 'xa' },
      ])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      // xa is passed directly, store handles mapping to PresenceStatus
      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', {
        fullJid: 'contact@example.com/desktop',
        show: 'xa',
        priority: 0,
        statusMessage: undefined,
        lastInteraction: undefined,
        client: undefined
      })
    })

    it('should update roster with dnd presence', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/work',
      }, [
        { name: 'show', text: 'dnd' },
      ])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', {
        fullJid: 'contact@example.com/work',
        show: 'dnd',
        priority: 0,
        statusMessage: undefined,
        lastInteraction: undefined,
        client: undefined
      })
    })

    it('should call removePresence for unavailable presence', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/resource',
        type: 'unavailable',
      }, [])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      // Unavailable emits roster:presence-offline, not roster:presence
      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence-offline', {
        fullJid: 'contact@example.com/resource'
      })
      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:presence', expect.anything())
    })

    it('should include status message when present', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/phone',
      }, [
        { name: 'show', text: 'away' },
        { name: 'status', text: 'In a meeting' },
      ])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', {
        fullJid: 'contact@example.com/phone',
        show: 'away',
        priority: 0,
        statusMessage: 'In a meeting',
        lastInteraction: undefined,
        client: undefined
      })
    })

    it('should parse and pass priority', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/mobile',
      }, [
        { name: 'priority', text: '50' },
      ])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', {
        fullJid: 'contact@example.com/mobile',
        show: null,
        priority: 50,
        statusMessage: undefined,
        lastInteraction: undefined,
        client: undefined
      })
    })

    it('should emit presence event with aggregated presence', async () => {
      await connectClient()
      const presenceHandler = vi.fn()
      xmppClient.on('presence', presenceHandler)

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/resource',
      }, [
        { name: 'status', text: 'Available' },
      ])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      // Event uses bare JID and aggregated presence from getContact
      expect(presenceHandler).toHaveBeenCalledWith(
        'contact@example.com',
        'online', // getContact returns undefined, so defaults to 'online'
        undefined // status comes from getContact
      )
    })

    it('should pass full JID with resource to updatePresence', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/very-long-resource-identifier',
      }, [])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      // Full JID is passed in SDK event (store extracts bare JID internally)
      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', {
        fullJid: 'contact@example.com/very-long-resource-identifier',
        show: null,
        priority: 0,
        statusMessage: undefined,
        lastInteraction: undefined,
        client: undefined
      })
    })

    it('should ignore presence without from attribute', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {}, [])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:presence', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:presence-offline', expect.anything())
    })

    it('should extract client name from caps element (XEP-0115)', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/mobile',
      }, [
        {
          name: 'c',
          attrs: {
            xmlns: 'http://jabber.org/protocol/caps',
            hash: 'sha-1',
            node: 'https://conversations.im',
            ver: 'abc123',
          },
        },
      ])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', {
        fullJid: 'contact@example.com/mobile',
        show: null,
        priority: 0,
        statusMessage: undefined,
        lastInteraction: undefined,
        client: 'Conversations' // Client name extracted from caps node
      })
    })

    it('should handle unknown caps node gracefully', async () => {
      await connectClient()

      const presenceStanza = createMockElement('presence', {
        from: 'contact@example.com/desktop',
      }, [
        {
          name: 'c',
          attrs: {
            xmlns: 'http://jabber.org/protocol/caps',
            hash: 'sha-1',
            node: 'https://unknown-client.example.org',
            ver: 'xyz789',
          },
        },
      ])

      mockXmppClientInstance._emit('stanza', presenceStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', {
        fullJid: 'contact@example.com/desktop',
        show: null,
        priority: 0,
        statusMessage: undefined,
        lastInteraction: undefined,
        client: 'Unknown-client.example.org' // Fallback to hostname
      })
    })
  })

  describe('presence errors', () => {
    it('should set presence error with text element', async () => {
      await connectClient()

      const errorStanza = createMockElement('presence', {
        from: 'contact@example.com/resource',
        type: 'error',
      }, [
        {
          name: 'error',
          attrs: { type: 'cancel' },
          children: [
            {
              name: 'text',
              attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' },
              text: 'User not found',
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence-error', {
        jid: 'contact@example.com',
        error: 'User not found'
      })
    })

    it('should set presence error from condition element when no text', async () => {
      await connectClient()

      const errorStanza = createMockElement('presence', {
        from: 'contact@example.com/resource',
        type: 'error',
      }, [
        {
          name: 'error',
          attrs: { type: 'cancel' },
          children: [
            {
              name: 'service-unavailable',
              attrs: { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' },
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence-error', {
        jid: 'contact@example.com',
        error: 'Service unavailable'
      })
    })

    it('should set undefined-condition error when no error details', async () => {
      await connectClient()

      const errorStanza = createMockElement('presence', {
        from: 'contact@example.com/resource',
        type: 'error',
      }, [
        { name: 'error', attrs: { type: 'cancel' } },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence-error', {
        jid: 'contact@example.com',
        error: 'Undefined condition'
      })
    })

    it('should emit Unknown error when presence has no error element', async () => {
      await connectClient()

      const errorStanza = createMockElement('presence', {
        from: 'contact@example.com/resource',
        type: 'error',
      }, [])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence-error', {
        jid: 'contact@example.com',
        error: 'Unknown error'
      })
    })

    it('should not update presence on error', async () => {
      await connectClient()

      const errorStanza = createMockElement('presence', {
        from: 'contact@example.com/resource',
        type: 'error',
      }, [
        { name: 'error', attrs: { type: 'cancel' } },
      ])

      mockXmppClientInstance._emit('stanza', errorStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:presence', expect.anything())
    })
  })

  describe('subscription requests', () => {
    it('should add subscription request to inbox for new contact', async () => {
      await connectClient()
      vi.mocked(mockStores.roster.hasContact).mockReturnValue(false)

      const subscribeStanza = createMockElement('presence', {
        from: 'newcontact@example.com',
        type: 'subscribe',
      }, [])

      mockXmppClientInstance._emit('stanza', subscribeStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('events:subscription-request', {
        from: 'newcontact@example.com'
      })
    })

    it('should auto-accept subscription from existing contact', async () => {
      await connectClient()
      vi.mocked(mockStores.roster.hasContact).mockReturnValue(true)

      const subscribeStanza = createMockElement('presence', {
        from: 'existingcontact@example.com',
        type: 'subscribe',
      }, [])

      mockXmppClientInstance._emit('stanza', subscribeStanza)

      // Should send subscribed response
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      // Should NOT add to inbox
      expect(mockStores.events.addSubscriptionRequest).not.toHaveBeenCalled()
    })

    it('should ignore subscribed presence type', async () => {
      await connectClient()

      const subscribedStanza = createMockElement('presence', {
        from: 'contact@example.com',
        type: 'subscribed',
      }, [])

      mockXmppClientInstance._emit('stanza', subscribedStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:presence', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('events:subscription-request', expect.anything())
    })

    it('should ignore unsubscribe presence type', async () => {
      await connectClient()

      const unsubscribeStanza = createMockElement('presence', {
        from: 'contact@example.com',
        type: 'unsubscribe',
      }, [])

      mockXmppClientInstance._emit('stanza', unsubscribeStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:presence', expect.anything())
    })

    it('should ignore unsubscribed presence type', async () => {
      await connectClient()

      const unsubscribedStanza = createMockElement('presence', {
        from: 'contact@example.com',
        type: 'unsubscribed',
      }, [])

      mockXmppClientInstance._emit('stanza', unsubscribedStanza)

      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:presence', expect.anything())
    })
  })

  describe('presence preservation on reconnect', () => {
    // Helper to wait for async presence sending (crypto.subtle.digest + multiple microtask cycles)
    // Uses multiple flush cycles to handle nested async operations reliably
    const waitForPresence = async () => {
      const flushOnce = () => new Promise(resolve => process.nextTick(resolve))
      // Multiple flush cycles to handle nested async operations in sendPresence
      for (let i = 0; i < 5; i++) {
        await flushOnce()
        await vi.advanceTimersByTimeAsync(10)
      }
    }

    it('should preserve DND presence on reconnect', async () => {
      // Set up mock to return DND presence
      mockStores.connection.getPresenceShow.mockReturnValue('dnd')
      mockStores.connection.getIsAutoAway.mockReturnValue(false)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForPresence()

      // Check that presence was sent with DND
      const sentCalls = mockXmppClientInstance.send.mock.calls
      const presenceCall = sentCalls.find(call => call[0].name === 'presence')
      expect(presenceCall).toBeDefined()

      const presenceStanza = presenceCall![0]
      const showElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'show')
      expect(showElement?.children?.[0]).toBe('dnd')
    })

    it('should default to online when stale away (isAutoAway=false) on reconnect', async () => {
      // Stale away: previous session had auto-away but isAutoAway is transient (false).
      // We can't distinguish from manual away, so we default to online to avoid
      // being stuck in 'away' on every reconnect.
      mockStores.connection.getPresenceShow.mockReturnValue('away')
      mockStores.connection.getIsAutoAway.mockReturnValue(false)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForPresence()

      const sentCalls = mockXmppClientInstance.send.mock.calls
      const presenceCall = sentCalls.find(call => call[0].name === 'presence')
      expect(presenceCall).toBeDefined()

      const presenceStanza = presenceCall![0]
      // Should NOT have show element (online presence has no show in XMPP)
      const showElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'show')
      expect(showElement).toBeUndefined()
    })

    it('should clear auto-away to online on reconnect', async () => {
      // Set up mock to return auto-away
      mockStores.connection.getPresenceShow.mockReturnValue('away')
      mockStores.connection.getIsAutoAway.mockReturnValue(true)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForPresence()

      const sentCalls = mockXmppClientInstance.send.mock.calls
      const presenceCall = sentCalls.find(call => call[0].name === 'presence')
      expect(presenceCall).toBeDefined()

      const presenceStanza = presenceCall![0]
      // Should NOT have show element (online presence has no show)
      const showElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'show')
      expect(showElement).toBeUndefined()

      // Note: sendInitialPresence no longer clears auto-away flag directly.
      // The presence machine is the authoritative source and will sync the correct
      // state to the store when user activity/wake detection triggers a machine transition.
    })

    it('should restore pre-auto-away DND presence when recovering from auto-away/sleep', async () => {
      // Set up mock: was in DND before sleep, now in auto-away
      mockStores.connection.getPresenceShow.mockReturnValue('away')
      mockStores.connection.getIsAutoAway.mockReturnValue(true)
      mockStores.connection.getPreAutoAwayState.mockReturnValue('dnd')
      mockStores.connection.getPreAutoAwayStatusMessage.mockReturnValue('Busy working')

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForPresence()

      const sentCalls = mockXmppClientInstance.send.mock.calls
      const presenceCall = sentCalls.find(call => call[0].name === 'presence')
      expect(presenceCall).toBeDefined()

      const presenceStanza = presenceCall![0]
      // Should restore DND presence
      const showElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'show')
      expect(showElement?.children?.[0]).toBe('dnd')

      // Should restore status message
      const statusElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'status')
      expect(statusElement?.children?.[0]).toBe('Busy working')

      // Note: sendInitialPresence no longer clears auto-away flags directly.
      // The presence machine is the authoritative source and will sync the correct
      // state to the store when user activity/wake detection triggers a machine transition.
    })

    it('should restore pre-auto-away presence when recovering from auto-away/sleep', async () => {
      // Set up mock: was manually away before idle timeout, now in auto-away
      mockStores.connection.getPresenceShow.mockReturnValue('away')
      mockStores.connection.getIsAutoAway.mockReturnValue(true)
      mockStores.connection.getPreAutoAwayState.mockReturnValue('away')
      mockStores.connection.getPreAutoAwayStatusMessage.mockReturnValue('In a meeting')

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForPresence()

      const sentCalls = mockXmppClientInstance.send.mock.calls
      const presenceCall = sentCalls.find(call => call[0].name === 'presence')
      expect(presenceCall).toBeDefined()

      const presenceStanza = presenceCall![0]
      // Should restore away presence
      const showElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'show')
      expect(showElement?.children?.[0]).toBe('away')

      // Should restore status message
      const statusElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'status')
      expect(statusElement?.children?.[0]).toBe('In a meeting')
    })

    it('should default to online when isAutoAway=false and no preAutoAwayState (stale away) on reconnect', async () => {
      // Set up mock: was online with no status before sleep
      mockStores.connection.getPresenceShow.mockReturnValue('away')
      mockStores.connection.getStatusMessage.mockReturnValue('Computer went to sleep...')
      mockStores.connection.getIsAutoAway.mockReturnValue(true)
      mockStores.connection.getPreAutoAwayState.mockReturnValue('online')
      mockStores.connection.getPreAutoAwayStatusMessage.mockReturnValue(null)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForPresence()

      const sentCalls = mockXmppClientInstance.send.mock.calls
      const presenceCall = sentCalls.find(call => call[0].name === 'presence')
      expect(presenceCall).toBeDefined()

      const presenceStanza = presenceCall![0]
      // Should NOT have show element (online)
      const showElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'show')
      expect(showElement).toBeUndefined()

      // Should NOT include the sleep status message, since saved was null
      const statusElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'status')
      expect(statusElement).toBeUndefined()
    })

    it('should send online presence when status was online', async () => {
      // Set up mock to return online
      mockStores.connection.getPresenceShow.mockReturnValue('online')
      mockStores.connection.getIsAutoAway.mockReturnValue(false)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'password',
        server: 'wss://example.com/ws',
      })

      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForPresence()

      const sentCalls = mockXmppClientInstance.send.mock.calls
      const presenceCall = sentCalls.find(call => call[0].name === 'presence')
      expect(presenceCall).toBeDefined()

      const presenceStanza = presenceCall![0]
      // Should NOT have show element (online presence has no show)
      const showElement = presenceStanza.children.find((c: any) => typeof c === 'object' && c?.name === 'show')
      expect(showElement).toBeUndefined()
    })
  })

  describe('MUC presence handling', () => {
    it('should parse show element from MUC presence and store in occupant', async () => {
      await connectClient()

      // Emit MUC presence with show=away
      const mucPresence = createMockElement('presence', {
        from: 'room@conference.example.com/someuser',
      }, [
        { name: 'show', text: 'away' },
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', mucPresence)

      // Verify SDK event was emitted with the show field
      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-joined', {
        roomJid: 'room@conference.example.com',
        occupant: expect.objectContaining({
          nick: 'someuser',
          affiliation: 'member',
          role: 'participant',
          show: 'away',
        })
      })
    })

    it('should parse show=dnd from MUC presence', async () => {
      await connectClient()

      const mucPresence = createMockElement('presence', {
        from: 'room@conference.example.com/busyuser',
      }, [
        { name: 'show', text: 'dnd' },
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'none', role: 'visitor' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', mucPresence)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-joined', {
        roomJid: 'room@conference.example.com',
        occupant: expect.objectContaining({
          nick: 'busyuser',
          show: 'dnd',
        })
      })
    })

    it('should set show to undefined when no show element present (online)', async () => {
      await connectClient()

      // MUC presence without show element (means online/available)
      const mucPresence = createMockElement('presence', {
        from: 'room@conference.example.com/onlineuser',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', mucPresence)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-joined', {
        roomJid: 'room@conference.example.com',
        occupant: expect.objectContaining({
          nick: 'onlineuser',
          show: undefined,
        })
      })
    })

    it('should parse show=xa (extended away) from MUC presence', async () => {
      await connectClient()

      const mucPresence = createMockElement('presence', {
        from: 'room@conference.example.com/xauser',
      }, [
        { name: 'show', text: 'xa' },
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', mucPresence)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-joined', {
        roomJid: 'room@conference.example.com',
        occupant: expect.objectContaining({
          nick: 'xauser',
          show: 'xa',
        })
      })
    })

    it('should trigger room avatar fetch on self-presence when room has no avatar', async () => {
      await connectClient()

      // Mock room without avatar
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          nickname: 'testuser',
          joined: false,
          isBookmarked: false,
          avatar: undefined,
        })
      )

      // Mock IQ response for vCard - return empty vCard (no avatar)
      mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(
        createMockElement('iq', { type: 'result' }, [
          {
            name: 'vCard',
            attrs: { xmlns: 'vcard-temp' },
            children: [],
          },
        ])
      )

      // Self-presence with status code 110
      const selfPresence = createMockElement('presence', {
        from: 'room@conference.example.com/testuser',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
            { name: 'status', attrs: { code: '110' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', selfPresence)

      // Wait for async avatar fetch to be triggered
      await vi.waitFor(() => {
        const vCardCalls = mockXmppClientInstance.iqCaller.request.mock.calls.filter(
          (call: any) => {
            const stanza = call[0]
            return stanza?.attrs?.to === 'room@conference.example.com' &&
              stanza?.children?.some((c: any) => c.name === 'vCard')
          }
        )
        expect(vCardCalls.length).toBeGreaterThan(0)
      }, { timeout: 1000 })
    })

    it('should not fetch room avatar if room already has one with presence info', async () => {
      await connectClient()

      // Clear any previous calls from connection
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock room WITH avatar and avatarFromPresence set
      // This simulates: room presence arrived with vcard update
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          nickname: 'testuser',
          joined: false,
          isBookmarked: true,
          avatar: 'blob:existing-avatar',
          avatarHash: 'abc123',
          avatarFromPresence: true, // Got authoritative info from presence
        })
      )

      // Self-presence with status code 110
      const selfPresence = createMockElement('presence', {
        from: 'room@conference.example.com/testuser',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'owner', role: 'moderator' } },
            { name: 'status', attrs: { code: '110' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', selfPresence)

      // Give a tick for any async operations to start
      await new Promise(resolve => process.nextTick(resolve))

      // Should NOT have sent vCard request since room already has avatar from presence
      const vCardRequests = mockXmppClientInstance.iqCaller.request.mock.calls.filter(
        (call: any) => call[0]?.children?.some((c: any) => c.name === 'vCard')
      )
      expect(vCardRequests.length).toBe(0)
    })

    it('should parse XEP-0317 hats from MUC presence', async () => {
      await connectClient()

      // MUC presence with hats
      const mucPresence = createMockElement('presence', {
        from: 'room@conference.example.com/speaker',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
          ],
        },
        {
          name: 'hats',
          attrs: { xmlns: 'urn:xmpp:hats:0' },
          children: [
            { name: 'hat', attrs: { uri: 'http://example.com/hats#speaker', title: 'Speaker', hue: '120.5' } },
            { name: 'hat', attrs: { uri: 'http://example.com/hats#vip', title: 'VIP' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', mucPresence)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-joined', {
        roomJid: 'room@conference.example.com',
        occupant: expect.objectContaining({
          nick: 'speaker',
          hats: [
            { uri: 'http://example.com/hats#speaker', title: 'Speaker', hue: 120.5 },
            { uri: 'http://example.com/hats#vip', title: 'VIP', hue: undefined },
          ],
        })
      })
    })

    it('should set hats to undefined when no hats element present', async () => {
      await connectClient()

      // MUC presence without hats element
      const mucPresence = createMockElement('presence', {
        from: 'room@conference.example.com/regularuser',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', mucPresence)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-joined', {
        roomJid: 'room@conference.example.com',
        occupant: expect.objectContaining({
          nick: 'regularuser',
          hats: undefined,
        })
      })
    })

    it('should filter out invalid hats missing uri or title', async () => {
      await connectClient()

      // MUC presence with some invalid hats
      const mucPresence = createMockElement('presence', {
        from: 'room@conference.example.com/hatuser',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
          ],
        },
        {
          name: 'hats',
          attrs: { xmlns: 'urn:xmpp:hats:0' },
          children: [
            { name: 'hat', attrs: { uri: 'http://example.com/hats#valid', title: 'Valid Hat' } },
            { name: 'hat', attrs: { uri: 'http://example.com/hats#nolabel' } }, // Missing title
            { name: 'hat', attrs: { title: 'No URI' } }, // Missing uri
            { name: 'hat', attrs: {} }, // Missing both
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', mucPresence)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:occupant-joined', {
        roomJid: 'room@conference.example.com',
        occupant: expect.objectContaining({
          nick: 'hatuser',
          hats: [
            { uri: 'http://example.com/hats#valid', title: 'Valid Hat', hue: undefined },
          ],
        })
      })
    })

    it('should NOT use occupant vcard-temp:x:update as room avatar', async () => {
      // Occupant presence contains the OCCUPANT's personal avatar, not the room's avatar.
      // Room avatar updates come only from room bare JID presence (without /nick).
      await connectClient()

      // Clear previous calls
      mockStores.room.updateRoom.mockClear()
      mockXmppClientInstance.iqCaller.request.mockClear()

      // MUC occupant presence with vcard-temp:x:update (occupant's personal avatar)
      const occupantPresence = createMockElement('presence', {
        from: 'room@conference.example.com/someuser',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
          ],
        },
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'occupant-personal-avatar-hash' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', occupantPresence)

      // Give time for any async operations
      await new Promise(resolve => process.nextTick(resolve))

      // Should NOT have triggered room avatar update
      // (occupant's avatar should not be confused with room's avatar)
      const vCardCalls = mockXmppClientInstance.iqCaller.request.mock.calls.filter(
        (call: any) => {
          const stanza = call[0]
          return stanza?.attrs?.to === 'room@conference.example.com' &&
            stanza?.children?.some((c: any) => c.name === 'vCard')
        }
      )
      expect(vCardCalls.length).toBe(0)
    })

    it('should clear room avatar from room bare JID presence with empty photo', async () => {
      await connectClient()

      // Mock room WITH existing avatar
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          nickname: 'testuser',
          joined: true,
          isBookmarked: true,
          avatar: 'blob:existing-avatar',
          avatarHash: 'oldavatarhash123',
        })
      )

      // Clear previous calls
      mockStores.room.updateRoom.mockClear()

      // Room bare JID presence (without /nick) with empty photo = avatar deleted
      // Note: This presence does NOT have MUC#user element, so it's handled as regular presence
      const roomBarePresence = createMockElement('presence', {
        from: 'room@conference.example.com', // Bare JID, no nick
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo' }, // Empty photo = avatar removed
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', roomBarePresence)

      // Wait for async avatar clearing
      await vi.waitFor(() => {
        expect(emitSDKSpy).toHaveBeenCalledWith('room:updated', {
          roomJid: 'room@conference.example.com',
          updates: expect.objectContaining({
            avatar: undefined,
            avatarHash: undefined,
          })
        })
      }, { timeout: 1000 })
    })

    it('should update room avatar from room bare JID presence with photo hash', async () => {
      await connectClient()

      // Mock room with no avatar
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          nickname: 'testuser',
          joined: true,
          isBookmarked: true,
          avatar: undefined,
          avatarHash: undefined,
        })
      )

      // Clear previous calls
      mockStores.room.updateRoom.mockClear()
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Mock vCard fetch response
      mockXmppClientInstance.iqCaller.request.mockResolvedValueOnce(
        createMockElement('iq', { type: 'result' }, [
          {
            name: 'vCard',
            attrs: { xmlns: 'vcard-temp' },
            children: [
              {
                name: 'PHOTO',
                children: [
                  { name: 'TYPE', text: 'image/png' },
                  { name: 'BINVAL', text: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
                ],
              },
            ],
          },
        ])
      )

      // Room bare JID presence (without /nick) with new photo hash
      const roomBarePresence = createMockElement('presence', {
        from: 'room@conference.example.com', // Bare JID, no nick
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'new-room-avatar-hash' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', roomBarePresence)

      // Wait for vCard fetch to be triggered
      await vi.waitFor(() => {
        const vCardCalls = mockXmppClientInstance.iqCaller.request.mock.calls.filter(
          (call: any) => {
            const stanza = call[0]
            return stanza?.attrs?.to === 'room@conference.example.com' &&
              stanza?.children?.some((c: any) => c.name === 'vCard')
          }
        )
        expect(vCardCalls.length).toBeGreaterThan(0)
      }, { timeout: 1000 })
    })

    it('should set avatarFromPresence flag when receiving room avatar update from presence', async () => {
      await connectClient()

      // Mock room with no avatar
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          nickname: 'testuser',
          joined: true,
          isBookmarked: true,
          avatar: undefined,
          avatarHash: undefined,
        })
      )

      // Clear previous calls
      mockStores.room.updateRoom.mockClear()

      // Room bare JID presence with empty photo (avatar deleted)
      const roomBarePresence = createMockElement('presence', {
        from: 'room@conference.example.com',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo' }, // Empty photo = avatar removed
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', roomBarePresence)

      // Wait for async processing
      await vi.waitFor(() => {
        expect(emitSDKSpy).toHaveBeenCalledWith('room:updated', {
          roomJid: 'room@conference.example.com',
          updates: expect.objectContaining({
            avatar: undefined,
            avatarFromPresence: true, // Flag should be set
          })
        })
      }, { timeout: 1000 })
    })

    it('should NOT trigger proactive avatar fetch when avatarFromPresence is set', async () => {
      await connectClient()

      // Mock room where presence has already set avatarFromPresence = true
      // This simulates the case where room bare JID presence arrived first and cleared the avatar
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          nickname: 'testuser',
          joined: false,
          isBookmarked: true,
          avatar: undefined, // Avatar was cleared by presence
          avatarHash: undefined,
          avatarFromPresence: true, // Flag set by presence - this prevents proactive fetch
        })
      )

      // Clear previous IQ calls
      mockXmppClientInstance.iqCaller.request.mockClear()

      // Simulate self-presence when joining room (with status code 110)
      // This would normally trigger proactive avatar fetch, but avatarFromPresence should prevent it
      const selfPresence = createMockElement('presence', {
        from: 'room@conference.example.com/testuser',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            { name: 'item', attrs: { affiliation: 'member', role: 'participant' } },
            { name: 'status', attrs: { code: '110' } }, // Self-presence indicator
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', selfPresence)

      // Advance timers to allow any async operations to complete
      await vi.advanceTimersByTimeAsync(100)

      // Verify NO vCard fetch was triggered (because avatarFromPresence is true)
      const vCardCalls = mockXmppClientInstance.iqCaller.request.mock.calls.filter(
        (call: any) => {
          const stanza = call[0]
          return stanza?.attrs?.to === 'room@conference.example.com' &&
            stanza?.children?.some((c: any) => c.name === 'vCard')
        }
      )
      expect(vCardCalls.length).toBe(0)
    })

    it('should clear cached avatar when room presence has no vcard-temp:x:update', async () => {
      await connectClient()

      // Mock room with cached avatar (from previous session)
      mockStores.room.getRoom.mockReturnValue(
        createMockRoom('room@conference.example.com', {
          name: 'Test Room',
          nickname: 'testuser',
          joined: false,
          isBookmarked: true,
          avatar: 'blob:stale-cached-avatar',
          avatarHash: 'stale-hash',
          avatarFromPresence: false, // Not set from presence yet
        })
      )

      // Room bare JID presence WITHOUT vcard-temp:x:update
      // This indicates the room doesn't advertise avatar info
      const roomPresence = createMockElement('presence', {
        from: 'room@conference.example.com',
      }, [
        {
          name: 'c',
          attrs: { xmlns: 'http://jabber.org/protocol/caps', ver: 'abc123', node: 'http://example.com', hash: 'sha-1' },
        },
        // No vcard-temp:x:update element!
      ])

      mockXmppClientInstance._emit('stanza', roomPresence)

      // Give a tick for async operations
      await new Promise(resolve => process.nextTick(resolve))

      // Should clear the avatar (set to null with avatarFromPresence=true)
      expect(emitSDKSpy).toHaveBeenCalledWith('room:updated', {
        roomJid: 'room@conference.example.com',
        updates: expect.objectContaining({
          avatar: undefined,
          avatarFromPresence: true,
        })
      })
    })
  })

  describe('presence probes on SM resume', () => {
    // Helper to wait for async operations
    const waitForAsync = async () => {
      const flushOnce = () => new Promise(resolve => process.nextTick(resolve))
      for (let i = 0; i < 5; i++) {
        await flushOnce()
        await vi.advanceTimersByTimeAsync(10)
      }
    }

    it('should send presence probes for offline contacts after SM resume', async () => {
      // Set up offline contacts
      const offlineContacts = [
        { jid: 'contact1@example.com', name: 'Contact 1', presence: 'offline' as const, subscription: 'both' as const, groups: [] },
        { jid: 'contact2@example.com', name: 'Contact 2', presence: 'offline' as const, subscription: 'both' as const, groups: [] },
      ]
      vi.mocked(mockStores.roster.sortedContacts).mockReturnValue(offlineContacts)

      // Connect with SM state (simulates resume)
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-session-123', inbound: 5 },
        skipDiscovery: true,
      })

      // Emit 'resumed' event (SM resume successful)
      mockXmppClientInstance._emitSM('resumed')
      await connectPromise
      await waitForAsync()

      // Should have sent presence probes for offline contacts
      const sentCalls = mockXmppClientInstance.send.mock.calls
      const probeStanzas = sentCalls.filter(
        (call: any) => call[0].name === 'presence' && call[0].attrs?.type === 'probe'
      )

      expect(probeStanzas.length).toBe(2)
      expect(probeStanzas[0][0].attrs.to).toBe('contact1@example.com')
      expect(probeStanzas[1][0].attrs.to).toBe('contact2@example.com')
    })

    it('should not send presence probes when no offline contacts', async () => {
      // No offline contacts
      vi.mocked(mockStores.roster.getOfflineContacts).mockReturnValue([])

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        smState: { id: 'sm-session-123', inbound: 5 },
        skipDiscovery: true,
      })

      mockXmppClientInstance._emitSM('resumed')
      await connectPromise
      await waitForAsync()

      // Should not have sent any probes
      const sentCalls = mockXmppClientInstance.send.mock.calls
      const probeStanzas = sentCalls.filter(
        (call: any) => call[0].name === 'presence' && call[0].attrs?.type === 'probe'
      )

      expect(probeStanzas.length).toBe(0)
    })

    it('should not send presence probes on new session (non-SM resume)', async () => {
      // Set up offline contacts
      const offlineContacts = [
        { jid: 'contact1@example.com', name: 'Contact 1', presence: 'offline' as const, subscription: 'both' as const },
      ]
      vi.mocked(mockStores.roster.getOfflineContacts).mockReturnValue(offlineContacts)

      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
        // No smState = new session
      })

      // Emit 'online' event (new session, not resumed)
      mockXmppClientInstance._emit('online')
      await connectPromise
      await waitForAsync()

      // Should NOT have sent presence probes (new session gets roster push)
      const sentCalls = mockXmppClientInstance.send.mock.calls
      const probeStanzas = sentCalls.filter(
        (call: any) => call[0].name === 'presence' && call[0].attrs?.type === 'probe'
      )

      expect(probeStanzas.length).toBe(0)
    })
  })

  describe('self-presence (other connected devices)', () => {
    it('should track other resource when receiving presence from own JID with different resource', async () => {
      await connectClient()

      // Mock getJid to return our own full JID
      mockStores.connection.getJid.mockReturnValue('user@example.com/desktop')

      const selfPresence = createMockElement('presence', {
        from: 'user@example.com/mobile',  // Same bare JID, different resource
      }, [
        { name: 'show', text: 'away' },
        { name: 'status', text: 'On the go' },
        { name: 'priority', text: '10' },
        {
          name: 'c',
          attrs: {
            xmlns: 'http://jabber.org/protocol/caps',
            hash: 'sha-1',
            node: 'https://conversations.im',
            ver: 'abc123',
          },
        },
      ])

      mockXmppClientInstance._emit('stanza', selfPresence)

      // Should have emitted connection:own-resource event
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-resource', {
        resource: 'mobile',
        show: 'away',
        priority: 10,
        status: 'On the go',
        lastInteraction: undefined,
        client: 'Conversations',
      })

      // Should NOT have emitted roster:presence event
      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:presence', expect.anything())
    })

    it('should remove resource when receiving unavailable presence from own JID', async () => {
      await connectClient()

      // Mock getJid to return our own full JID
      mockStores.connection.getJid.mockReturnValue('user@example.com/desktop')

      const unavailablePresence = createMockElement('presence', {
        from: 'user@example.com/mobile',
        type: 'unavailable',
      }, [])

      mockXmppClientInstance._emit('stanza', unavailablePresence)

      // Should have emitted connection:own-resource-offline event
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-resource-offline', { resource: 'mobile' })

      // Should NOT have emitted roster:presence-offline event
      expect(emitSDKSpy).not.toHaveBeenCalledWith('roster:presence-offline', expect.anything())
    })

    it('should track online resource (no show element)', async () => {
      await connectClient()

      mockStores.connection.getJid.mockReturnValue('user@example.com/desktop')

      const selfPresence = createMockElement('presence', {
        from: 'user@example.com/tablet',
      }, [
        { name: 'priority', text: '25' },
      ])

      mockXmppClientInstance._emit('stanza', selfPresence)

      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-resource', {
        resource: 'tablet',
        show: null,  // No show = online
        priority: 25,
        status: undefined,
        lastInteraction: undefined,
        client: undefined,
      })
    })

    it('should NOT track presence from same resource as self', async () => {
      await connectClient()

      // Mock getJid to return our own full JID
      mockStores.connection.getJid.mockReturnValue('user@example.com/desktop')

      // Presence from same resource (reflection of our own presence)
      const selfPresence = createMockElement('presence', {
        from: 'user@example.com/desktop',  // Same resource
      }, [])

      mockXmppClientInstance._emit('stanza', selfPresence)

      // Should NOT track this as another resource (no connection:own-resource event)
      expect(emitSDKSpy).not.toHaveBeenCalledWith('connection:own-resource', expect.anything())
      // Should treat it as regular presence (roster:presence event emitted)
      expect(emitSDKSpy).toHaveBeenCalledWith('roster:presence', expect.anything())
    })

    it('should parse XEP-0319 idle time for own resource', async () => {
      await connectClient()

      mockStores.connection.getJid.mockReturnValue('user@example.com/desktop')

      const idlePresence = createMockElement('presence', {
        from: 'user@example.com/laptop',
      }, [
        { name: 'show', text: 'xa' },
        {
          name: 'idle',
          attrs: {
            xmlns: 'urn:xmpp:idle:1',
            since: '2026-01-14T12:00:00Z',
          },
        },
      ])

      mockXmppClientInstance._emit('stanza', idlePresence)

      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-resource', {
        resource: 'laptop',
        show: 'xa',
        priority: 0,
        status: undefined,
        lastInteraction: expect.any(Date),
        client: undefined,
      })

      // Verify the date was parsed correctly
      const ownResourceCall = emitSDKSpy.mock.calls.find(
        call => call[0] === 'connection:own-resource'
      )
      const lastInteraction = (ownResourceCall?.[1] as { lastInteraction: Date })?.lastInteraction
      expect(lastInteraction?.toISOString()).toBe('2026-01-14T12:00:00.000Z')
    })

    it('should NOT emit pubsub event for own vcard-temp:x:update', async () => {
      await connectClient()

      mockStores.connection.getJid.mockReturnValue('user@example.com/desktop')

      // Self-presence with vcard-temp:x:update (avatar change notification)
      const selfPresence = createMockElement('presence', {
        from: 'user@example.com/mobile',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'abc123hash' },
          ],
        },
      ])

      // Spy on emit (using 'as any' since emit is internal)
      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      mockXmppClientInstance._emit('stanza', selfPresence)

      // Should NOT have emitted pubsubEvent for self
      const pubsubCalls = emitSpy.mock.calls.filter((call: unknown[]) => call[0] === 'pubsubEvent')
      expect(pubsubCalls.length).toBe(0)

      // Should still track the resource via SDK event
      expect(emitSDKSpy).toHaveBeenCalledWith('connection:own-resource', expect.objectContaining({
        resource: 'mobile',
      }))
    })
  })

  describe('MUC presence propagation', () => {
    it('should include current presence show when joining a room while DND', async () => {
      await connectClient()

      // Set user presence to DND
      mockStores.connection.getPresenceShow.mockReturnValue('dnd')
      mockStores.connection.getStatusMessage.mockReturnValue('Busy')

      // Join a room
      await xmppClient.muc.joinRoom('room@conference.example.com', 'testnick')

      // Find the join presence stanza
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const joinPresence = sendCalls.find((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to === 'room@conference.example.com/testnick'
      })

      expect(joinPresence).toBeDefined()
      const stanza = joinPresence![0]

      // Should include show=dnd
      const showChild = stanza.children?.find((c: any) => c.name === 'show')
      expect(showChild).toBeDefined()
      expect(showChild.children[0]).toBe('dnd')

      // Should include status
      const statusChild = stanza.children?.find((c: any) => c.name === 'status')
      expect(statusChild).toBeDefined()
      expect(statusChild.children[0]).toBe('Busy')
    })

    it('should include current presence show when joining a room while away', async () => {
      await connectClient()

      // Set user presence to away
      mockStores.connection.getPresenceShow.mockReturnValue('away')
      mockStores.connection.getStatusMessage.mockReturnValue(null)

      // Join a room
      await xmppClient.muc.joinRoom('room@conference.example.com', 'testnick')

      // Find the join presence stanza
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const joinPresence = sendCalls.find((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to === 'room@conference.example.com/testnick'
      })

      expect(joinPresence).toBeDefined()
      const stanza = joinPresence![0]

      // Should include show=away
      const showChild = stanza.children?.find((c: any) => c.name === 'show')
      expect(showChild).toBeDefined()
      expect(showChild.children[0]).toBe('away')
    })

    it('should not include show element when joining a room while online', async () => {
      await connectClient()

      // Set user presence to online (default)
      mockStores.connection.getPresenceShow.mockReturnValue('online')
      mockStores.connection.getStatusMessage.mockReturnValue(null)

      // Join a room
      await xmppClient.muc.joinRoom('room@conference.example.com', 'testnick')

      // Find the join presence stanza
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const joinPresence = sendCalls.find((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to === 'room@conference.example.com/testnick'
      })

      expect(joinPresence).toBeDefined()
      const stanza = joinPresence![0]

      // Should NOT include show element (online = no show)
      const showChild = stanza.children?.find((c: any) => c.name === 'show')
      expect(showChild).toBeUndefined()
    })

    it('should send presence to all joined rooms when changing presence to DND', async () => {
      await connectClient()

      // Set up joined rooms
      const joinedRooms = [
        createMockRoom('room1@conference.example.com', { name: 'Room 1', nickname: 'user', joined: true }),
        createMockRoom('room2@conference.example.com', { name: 'Room 2', nickname: 'user', joined: true }),
      ]
      mockStores.room.joinedRooms.mockReturnValue(joinedRooms)

      // Clear previous send calls
      mockXmppClientInstance.send.mockClear()

      // Change presence to DND
      await xmppClient.roster.setPresence('dnd', 'In a meeting')

      // Should have sent presence to each joined room + broadcast
      const sendCalls = mockXmppClientInstance.send.mock.calls

      // Broadcast presence (no 'to' attribute)
      const broadcastPresence = sendCalls.find((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' && !stanza?.attrs?.to
      })
      expect(broadcastPresence).toBeDefined()

      // Room 1 presence
      const room1Presence = sendCalls.find((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to === 'room1@conference.example.com/user'
      })
      expect(room1Presence).toBeDefined()
      const room1Stanza = room1Presence![0]
      const room1Show = room1Stanza.children?.find((c: any) => c.name === 'show')
      expect(room1Show?.children[0]).toBe('dnd')

      // Room 2 presence
      const room2Presence = sendCalls.find((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to === 'room2@conference.example.com/user'
      })
      expect(room2Presence).toBeDefined()
    })

    it('should not send room presence for rooms not actively joined', async () => {
      await connectClient()

      // Set up rooms - one joined, one not joined (bookmarked but not active)
      const joinedRooms = [
        createMockRoom('room1@conference.example.com', { name: 'Room 1', nickname: 'user', joined: true }),
        createMockRoom('room2@conference.example.com', { name: 'Room 2', nickname: 'user', joined: false }),
      ]
      mockStores.room.joinedRooms.mockReturnValue(joinedRooms)

      // Clear previous send calls
      mockXmppClientInstance.send.mockClear()

      // Change presence
      await xmppClient.roster.setPresence('away')

      const sendCalls = mockXmppClientInstance.send.mock.calls

      // Should have sent to room1 (joined)
      const room1Presence = sendCalls.find((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to === 'room1@conference.example.com/user'
      })
      expect(room1Presence).toBeDefined()

      // Should NOT have sent to room2 (not joined)
      const room2Presence = sendCalls.find((call: any) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to === 'room2@conference.example.com/user'
      })
      expect(room2Presence).toBeUndefined()
    })
  })

  describe('setupPresenceSync', () => {
    // Helper to create a mock presence actor
    function createMockPresenceActor() {
      let subscriber: ((state: any) => void) | null = null
      const actor = {
        subscribe: vi.fn((callback: (state: any) => void) => {
          subscriber = callback
          return { unsubscribe: vi.fn() }
        }),
        // Helper to emit state changes for testing
        _emitState: (state: any) => {
          if (subscriber) subscriber(state)
        },
      }
      return actor
    }

    // Helper to create a state object mimicking XState structure
    function createPresenceState(value: string | object, context: Record<string, any> = {}) {
      return {
        value,
        context: {
          statusMessage: null,
          preAutoAwayState: null,
          preAutoAwayStatusMessage: null,
          idleSince: null,
          ...context,
        },
      }
    }

    it('should subscribe to the presence actor', async () => {
      await connectClient()
      const mockActor = createMockPresenceActor()

      xmppClient.setupPresenceSync(mockActor as any)

      expect(mockActor.subscribe).toHaveBeenCalledTimes(1)
    })

    it('should return an unsubscribe function', async () => {
      await connectClient()
      const mockActor = createMockPresenceActor()
      const mockUnsubscribe = vi.fn()
      mockActor.subscribe.mockReturnValue({ unsubscribe: mockUnsubscribe })

      const unsubscribe = xmppClient.setupPresenceSync(mockActor as any)
      unsubscribe()

      expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
    })

    it('should skip the initial state update', async () => {
      await connectClient()
      const mockActor = createMockPresenceActor()
      mockStores.connection.getStatus.mockReturnValue('online')

      // Spy on the roster.setPresence method
      const setPresenceSpy = vi.spyOn(xmppClient.roster, 'setPresence').mockResolvedValue()

      xmppClient.setupPresenceSync(mockActor as any)

      // Emit initial state
      mockActor._emitState(createPresenceState({ connected: 'userOnline' }))

      // Should not have called setPresence (initial is skipped)
      expect(setPresenceSpy).not.toHaveBeenCalled()

      setPresenceSpy.mockRestore()
    })

    it('should send presence on state change after initial', async () => {
      await connectClient()
      const mockActor = createMockPresenceActor()
      mockStores.connection.getStatus.mockReturnValue('online')

      // Spy on the roster.setPresence method
      const setPresenceSpy = vi.spyOn(xmppClient.roster, 'setPresence').mockResolvedValue()

      xmppClient.setupPresenceSync(mockActor as any)

      // Initial state (skipped)
      mockActor._emitState(createPresenceState({ connected: 'userOnline' }))

      // State change to away
      mockActor._emitState(createPresenceState({ connected: 'userAway' }))

      // Should have called setPresence with 'away'
      expect(setPresenceSpy).toHaveBeenCalledWith('away', undefined)

      setPresenceSpy.mockRestore()
    })

    it('should not send presence when not connected', async () => {
      await connectClient()
      const mockActor = createMockPresenceActor()
      mockStores.connection.getStatus.mockReturnValue('disconnected')

      // Spy on the roster.setPresence method
      const setPresenceSpy = vi.spyOn(xmppClient.roster, 'setPresence').mockResolvedValue()

      xmppClient.setupPresenceSync(mockActor as any)

      // Initial state
      mockActor._emitState(createPresenceState({ connected: 'userOnline' }))
      // State change
      mockActor._emitState(createPresenceState({ connected: 'userAway' }))

      // Should not have called setPresence (not connected)
      expect(setPresenceSpy).not.toHaveBeenCalled()

      setPresenceSpy.mockRestore()
    })

    it('should not send duplicate presence when state is the same', async () => {
      await connectClient()
      const mockActor = createMockPresenceActor()
      mockStores.connection.getStatus.mockReturnValue('online')

      // Spy on the roster.setPresence method
      const setPresenceSpy = vi.spyOn(xmppClient.roster, 'setPresence').mockResolvedValue()

      xmppClient.setupPresenceSync(mockActor as any)

      // Initial state (skipped)
      mockActor._emitState(createPresenceState({ connected: 'userAway' }))
      setPresenceSpy.mockClear()

      // Same state again
      mockActor._emitState(createPresenceState({ connected: 'userAway' }))

      // Should not call setPresence for duplicate state
      expect(setPresenceSpy).not.toHaveBeenCalled()

      setPresenceSpy.mockRestore()
    })

    it('should send presence when status message changes', async () => {
      await connectClient()
      const mockActor = createMockPresenceActor()
      mockStores.connection.getStatus.mockReturnValue('online')

      // Spy on the roster.setPresence method
      const setPresenceSpy = vi.spyOn(xmppClient.roster, 'setPresence').mockResolvedValue()

      xmppClient.setupPresenceSync(mockActor as any)

      // Initial state (skipped)
      mockActor._emitState(createPresenceState({ connected: 'userOnline' }))
      setPresenceSpy.mockClear()

      // Same show but different status
      mockActor._emitState(createPresenceState({ connected: 'userOnline' }, { statusMessage: 'Working' }))

      // Should have called setPresence with the new status
      expect(setPresenceSpy).toHaveBeenCalledWith('online', 'Working')

      setPresenceSpy.mockRestore()
    })
  })
})
