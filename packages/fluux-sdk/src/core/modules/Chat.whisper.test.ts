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

      await xmppClient.chat.sendWhisper('room@conference.example.com', 'bob', 'psst hello')

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
        }),
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())
    })
  })
})
