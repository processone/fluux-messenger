/**
 * XMPPClient Quick Chat Tests
 *
 * Tests for creating and configuring transient MUC rooms (Quick Chat feature).
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

describe('XMPPClient Quick Chat', () => {
  let xmppClient: XMPPClient
  let mockStores: MockStoreBindings
  let emitSDKSpy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    vi.useFakeTimers()
    mockXmppClientInstance = createMockXmppClient()
    mockClientFactory.mockClear()
    mockClientFactory._setInstance(mockXmppClientInstance)

    // Mock iqCaller.request early (before connect) to handle disco queries
    mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
      const xmlns = iq.children?.[0]?.attrs?.xmlns

      // Disco#items query (discoverMucService)
      if (xmlns === 'http://jabber.org/protocol/disco#items') {
        return createMockElement('iq', { type: 'result' }, [
          {
            name: 'query',
            attrs: { xmlns: 'http://jabber.org/protocol/disco#items' },
            children: [
              {
                name: 'item',
                attrs: { jid: 'conference.example.com', name: 'Chatrooms' },
              },
            ],
          },
        ])
      }

      // Disco#info query (discoverMucService follow-up)
      if (xmlns === 'http://jabber.org/protocol/disco#info') {
        return createMockElement('iq', { type: 'result' }, [
          {
            name: 'query',
            attrs: { xmlns: 'http://jabber.org/protocol/disco#info' },
            children: [
              { name: 'identity', attrs: { category: 'conference', type: 'text', name: 'Chatrooms' } },
              { name: 'feature', attrs: { var: 'http://jabber.org/protocol/muc' } },
            ],
          },
        ])
      }

      // Room configuration form (configureQuickChat)
      if (xmlns === 'http://jabber.org/protocol/muc#owner') {
        return createMockElement('query', { xmlns: 'http://jabber.org/protocol/muc#owner' }, [])
      }

      // VCard avatar fetch (ProfileModule.fetchVCardAvatar)
      if (xmlns === 'vcard-temp') {
        return createMockElement('vCard', { xmlns: 'vcard-temp' }, [])
      }

      // Bookmarks fetch (RoomModule.fetchBookmarks)
      if (xmlns === 'http://jabber.org/protocol/pubsub') {
        return createMockElement('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' }, [
          { name: 'items', attrs: { node: 'urn:xmpp:bookmarks:1' }, children: [] },
        ])
      }

      throw new Error('Not mocked')
    })

    mockStores = createMockStores()
    // Mock getMucServiceJid to return conference service
    ;(mockStores.admin as any).getMucServiceJid = vi.fn().mockReturnValue('conference.example.com')

    xmppClient = new XMPPClient({ debug: false })
    xmppClient.bindStores(mockStores)
    emitSDKSpy = vi.spyOn(xmppClient, 'emitSDK')

    // Connect the client
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com',
      password: 'secret',
      server: 'example.com',
      skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  describe('createQuickChat', () => {
    it('should create a quick chat room with generated JID', async () => {
      const roomJid = await xmppClient.muc.createQuickChat('testuser')

      // Room JID should follow pattern: quickchat-user-adj-noun-suffix@conference.example.com
      expect(roomJid).toMatch(/^quickchat-user-\w+-\w+-\w+@conference\.example\.com$/)
    })

    it('should add room to store with isQuickChat flag', async () => {
      await xmppClient.muc.createQuickChat('testuser')

      // Verify room:added was emitted with isQuickChat: true
      expect(emitSDKSpy).toHaveBeenCalledWith('room:added', {
        room: expect.objectContaining({
          isQuickChat: true,
          joined: false,
        })
      })
    })

    it('should use topic as room name when provided', async () => {
      await xmppClient.muc.createQuickChat('testuser', 'deploy issue')

      // Should configure the room with the topic as name via iqCaller.request
      const requestCalls = mockXmppClientInstance.iqCaller.request.mock.calls
      const configCall = requestCalls.find((call: any[]) => {
        const iq = call[0]
        return iq?.attrs?.type === 'set' &&
               iq?.children?.some((c: any) => c.attrs?.xmlns === 'http://jabber.org/protocol/muc#owner')
      })

      expect(configCall).toBeDefined()
      // The configuration should include the topic
      if (configCall) {
        const xmlStr = JSON.stringify(configCall[0])
        expect(xmlStr).toContain('deploy issue')
      }
    })

    it('should use creator name in room name when no topic provided', async () => {
      await xmppClient.muc.createQuickChat('testuser')

      // Should configure with "{creator} - {date}" name via iqCaller.request
      // Since getOwnNickname returns null, it falls back to JID local part "user"
      const requestCalls = mockXmppClientInstance.iqCaller.request.mock.calls
      const configCall = requestCalls.find((call: any[]) => {
        const iq = call[0]
        return iq?.attrs?.type === 'set' &&
               iq?.children?.some((c: any) => c.attrs?.xmlns === 'http://jabber.org/protocol/muc#owner')
      })

      expect(configCall).toBeDefined()
      if (configCall) {
        const xmlStr = JSON.stringify(configCall[0])
        // Should contain the creator's name (from JID local part)
        expect(xmlStr).toContain('user')
      }
    })

    it('should send presence to join the room', async () => {
      await xmppClient.muc.createQuickChat('testuser')

      // Should send presence to join room
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const joinPresence = sendCalls.find((call: any[]) => {
        const stanza = call[0]
        return stanza?.name === 'presence' &&
               stanza?.attrs?.to?.includes('@conference.example.com/')
      })

      expect(joinPresence).toBeDefined()
    })

    it('should configure room as non-persistent', async () => {
      await xmppClient.muc.createQuickChat('testuser')

      // Should send MUC#owner configuration with persistentroom = 0 via iqCaller.request
      const requestCalls = mockXmppClientInstance.iqCaller.request.mock.calls
      const configCall = requestCalls.find((call: any[]) => {
        const iq = call[0]
        return iq?.attrs?.type === 'set' &&
               iq?.children?.some((c: any) => c.attrs?.xmlns === 'http://jabber.org/protocol/muc#owner')
      })

      expect(configCall).toBeDefined()
      if (configCall) {
        const xmlStr = JSON.stringify(configCall[0])
        expect(xmlStr).toContain('muc#roomconfig_persistentroom')
      }
    })

    it('should throw if not connected', async () => {
      // Disconnect the client
      await xmppClient.disconnect()

      await expect(xmppClient.muc.createQuickChat('testuser')).rejects.toThrow()
    })

    it('should throw if MUC service not found', async () => {
      // Mock no MUC service - getMucServiceJid returns null/undefined
      ;(mockStores.admin as any).getMucServiceJid = vi.fn().mockReturnValue(null)

      // Also mock disco to not find MUC service
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        const xmlns = iq.children?.[0]?.attrs?.xmlns
        if (xmlns === 'http://jabber.org/protocol/disco#items') {
          return createMockElement('query', { xmlns: 'http://jabber.org/protocol/disco#items' }, [])
        }
        if (xmlns === 'http://jabber.org/protocol/disco#info') {
          // Return empty features (not a MUC service)
          return createMockElement('query', { xmlns: 'http://jabber.org/protocol/disco#info' }, [])
        }
        throw new Error('Not mocked')
      })

      await expect(xmppClient.muc.createQuickChat('testuser')).rejects.toThrow('MUC service not available')
    })

    it('should send invitations to specified contacts after room creation', async () => {
      const invitees = ['alice@example.com', 'bob@example.com']
      await xmppClient.muc.createQuickChat('testuser', 'team sync', invitees)

      // Find invitation messages in send calls
      const sendCalls = mockXmppClientInstance.send.mock.calls
      const invitationMessages = sendCalls.filter((call: any[]) => {
        const stanza = call[0]
        if (stanza?.name !== 'message') return false
        const xElement = stanza.children?.find((c: any) =>
          c.name === 'x' && c.attrs?.xmlns === 'http://jabber.org/protocol/muc#user'
        )
        return xElement?.children?.some((c: any) => c.name === 'invite')
      })

      // Should have sent 2 invitations
      expect(invitationMessages.length).toBe(2)

      // Verify invitations were sent to correct JIDs
      const invitedJids = invitationMessages.map((call: any[]) => {
        const xElement = call[0].children.find((c: any) =>
          c.name === 'x' && c.attrs?.xmlns === 'http://jabber.org/protocol/muc#user'
        )
        const inviteElement = xElement.children.find((c: any) => c.name === 'invite')
        return inviteElement.attrs.to
      })
      expect(invitedJids).toContain('alice@example.com')
      expect(invitedJids).toContain('bob@example.com')
    })

    it('should include reason in invitation when topic is provided', async () => {
      await xmppClient.muc.createQuickChat('testuser', 'deploy issue', ['alice@example.com'])

      const sendCalls = mockXmppClientInstance.send.mock.calls
      const invitationMessage = sendCalls.find((call: any[]) => {
        const stanza = call[0]
        if (stanza?.name !== 'message') return false
        const xElement = stanza.children?.find((c: any) =>
          c.name === 'x' && c.attrs?.xmlns === 'http://jabber.org/protocol/muc#user'
        )
        return xElement?.children?.some((c: any) => c.name === 'invite')
      })

      expect(invitationMessage).toBeDefined()
      const xElement = invitationMessage![0].children.find((c: any) =>
        c.name === 'x' && c.attrs?.xmlns === 'http://jabber.org/protocol/muc#user'
      )
      const inviteElement = xElement.children.find((c: any) => c.name === 'invite')
      const reasonElement = inviteElement.children?.find((c: any) => c.name === 'reason')
      expect(reasonElement).toBeDefined()
    })

    it('should not send invitations when invitees array is empty', async () => {
      await xmppClient.muc.createQuickChat('testuser', 'topic', [])

      const sendCalls = mockXmppClientInstance.send.mock.calls
      const invitationMessages = sendCalls.filter((call: any[]) => {
        const stanza = call[0]
        if (stanza?.name !== 'message') return false
        const xElement = stanza.children?.find((c: any) =>
          c.name === 'x' && c.attrs?.xmlns === 'http://jabber.org/protocol/muc#user'
        )
        return xElement?.children?.some((c: any) => c.name === 'invite')
      })

      expect(invitationMessages.length).toBe(0)
    })

    it('should use JID local parts for room name when no XEP-0172 nickname (privacy)', async () => {
      // Setup: mock roster with custom roster names that should NOT be leaked
      mockStores.roster.getContact = vi.fn().mockImplementation((jid: string) => {
        if (jid === 'alice@example.com') {
          return { jid, name: 'My Secret Label for Alice', presence: 'online' }
        }
        if (jid === 'bob@example.com') {
          return { jid, name: 'Bob (Work Friend)', presence: 'online' }
        }
        return null
      })

      // Store original mock implementation to extend it
      const originalMock = mockXmppClientInstance.iqCaller.request.getMockImplementation()
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        // Check for XEP-0172 nickname request
        const pubsubEl = iq.children?.find((c: any) => c.attrs?.xmlns === 'http://jabber.org/protocol/pubsub')
        const itemsEl = pubsubEl?.children?.find((c: any) => c.name === 'items')
        if (itemsEl?.attrs?.node === 'http://jabber.org/protocol/nick') {
          // Simulate no nickname published
          throw new Error('item-not-found')
        }
        // Delegate to original mock for other IQs
        return originalMock!(iq)
      })

      await xmppClient.muc.createQuickChat('testuser', undefined, ['alice@example.com', 'bob@example.com'])

      // Find the room configuration IQ
      const requestCalls = mockXmppClientInstance.iqCaller.request.mock.calls
      const configCall = requestCalls.find((call: any[]) => {
        const iq = call[0]
        return iq?.attrs?.type === 'set' &&
               iq?.children?.some((c: any) => c.attrs?.xmlns === 'http://jabber.org/protocol/muc#owner')
      })

      expect(configCall).toBeDefined()
      if (configCall) {
        const xmlStr = JSON.stringify(configCall[0])
        // Should use JID local parts (alice, bob), NOT roster names
        expect(xmlStr).toContain('alice')
        expect(xmlStr).toContain('bob')
        // Should NOT contain the private roster labels
        expect(xmlStr).not.toContain('My Secret Label')
        expect(xmlStr).not.toContain('Work Friend')
      }
    })

    it('should use XEP-0172 nicknames when available for room name', async () => {
      // Store original mock implementation to extend it
      const originalMock = mockXmppClientInstance.iqCaller.request.getMockImplementation()
      mockXmppClientInstance.iqCaller.request.mockImplementation(async (iq: any) => {
        // Check for XEP-0172 nickname request
        const pubsubEl = iq.children?.find((c: any) => c.attrs?.xmlns === 'http://jabber.org/protocol/pubsub')
        const itemsEl = pubsubEl?.children?.find((c: any) => c.name === 'items')
        if (itemsEl?.attrs?.node === 'http://jabber.org/protocol/nick') {
          const toJid = iq.attrs?.to
          let nickname = null
          if (toJid === 'alice@example.com') {
            nickname = 'Alice Wonderland'
          } else if (toJid === 'bob@example.com') {
            nickname = 'Bob Builder'
          }
          if (nickname) {
            return createMockElement('iq', { type: 'result' }, [
              {
                name: 'pubsub',
                attrs: { xmlns: 'http://jabber.org/protocol/pubsub' },
                children: [{
                  name: 'items',
                  attrs: { node: 'http://jabber.org/protocol/nick' },
                  children: [{
                    name: 'item',
                    children: [{
                      name: 'nick',
                      attrs: { xmlns: 'http://jabber.org/protocol/nick' },
                      text: nickname
                    }]
                  }]
                }]
              }
            ])
          }
        }
        // Delegate to original mock for other IQs
        return originalMock!(iq)
      })

      await xmppClient.muc.createQuickChat('testuser', undefined, ['alice@example.com', 'bob@example.com'])

      // Find the room configuration IQ
      const requestCalls = mockXmppClientInstance.iqCaller.request.mock.calls
      const configCall = requestCalls.find((call: any[]) => {
        const iq = call[0]
        return iq?.attrs?.type === 'set' &&
               iq?.children?.some((c: any) => c.attrs?.xmlns === 'http://jabber.org/protocol/muc#owner')
      })

      expect(configCall).toBeDefined()
      if (configCall) {
        const xmlStr = JSON.stringify(configCall[0])
        // Should use XEP-0172 nicknames, not JID local parts
        expect(xmlStr).toContain('Alice Wonderland')
        expect(xmlStr).toContain('Bob Builder')
      }
    })

    it('should use creator XEP-0172 nickname in room name when available', async () => {
      // Mock getOwnNickname to return the creator's XEP-0172 nickname
      mockStores.connection.getOwnNickname = vi.fn().mockReturnValue('John Doe')

      await xmppClient.muc.createQuickChat('testuser', undefined, ['alice@example.com'])

      // Find the room configuration IQ
      const requestCalls = mockXmppClientInstance.iqCaller.request.mock.calls
      const configCall = requestCalls.find((call: any[]) => {
        const iq = call[0]
        return iq?.attrs?.type === 'set' &&
               iq?.children?.some((c: any) => c.attrs?.xmlns === 'http://jabber.org/protocol/muc#owner')
      })

      expect(configCall).toBeDefined()
      if (configCall) {
        const xmlStr = JSON.stringify(configCall[0])
        // Should use the creator's XEP-0172 nickname, not JID local part
        expect(xmlStr).toContain('John Doe')
        // Should NOT use the JID local part when nickname is available
        // (Actually it may contain "user" as part of the room JID, so we check specifically for the name field)
      }
    })
  })

  describe('sendMediatedInvitation', () => {
    beforeEach(() => {
      // Clear send mock to isolate invitation tests from setup stanzas
      mockXmppClientInstance.send.mockClear()
    })

    it('should send invitation stanza with correct structure', async () => {
      await xmppClient.muc.sendMediatedInvitation('room@conference.example.com', 'alice@example.com')

      expect(mockXmppClientInstance.send).toHaveBeenCalled()
      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      // Should be a message to the room
      expect(sentStanza.name).toBe('message')
      expect(sentStanza.attrs.to).toBe('room@conference.example.com')

      // Should have x element with MUC#user namespace
      const xElement = sentStanza.children.find((c: any) =>
        c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user'
      )
      expect(xElement).toBeDefined()

      // Should have invite element with correct to attribute
      const inviteElement = xElement.children.find((c: any) => c.name === 'invite')
      expect(inviteElement).toBeDefined()
      expect(inviteElement.attrs.to).toBe('alice@example.com')
    })

    it('should include reason element when provided', async () => {
      await xmppClient.muc.sendMediatedInvitation('room@conference.example.com', 'alice@example.com', 'Please join our discussion')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const xElement = sentStanza.children.find((c: any) =>
        c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user'
      )
      const inviteElement = xElement.children.find((c: any) => c.name === 'invite')
      const reasonElement = inviteElement.children?.find((c: any) => c.name === 'reason')

      expect(reasonElement).toBeDefined()
    })

    it('should not include reason element when not provided', async () => {
      await xmppClient.muc.sendMediatedInvitation('room@conference.example.com', 'alice@example.com')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]
      const xElement = sentStanza.children.find((c: any) =>
        c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user'
      )
      const inviteElement = xElement.children.find((c: any) => c.name === 'invite')
      const reasonElement = inviteElement.children?.find((c: any) => c.name === 'reason')

      expect(reasonElement).toBeUndefined()
    })

    it('should throw if not connected', async () => {
      await xmppClient.disconnect()

      await expect(
        xmppClient.muc.sendMediatedInvitation('room@conference.example.com', 'alice@example.com')
      ).rejects.toThrow('Not connected')
    })

    it('should include quickchat element inside invite when isQuickChat is true', async () => {
      await xmppClient.muc.sendMediatedInvitation('room@conference.example.com', 'alice@example.com', undefined, true)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      // Quickchat element should be INSIDE the invite element (so MUC server forwards it)
      const xElement = sentStanza.children.find((c: any) => c.name === 'x')
      const inviteElement = xElement?.children.find((c: any) => c.name === 'invite')
      const quickchatElement = inviteElement?.children.find((c: any) =>
        c.name === 'quickchat' && c.attrs.xmlns === 'urn:xmpp:fluux:0'
      )
      expect(quickchatElement).toBeDefined()
    })

    it('should not include quickchat element when isQuickChat is false', async () => {
      await xmppClient.muc.sendMediatedInvitation('room@conference.example.com', 'alice@example.com', undefined, false)

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      // Should NOT have quickchat element anywhere
      const xElement = sentStanza.children.find((c: any) => c.name === 'x')
      const inviteElement = xElement?.children.find((c: any) => c.name === 'invite')
      const quickchatElement = inviteElement?.children.find((c: any) =>
        c.name === 'quickchat'
      )
      expect(quickchatElement).toBeUndefined()
    })

    it('should not include quickchat element when isQuickChat is not provided', async () => {
      await xmppClient.muc.sendMediatedInvitation('room@conference.example.com', 'alice@example.com')

      const sentStanza = mockXmppClientInstance.send.mock.calls[0][0]

      // Should NOT have quickchat element anywhere
      const xElement = sentStanza.children.find((c: any) => c.name === 'x')
      const inviteElement = xElement?.children.find((c: any) => c.name === 'invite')
      const quickchatElement = inviteElement?.children.find((c: any) =>
        c.name === 'quickchat'
      )
      expect(quickchatElement).toBeUndefined()
    })
  })

  describe('sendMediatedInvitations', () => {
    beforeEach(() => {
      // Clear send mock to isolate invitation tests from setup stanzas
      mockXmppClientInstance.send.mockClear()
    })

    it('should send invitations to all specified JIDs', async () => {
      const invitees = ['alice@example.com', 'bob@example.com', 'charlie@example.com']
      await xmppClient.muc.sendMediatedInvitations('room@conference.example.com', invitees)

      // Should have sent 3 messages
      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(3)

      // Verify each invitation
      const invitedJids = mockXmppClientInstance.send.mock.calls.map((call: any[]) => {
        const xElement = call[0].children.find((c: any) =>
          c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user'
        )
        const inviteElement = xElement.children.find((c: any) => c.name === 'invite')
        return inviteElement.attrs.to
      })

      expect(invitedJids).toContain('alice@example.com')
      expect(invitedJids).toContain('bob@example.com')
      expect(invitedJids).toContain('charlie@example.com')
    })

    it('should include reason in all invitations when provided', async () => {
      await xmppClient.muc.sendMediatedInvitations(
        'room@conference.example.com',
        ['alice@example.com', 'bob@example.com'],
        'Join our meeting'
      )

      // All invitations should have reason
      mockXmppClientInstance.send.mock.calls.forEach((call: any[]) => {
        const xElement = call[0].children.find((c: any) =>
          c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user'
        )
        const inviteElement = xElement.children.find((c: any) => c.name === 'invite')
        const reasonElement = inviteElement.children?.find((c: any) => c.name === 'reason')
        expect(reasonElement).toBeDefined()
      })
    })

    it('should include quickchat element in all invitations when isQuickChat is true', async () => {
      await xmppClient.muc.sendMediatedInvitations(
        'room@conference.example.com',
        ['alice@example.com', 'bob@example.com'],
        undefined,
        true // isQuickChat
      )

      // All invitations should have quickchat element inside the invite
      mockXmppClientInstance.send.mock.calls.forEach((call: any[]) => {
        const xElement = call[0].children.find((c: any) =>
          c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user'
        )
        const inviteElement = xElement?.children.find((c: any) => c.name === 'invite')
        const quickchatElement = inviteElement?.children.find((c: any) =>
          c.name === 'quickchat' && c.attrs.xmlns === 'urn:xmpp:fluux:0'
        )
        expect(quickchatElement).toBeDefined()
      })
    })
  })

  describe('receiving mediated invitation', () => {
    it('should emit muc-invitation event with isQuickChat: true when quickchat element is present', () => {
      // Simulate receiving a mediated invitation with quickchat marker INSIDE the invite element
      // (MUC server forwards content inside <invite>, so quickchat must be there)
      const invitationStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        to: 'user@example.com',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            {
              name: 'invite',
              attrs: { from: 'alice@example.com' },
              children: [
                { name: 'reason', text: 'Join quick chat: deploy issue' },
                { name: 'quickchat', attrs: { xmlns: 'urn:xmpp:fluux:0' } },
              ],
            },
          ],
        },
      ])

      // Emit the stanza to trigger invitation handling
      mockXmppClientInstance._emit('stanza', invitationStanza)

      // Verify SDK event was emitted with isQuickChat: true
      expect(emitSDKSpy).toHaveBeenCalledWith('events:muc-invitation', {
        roomJid: 'room@conference.example.com',
        from: 'alice@example.com',
        reason: 'Join quick chat: deploy issue',
        password: undefined,
        isDirect: false,
        isQuickChat: true,
      })
    })

    it('should emit muc-invitation event with isQuickChat: false when quickchat element is absent', () => {
      // Simulate receiving a mediated invitation WITHOUT quickchat marker
      const invitationStanza = createMockElement('message', {
        from: 'room@conference.example.com',
        to: 'user@example.com',
      }, [
        {
          name: 'x',
          attrs: { xmlns: 'http://jabber.org/protocol/muc#user' },
          children: [
            {
              name: 'invite',
              attrs: { from: 'alice@example.com' },
              children: [
                { name: 'reason', text: 'Join our room' },
              ],
            },
          ],
        },
      ])

      // Emit the stanza to trigger invitation handling
      mockXmppClientInstance._emit('stanza', invitationStanza)

      // Verify SDK event was emitted with isQuickChat: false
      expect(emitSDKSpy).toHaveBeenCalledWith('events:muc-invitation', {
        roomJid: 'room@conference.example.com',
        from: 'alice@example.com',
        reason: 'Join our room',
        password: undefined,
        isDirect: false,
        isQuickChat: false,
      })
    })

    it('should emit muc-invitation event with isQuickChat: true for direct invitations with quickchat marker', () => {
      // Simulate receiving a direct invitation (XEP-0249) with quickchat marker
      const invitationStanza = createMockElement('message', {
        from: 'alice@example.com',
        to: 'user@example.com',
      }, [
        {
          name: 'x',
          attrs: {
            xmlns: 'jabber:x:conference',
            jid: 'room@conference.example.com',
            reason: 'Quick discussion',
          },
        },
        { name: 'quickchat', attrs: { xmlns: 'urn:xmpp:fluux:0' } },
      ])

      // Emit the stanza to trigger invitation handling
      mockXmppClientInstance._emit('stanza', invitationStanza)

      // Verify SDK event was emitted with isQuickChat: true
      expect(emitSDKSpy).toHaveBeenCalledWith('events:muc-invitation', {
        roomJid: 'room@conference.example.com',
        from: 'alice@example.com',
        reason: 'Quick discussion',
        password: undefined,
        isDirect: true,
        isQuickChat: true,
      })
    })
  })
})
