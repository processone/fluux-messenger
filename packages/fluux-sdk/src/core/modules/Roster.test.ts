/**
 * XMPPClient Roster Tests
 *
 * Tests for contact management: addContact, acceptSubscription, rejectSubscription,
 * renameContact, removeContact, and roster push handling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { XMPPClient } from '../XMPPClient'
import {
  createMockXmppClient,
  createMockStores,
  createMockElement,
  createIQHandlerTester,
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

describe('XMPPClient Roster', () => {
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

  // Helper to connect the client before testing roster operations
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

  describe('addContact', () => {
    it('should throw error when not connected', async () => {
      await expect(xmppClient.roster.addContact('contact@example.com')).rejects.toThrow('Not connected')
    })

    it('should send subscribe presence without nickname', async () => {
      await connectClient()

      // Add contact without nickname
      await xmppClient.roster.addContact('contact@example.com')

      // Should have sent exactly one stanza (subscribe presence)
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(sentStanza.name).toBe('presence')
      expect(sentStanza.attrs.to).toBe('contact@example.com')
      expect(sentStanza.attrs.type).toBe('subscribe')
    })

    it('should send roster set IQ then subscribe presence with nickname', async () => {
      await connectClient()

      // Add contact with nickname
      await xmppClient.roster.addContact('contact@example.com', 'My Friend')

      // Should have sent two stanzas
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(2)

      // First call: roster set IQ with name
      const rosterIq = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(rosterIq.name).toBe('iq')
      expect(rosterIq.attrs.type).toBe('set')
      expect(rosterIq.children[0].name).toBe('query')
      expect(rosterIq.children[0].attrs.xmlns).toBe('jabber:iq:roster')
      expect(rosterIq.children[0].children[0].name).toBe('item')
      expect(rosterIq.children[0].children[0].attrs.jid).toBe('contact@example.com')
      expect(rosterIq.children[0].children[0].attrs.name).toBe('My Friend')

      // Second call: subscribe presence
      const subscribePresence = vi.mocked(mockXmppClientInstance.send).mock.calls[1][0]
      expect(subscribePresence.name).toBe('presence')
      expect(subscribePresence.attrs.to).toBe('contact@example.com')
      expect(subscribePresence.attrs.type).toBe('subscribe')
    })

    it('should not send roster set IQ when nickname is empty string', async () => {
      await connectClient()

      // Add contact with empty nickname
      await xmppClient.roster.addContact('contact@example.com', '')

      // Should have sent only one stanza (subscribe presence)
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(sentStanza.name).toBe('presence')
      expect(sentStanza.attrs.type).toBe('subscribe')
    })
  })

  describe('acceptSubscription', () => {
    it('should throw error when not connected', async () => {
      await expect(xmppClient.roster.acceptSubscription('contact@example.com')).rejects.toThrow('Not connected')
    })

    it('should send subscribed and subscribe presence', async () => {
      await connectClient()

      // Accept subscription
      await xmppClient.roster.acceptSubscription('contact@example.com')

      // Should have sent two stanzas
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(2)

      // First: subscribed presence (approve their request)
      const subscribedPresence = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(subscribedPresence.name).toBe('presence')
      expect(subscribedPresence.attrs.to).toBe('contact@example.com')
      expect(subscribedPresence.attrs.type).toBe('subscribed')

      // Second: subscribe presence (request mutual subscription)
      const subscribePresence = vi.mocked(mockXmppClientInstance.send).mock.calls[1][0]
      expect(subscribePresence.name).toBe('presence')
      expect(subscribePresence.attrs.to).toBe('contact@example.com')
      expect(subscribePresence.attrs.type).toBe('subscribe')
    })

    it('should remove subscription request from inbox store', async () => {
      await connectClient()

      // Accept subscription
      await xmppClient.roster.acceptSubscription('contact@example.com')

      expect(emitSDKSpy).toHaveBeenCalledWith('events:subscription-request-removed', { from: 'contact@example.com' })
    })
  })

  describe('rejectSubscription', () => {
    it('should throw error when not connected', async () => {
      await expect(xmppClient.roster.rejectSubscription('contact@example.com')).rejects.toThrow('Not connected')
    })

    it('should send unsubscribed presence', async () => {
      await connectClient()

      // Reject subscription
      await xmppClient.roster.rejectSubscription('contact@example.com')

      // Should have sent one stanza
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const unsubscribedPresence = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(unsubscribedPresence.name).toBe('presence')
      expect(unsubscribedPresence.attrs.to).toBe('contact@example.com')
      expect(unsubscribedPresence.attrs.type).toBe('unsubscribed')
    })

    it('should remove subscription request from inbox store', async () => {
      await connectClient()

      // Reject subscription
      await xmppClient.roster.rejectSubscription('contact@example.com')

      expect(emitSDKSpy).toHaveBeenCalledWith('events:subscription-request-removed', { from: 'contact@example.com' })
    })
  })

  describe('renameContact', () => {
    it('should throw error when not connected', async () => {
      await expect(xmppClient.roster.renameContact('contact@example.com', 'New Name')).rejects.toThrow('Not connected')
    })

    it('should send roster set IQ with new name', async () => {
      await connectClient()

      // Rename contact
      await xmppClient.roster.renameContact('contact@example.com', 'New Display Name')

      // Should have sent one stanza
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const renameIq = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(renameIq.name).toBe('iq')
      expect(renameIq.attrs.type).toBe('set')
      expect(renameIq.children[0].name).toBe('query')
      expect(renameIq.children[0].attrs.xmlns).toBe('jabber:iq:roster')
      expect(renameIq.children[0].children[0].name).toBe('item')
      expect(renameIq.children[0].children[0].attrs.jid).toBe('contact@example.com')
      expect(renameIq.children[0].children[0].attrs.name).toBe('New Display Name')
    })
  })

  describe('removeContact', () => {
    it('should throw error when not connected', async () => {
      await expect(xmppClient.roster.removeContact('contact@example.com')).rejects.toThrow('Not connected')
    })

    it('should send roster remove IQ', async () => {
      await connectClient()

      // Remove contact
      await xmppClient.roster.removeContact('contact@example.com')

      // Should have sent one stanza
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)

      const removeIq = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(removeIq.name).toBe('iq')
      expect(removeIq.attrs.type).toBe('set')
      expect(removeIq.children[0].name).toBe('query')
      expect(removeIq.children[0].attrs.xmlns).toBe('jabber:iq:roster')
      expect(removeIq.children[0].children[0].name).toBe('item')
      expect(removeIq.children[0].children[0].attrs.jid).toBe('contact@example.com')
      expect(removeIq.children[0].children[0].attrs.subscription).toBe('remove')
    })
  })

  describe('roster push (incoming)', () => {
    it('should register iqCallee handler for roster pushes', async () => {
      // Don't use connectClient() here since it clears mocks
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      // Verify iqCallee.set was called with roster namespace
      expect(mockXmppClientInstance.iqCallee.set).toHaveBeenCalledWith(
        'jabber:iq:roster',
        'query',
        expect.any(Function)
      )
    })

    it('should update roster on roster push with new contact', async () => {
      await connectClient()

      const rosterPush = createMockElement('iq', {
        type: 'set',
        id: 'push123',
        from: 'user@example.com',
      }, [
        {
          name: 'query',
          attrs: { xmlns: 'jabber:iq:roster' },
          children: [
            {
              name: 'item',
              attrs: {
                jid: 'newcontact@example.com',
                name: 'New Contact',
                subscription: 'both',
              },
            },
          ],
        },
      ])

      // Call the iqCallee handler directly (simulates xmpp.js iq-callee behavior)
      const result = mockXmppClientInstance.iqCallee._call(
        'jabber:iq:roster',
        'query',
        { stanza: rosterPush },
        'set'
      )

      // Handler should return truthy to indicate it handled the IQ
      expect(result).toBe(true)

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:contact', {
        contact: {
          jid: 'newcontact@example.com',
          name: 'New Contact',
          presence: 'offline',
          subscription: 'both',
          groups: [],
        },
      })
    })

    it('should remove contact on roster push with subscription=remove', async () => {
      await connectClient()

      const rosterPush = createMockElement('iq', {
        type: 'set',
        id: 'push789',
        from: 'user@example.com',
      }, [
        {
          name: 'query',
          attrs: { xmlns: 'jabber:iq:roster' },
          children: [
            {
              name: 'item',
              attrs: {
                jid: 'removed@example.com',
                subscription: 'remove',
              },
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCallee._call(
        'jabber:iq:roster',
        'query',
        { stanza: rosterPush },
        'set'
      )

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:contact-removed', { jid: 'removed@example.com' })
    })

    it('should use JID as name when name attribute is missing', async () => {
      await connectClient()

      const rosterPush = createMockElement('iq', {
        type: 'set',
        id: 'push999',
      }, [
        {
          name: 'query',
          attrs: { xmlns: 'jabber:iq:roster' },
          children: [
            {
              name: 'item',
              attrs: {
                jid: 'noname@example.com',
                subscription: 'to',
              },
            },
          ],
        },
      ])

      mockXmppClientInstance.iqCallee._call(
        'jabber:iq:roster',
        'query',
        { stanza: rosterPush },
        'set'
      )

      expect(emitSDKSpy).toHaveBeenCalledWith('roster:contact', {
        contact: {
          jid: 'noname@example.com',
          name: 'noname', // Falls back to local part of JID
          presence: 'offline',
          subscription: 'to',
          groups: [],
        },
      })
    })

    it('should pass IQ handler validation for roster pushes', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise

      const tester = createIQHandlerTester(mockXmppClientInstance)

      // Validate roster push handler - should not produce duplicates or errors
      tester.assertHandlerValid(
        'jabber:iq:roster',
        'query',
        'set'
      )
    })
  })

  describe('presence caps node', () => {
    it('should use platform-specific caps node in setPresence', async () => {
      const connectPromise = xmppClient.connect({
        jid: 'user@example.com',
        password: 'secret',
        server: 'example.com',
        skipDiscovery: true,
      })
      mockXmppClientInstance._emit('online')
      await connectPromise
      vi.clearAllMocks()

      await xmppClient.roster.setPresence('away', 'Be right back')

      // Find the presence stanza
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(sentStanza.name).toBe('presence')

      // Find the caps element
      const capsElement = sentStanza.children.find((c: { name: string }) => c.name === 'c')
      expect(capsElement).toBeDefined()

      // Caps node should be platform-specific (in tests, defaults to web)
      // Should NOT be 'https://fluux.io/caps' (the old hardcoded value)
      expect(capsElement.attrs.node).toBe('https://fluux.io/web')
      expect(capsElement.attrs.node).not.toBe('https://fluux.io/caps')
    })
  })

  describe('setPresence circular dependency prevention', () => {
    /**
     * Regression test for auto-away bug where setPresence() was calling
     * setPresenceState() on the connection store, creating a circular dependency:
     *
     * 1. idleDetected() transitions machine to autoAway
     * 2. setupPresenceSync calls roster.setPresence('away')
     * 3. setPresence() was calling setPresenceState('away')
     * 4. setPresenceState() sends SET_PRESENCE to machine
     * 5. Machine transitions autoAway → userAway (manual away)
     * 6. ACTIVITY_DETECTED is ignored in userAway state
     * 7. User is stuck in "away" forever
     *
     * The fix: setPresence() should NOT call setPresenceState().
     * The presence machine is the source of truth.
     */
    it('should NOT call setPresenceState when sending presence (prevents circular dependency)', async () => {
      await connectClient()

      // Clear any calls from connection
      mockStores.connection.setPresenceState.mockClear()

      // Call setPresence (as setupPresenceSync does when machine state changes)
      await xmppClient.roster.setPresence('away', 'Auto away')

      // Verify presence was sent
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(sentStanza.name).toBe('presence')

      // CRITICAL: setPresenceState should NOT have been called
      // This would create a circular dependency that breaks auto-away restoration
      expect(mockStores.connection.setPresenceState).not.toHaveBeenCalled()
    })

    it('should NOT call setPresenceState for any presence show value', async () => {
      await connectClient()

      const showValues: Array<'away' | 'dnd' | 'xa' | 'online'> = ['away', 'dnd', 'xa', 'online']

      for (const show of showValues) {
        mockStores.connection.setPresenceState.mockClear()
        vi.mocked(mockXmppClientInstance.send).mockClear()

        await xmppClient.roster.setPresence(show, 'Status message')

        // Verify presence was sent
        expect(mockXmppClientInstance.send).toHaveBeenCalled()

        // setPresenceState should NEVER be called from setPresence
        expect(mockStores.connection.setPresenceState).not.toHaveBeenCalled()
      }
    })
  })

  describe('sendInitialPresence auto-away recovery', () => {
    // Helper to find a child element by name, filtering out undefined children
    const findChild = (stanza: { children: unknown[] }, name: string) =>
      stanza.children.filter(Boolean).find((c: unknown) => c && (c as { name?: string }).name === name)

    it('should restore to online when isAutoAway=true and preAutoAwayState=online', async () => {
      await connectClient()

      // Simulate auto-away state: presenceShow='away', isAutoAway=true, preAutoAwayState='online'
      mockStores.connection.getPresenceShow.mockReturnValue('away')
      mockStores.connection.getIsAutoAway.mockReturnValue(true)
      mockStores.connection.getPreAutoAwayState.mockReturnValue('online')
      mockStores.connection.getPreAutoAwayStatusMessage.mockReturnValue(null)

      await xmppClient.roster.sendInitialPresence()

      // Should send presence WITHOUT <show> element (which means 'online')
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(sentStanza.name).toBe('presence')
      const showElement = findChild(sentStanza, 'show')
      expect(showElement).toBeUndefined()

      // Note: sendInitialPresence no longer clears auto-away state directly.
      // The presence machine is the authoritative source and will sync the correct
      // state to the store when user activity/wake detection triggers a machine transition.
    })

    it('should restore to online when isAutoAway=false but preAutoAwayState exists (race condition fix)', async () => {
      // This tests the race condition fix:
      // If handleActivity() clears isAutoAway but the connection dies before presenceShow
      // can be updated, preAutoAwayState will still exist and should trigger recovery.
      // With the presence machine, this scenario is handled correctly because the machine
      // state transitions are atomic, but we still test the fallback behavior.
      await connectClient()

      // Simulate corrupted state: presenceShow='away' (not updated), isAutoAway=false (cleared),
      // preAutoAwayState='online' (still exists because it's proof auto-away was active)
      mockStores.connection.getPresenceShow.mockReturnValue('away')
      mockStores.connection.getIsAutoAway.mockReturnValue(false)
      mockStores.connection.getPreAutoAwayState.mockReturnValue('online')
      mockStores.connection.getPreAutoAwayStatusMessage.mockReturnValue(null)

      await xmppClient.roster.sendInitialPresence()

      // Should restore to online (not preserve 'away')
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      expect(sentStanza.name).toBe('presence')
      const showElement = findChild(sentStanza, 'show')
      expect(showElement).toBeUndefined() // No <show> = online

      // Note: sendInitialPresence no longer clears pre-auto-away state directly.
      // The presence machine handles state management.
    })

    it('should default to online when isAutoAway=false and no preAutoAwayState (stale away)', async () => {
      await connectClient()

      // Simulate stale away: previous session had auto-away but isAutoAway is false
      // (because it's transient). We can't distinguish this from manual away, so
      // we default to online to avoid being stuck in 'away' on every reconnect.
      mockStores.connection.getPresenceShow.mockReturnValue('away')
      mockStores.connection.getIsAutoAway.mockReturnValue(false)
      mockStores.connection.getPreAutoAwayState.mockReturnValue(null)
      mockStores.connection.getStatusMessage.mockReturnValue('Out for lunch')

      await xmppClient.roster.sendInitialPresence()

      // Should default to 'online' (no show element in XMPP)
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      const showElement = findChild(sentStanza, 'show') as { children: unknown[] } | undefined
      expect(showElement).toBeUndefined()

      // Should NOT clear auto-away state (wasn't auto-away)
      expect(mockStores.connection.setAutoAway).not.toHaveBeenCalled()
    })

    it('should preserve DND regardless of auto-away state', async () => {
      await connectClient()

      // DND should always be preserved, even if auto-away data exists
      mockStores.connection.getPresenceShow.mockReturnValue('dnd')
      mockStores.connection.getIsAutoAway.mockReturnValue(true) // Would normally trigger recovery
      mockStores.connection.getPreAutoAwayState.mockReturnValue('online')
      mockStores.connection.getStatusMessage.mockReturnValue('In a meeting')

      await xmppClient.roster.sendInitialPresence()

      // Should preserve 'dnd' status
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      const showElement = findChild(sentStanza, 'show') as { children: unknown[] } | undefined
      expect(showElement).toBeDefined()
      expect(showElement!.children[0]).toBe('dnd')
    })

    it('should restore pre-auto-away status (e.g., user was manually away before auto-xa)', async () => {
      await connectClient()

      // User was manually 'away', then went idle and got auto-xa.
      // Pre-auto-away state should be 'away' (what they had before auto-xa)
      mockStores.connection.getPresenceShow.mockReturnValue('xa' as any)
      mockStores.connection.getIsAutoAway.mockReturnValue(true)
      mockStores.connection.getPreAutoAwayState.mockReturnValue('away')
      mockStores.connection.getPreAutoAwayStatusMessage.mockReturnValue('Be right back')

      await xmppClient.roster.sendInitialPresence()

      // Should restore to 'away' (the saved status)
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      const showElement = findChild(sentStanza, 'show') as { children: unknown[] } | undefined
      expect(showElement).toBeDefined()
      expect(showElement!.children[0]).toBe('away')

      // Should also restore the status message
      const statusElement = findChild(sentStanza, 'status') as { children: unknown[] } | undefined
      expect(statusElement).toBeDefined()
      expect(statusElement!.children[0]).toBe('Be right back')
    })

    it('should send online when presenceShow=online and no auto-away', async () => {
      await connectClient()

      // Normal online state
      mockStores.connection.getPresenceShow.mockReturnValue('online')
      mockStores.connection.getIsAutoAway.mockReturnValue(false)
      mockStores.connection.getPreAutoAwayState.mockReturnValue(null)
      mockStores.connection.getStatusMessage.mockReturnValue(null)

      await xmppClient.roster.sendInitialPresence()

      // Should send presence WITHOUT <show> element
      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = vi.mocked(mockXmppClientInstance.send).mock.calls[0][0]
      const showElement = findChild(sentStanza, 'show')
      expect(showElement).toBeUndefined()
    })
  })

  describe('XEP-0153 avatar handling (vcard-temp:x:update)', () => {
    it('should emit avatarMetadataUpdate when presence has photo hash', async () => {
      await connectClient()

      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      // Presence with vcard-temp:x:update containing a photo hash
      const presenceWithAvatar = createMockElement('presence', {
        from: 'contact@example.com/resource',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'abc123avatarhash' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', presenceWithAvatar)

      const avatarCalls = emitSpy.mock.calls.filter(call => call[0] === 'avatarMetadataUpdate')
      expect(avatarCalls.length).toBe(1)
      expect(avatarCalls[0]).toEqual(['avatarMetadataUpdate', 'contact@example.com', 'abc123avatarhash'])
    })

    it('should emit contactMissingXep0153Avatar when presence has empty photo element', async () => {
      await connectClient()

      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      // Presence with vcard-temp:x:update containing an EMPTY photo element
      // This indicates the contact may use XEP-0084 (PEP) avatars instead
      const presenceWithoutAvatar = createMockElement('presence', {
        from: 'contact@example.com/resource',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: '' }, // Empty = no XEP-0153 avatar
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', presenceWithoutAvatar)

      // Should NOT emit avatarMetadataUpdate (that's for XEP-0153 with actual hash)
      const avatarCalls = emitSpy.mock.calls.filter(call => call[0] === 'avatarMetadataUpdate')
      expect(avatarCalls.length).toBe(0)

      // Should emit contactMissingXep0153Avatar to trigger XEP-0084 fallback
      const missingAvatarCalls = emitSpy.mock.calls.filter(call => call[0] === 'contactMissingXep0153Avatar')
      expect(missingAvatarCalls.length).toBe(1)
      expect(missingAvatarCalls[0]).toEqual(['contactMissingXep0153Avatar', 'contact@example.com'])
    })

    it('should NOT emit avatarMetadataUpdate when contact already has the same avatar hash', async () => {
      await connectClient()

      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      // Mock roster store to return a contact with existing avatar hash
      mockStores.roster.getContact.mockReturnValue({
        jid: 'contact@example.com',
        name: 'Contact',
        subscription: 'both',
        presence: 'online',
        avatar: 'blob:existing-avatar',
        avatarHash: 'abc123avatarhash',
      })

      // Presence with same hash as already stored
      const presenceWithSameHash = createMockElement('presence', {
        from: 'contact@example.com/resource',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'abc123avatarhash' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', presenceWithSameHash)

      const avatarCalls = emitSpy.mock.calls.filter(call => call[0] === 'avatarMetadataUpdate')
      expect(avatarCalls.length).toBe(0)
    })

    it('should emit avatarMetadataUpdate when contact avatar hash changes', async () => {
      await connectClient()

      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      // Mock roster store to return a contact with a different avatar hash
      mockStores.roster.getContact.mockReturnValue({
        jid: 'contact@example.com',
        name: 'Contact',
        subscription: 'both',
        presence: 'online',
        avatar: 'blob:old-avatar',
        avatarHash: 'old-hash',
      })

      const presenceWithNewHash = createMockElement('presence', {
        from: 'contact@example.com/resource',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'new-hash-456' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', presenceWithNewHash)

      const avatarCalls = emitSpy.mock.calls.filter(call => call[0] === 'avatarMetadataUpdate')
      expect(avatarCalls.length).toBe(1)
      expect(avatarCalls[0]).toEqual(['avatarMetadataUpdate', 'contact@example.com', 'new-hash-456'])
    })

    it('should NOT emit avatarMetadataUpdate for self-presence with photo hash', async () => {
      await connectClient()

      // Set up the mock to return the connected JID (needed for self-presence detection)
      mockStores.connection.getJid.mockReturnValue('user@example.com/resource')

      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      // Self-presence (from our own JID but different resource) - should be ignored
      const selfPresenceWithAvatar = createMockElement('presence', {
        from: 'user@example.com/otherdevice',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'vcard-temp:x:update' },
          children: [
            { name: 'photo', text: 'myavatarhash' },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', selfPresenceWithAvatar)

      // Should NOT emit for self-presence
      const avatarCalls = emitSpy.mock.calls.filter(call => call[0] === 'avatarMetadataUpdate')
      expect(avatarCalls.length).toBe(0)
    })
  })

  describe('rosterLoaded event', () => {
    it('should emit rosterLoaded when roster result is received', async () => {
      await connectClient()

      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      // Simulate roster result IQ
      const rosterIQ = createMockElement('iq', {
        type: 'result',
        id: 'roster-1',
      }, [
        {
          name: 'query',
          attrs: { xmlns: 'jabber:iq:roster' },
          children: [
            {
              name: 'item',
              attrs: { jid: 'alice@example.com', name: 'Alice', subscription: 'both' },
            },
            {
              name: 'item',
              attrs: { jid: 'bob@example.com', name: 'Bob', subscription: 'to' },
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', rosterIQ)

      // Should emit rosterLoaded event
      const rosterLoadedCalls = emitSpy.mock.calls.filter(call => call[0] === 'rosterLoaded')
      expect(rosterLoadedCalls.length).toBe(1)
    })

    it('should NOT emit rosterLoaded for roster push (type=set)', async () => {
      await connectClient()

      const emitSpy = vi.spyOn(xmppClient as any, 'emit')

      // Simulate roster push (type='set') - this is for incremental updates, not full load
      const rosterPush = createMockElement('iq', {
        type: 'set',
        id: 'push-1',
      }, [
        {
          name: 'query',
          attrs: { xmlns: 'jabber:iq:roster' },
          children: [
            {
              name: 'item',
              attrs: { jid: 'charlie@example.com', name: 'Charlie', subscription: 'both' },
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', rosterPush)

      // Should NOT emit rosterLoaded for pushes
      const rosterLoadedCalls = emitSpy.mock.calls.filter(call => call[0] === 'rosterLoaded')
      expect(rosterLoadedCalls.length).toBe(0)
    })
  })

  describe('subscription requests from MUC JIDs', () => {
    it('should ignore subscription requests from MUC JIDs', async () => {
      await connectClient()
      const emitSDKSpy = vi.spyOn(xmppClient as any, 'emitSDK')

      // Simulate a subscription request from a MUC JID (should be ignored)
      const mucSubscribePresence = createMockElement('presence', {
        from: 'room@conference.example.com',
        to: 'user@example.com',
        type: 'subscribe',
      })

      mockXmppClientInstance._emit('stanza', mucSubscribePresence)

      // Should NOT emit subscription-request event for MUC JIDs
      expect(emitSDKSpy).not.toHaveBeenCalledWith(
        'events:subscription-request',
        expect.objectContaining({ from: 'room@conference.example.com' })
      )
    })

    it('should process subscription requests from regular JIDs', async () => {
      await connectClient()
      const emitSDKSpy = vi.spyOn(xmppClient as any, 'emitSDK')

      // Mock hasContact to return false for the stranger JID
      mockStores.roster.hasContact.mockReturnValue(false)

      // Simulate a subscription request from a regular user JID
      const userSubscribePresence = createMockElement('presence', {
        from: 'stranger@example.com',
        to: 'user@example.com',
        type: 'subscribe',
      })

      mockXmppClientInstance._emit('stanza', userSubscribePresence)

      // Should emit subscription-request event for regular JIDs
      expect(emitSDKSpy).toHaveBeenCalledWith(
        'events:subscription-request',
        { from: 'stranger@example.com' }
      )
    })
  })
})
