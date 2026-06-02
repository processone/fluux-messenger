/**
 * MUC Whisper Tests (XEP-0045 §7.5 private messages)
 *
 * Covers sending whispers (sendWhisper) and routing incoming whispers
 * (type='chat' from a joined room occupant) to the room:whisper event.
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

vi.mock('@xmpp/client', () => ({
  client: vi.fn(() => mockXmppClientInstance),
  xml: vi.fn((name: string, attrs?: Record<string, string>, ...children: unknown[]) => ({
    name,
    attrs: attrs || {},
    children,
    toString: () => `<${name}/>`,
  })),
}))
vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))

import { client as xmppClientFactory } from '@xmpp/client'

describe('MUC Whispers', () => {
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

  async function connectClient() {
    const connectPromise = xmppClient.connect({
      jid: 'user@example.com', password: 'secret', server: 'example.com', skipDiscovery: true,
    })
    mockXmppClientInstance._emit('online')
    await connectPromise
    vi.clearAllMocks()
  }

  describe('sendWhisper', () => {
    it('sends a type=chat stanza to room/nick with a muc#user marker', async () => {
      await connectClient()
      const room = createMockRoom('room@conference.example.com', { joined: true, nickname: 'me' })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      const id = await xmppClient.chat.sendWhisper('room@conference.example.com', 'bob', 'psst hello')

      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(0)

      expect(mockXmppClientInstance.send).toHaveBeenCalledTimes(1)
      const sent = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sent.name).toBe('message')
      expect(sent.attrs.to).toBe('room@conference.example.com/bob')
      expect(sent.attrs.type).toBe('chat')

      const bodyEl = sent.children.find((c: any) => c.name === 'body')
      expect(bodyEl.children[0]).toBe('psst hello')

      const xEl = sent.children.find((c: any) => c.name === 'x')
      expect(xEl).toBeDefined()
      expect(xEl.attrs.xmlns).toBe('http://jabber.org/protocol/muc#user')

      const originId = sent.children.find((c: any) => c.name === 'origin-id')
      expect(originId).toBeDefined()

      const noStore = sent.children.find((c: any) => c.name === 'no-store')
      expect(noStore).toBeDefined()
    })

    it('emits room:whisper (not chat:message) for the outgoing whisper', async () => {
      await connectClient()
      const room = createMockRoom('room@conference.example.com', { joined: true, nickname: 'me' })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      await xmppClient.chat.sendWhisper('room@conference.example.com', 'bob', 'psst hello')

      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isPrivate: true,
          isOutgoing: true,
          whisperWith: 'bob',
          noStore: true,
          body: 'psst hello',
          originId: expect.any(String),
        }),
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })
  })

  describe('incoming whispers', () => {
    it('routes type=chat from a joined room occupant to room:whisper', async () => {
      await connectClient()
      const room = createMockRoom('room@conference.example.com', { joined: true, nickname: 'me' })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      const stanza = createMockElement('message', {
        from: 'room@conference.example.com/bob',
        to: 'user@example.com',
        type: 'chat',
        id: 'w-1',
      }, [{ name: 'body', text: 'between us' }])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isPrivate: true,
          isOutgoing: false,
          nick: 'bob',
          whisperWith: 'bob',
          noStore: true,
          body: 'between us',
        }),
        incrementUnread: true,
        incrementMentions: true,
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })

    it('does NOT reclassify a whisper carrying a muc#user marker as public', async () => {
      await connectClient()
      const room = createMockRoom('room@conference.example.com', { joined: true, nickname: 'me' })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      const stanza = createMockElement('message', {
        from: 'room@conference.example.com/bob',
        to: 'user@example.com',
        type: 'chat',
        id: 'w-2',
      }, [
        { name: 'body', text: 'still private' },
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message', expect.anything())
    })

    it('still routes type=chat from a non-joined JID to chat:message (no regression)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(undefined)

      const stanza = createMockElement('message', {
        from: 'contact@example.com/phone',
        to: 'user@example.com',
        type: 'chat',
        id: 'c-1',
      }, [{ name: 'body', text: 'hi' }])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
    })
  })
})
