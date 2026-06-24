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
import { WhisperCounterpartGoneError } from '../errors'

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
      const room = createMockRoom('room@conference.example.com', {
        joined: true,
        nickname: 'me',
        occupants: new Map([
          ['bob', { nick: 'bob', affiliation: 'member', role: 'participant', occupantId: 'occ-bob' }],
        ]),
      })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      await xmppClient.chat.sendWhisper('room@conference.example.com', 'bob', 'psst hello')

      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isPrivate: true,
          isOutgoing: true,
          whisperWith: 'bob',
          body: 'psst hello',
          originId: expect.any(String),
        }),
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())

      // Whispers are locally durable now: not flagged noLocalStore, and they carry
      // the counterpart's occupant-id (resolved from the occupants map) so a recycled
      // nick can't be mis-addressed when replying later.
      const whisperCall = emitSDKSpy.mock.calls.find((c: any) => c[0] === 'room:whisper')
      const whisperMsg = (whisperCall?.[1] as any)?.message
      expect(whisperMsg.noLocalStore).toBeUndefined()
      expect(whisperMsg.whisperWithOccupantId).toBe('occ-bob')
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
      }, [
        { name: 'body', text: 'between us' },
        { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' } },
      ])

      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isPrivate: true,
          isOutgoing: false,
          nick: 'bob',
          whisperWith: 'bob',
          body: 'between us',
        }),
        incrementUnread: true,
        incrementMentions: true,
      }))

      // Incoming whisper is locally durable and carries the sender's occupant-id.
      const whisperCall = emitSDKSpy.mock.calls.find((c: any) => c[0] === 'room:whisper')
      const whisperMsg = (whisperCall?.[1] as any)?.message
      expect(whisperMsg.noLocalStore).toBeUndefined()
      expect(whisperMsg.whisperWithOccupantId).toBe('occ-bob')
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

    it('processes a sent-carbon wrapping a whisper with isOutgoing:true', async () => {
      await connectClient()
      const room = createMockRoom('room@conference.example.com', { joined: true, nickname: 'me' })
      vi.mocked(mockStores.room.getRoom).mockReturnValue(room)

      // XEP-0280 sent carbon: outer message is from our own bare JID; the inner
      // forwarded message is the whisper we sent to room/bob.
      const carbonStanza = createMockElement('message', {
        from: 'user@example.com',
        to: 'user@example.com/other-device',
      }, [
        {
          name: 'sent',
          attrs: { xmlns: 'urn:xmpp:carbons:2' },
          children: [
            {
              name: 'forwarded',
              attrs: { xmlns: 'urn:xmpp:forward:0' },
              children: [
                {
                  name: 'message',
                  attrs: {
                    from: 'room@conference.example.com/bob',
                    to: 'user@example.com/primary',
                    type: 'chat',
                    id: 'wc-sent-1',
                  },
                  children: [
                    { name: 'body', text: 'whisper carbon' },
                  ],
                },
              ],
            },
          ],
        },
      ])

      mockXmppClientInstance._emit('stanza', carbonStanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.objectContaining({
        roomJid: 'room@conference.example.com',
        message: expect.objectContaining({
          isPrivate: true,
          isOutgoing: true,
        }),
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('chat:message', expect.anything())

      // Sent-carbon whisper is also locally durable.
      const whisperCall = emitSDKSpy.mock.calls.find((c: any) => c[0] === 'room:whisper')
      const whisperMsg = (whisperCall?.[1] as any)?.message
      expect(whisperMsg.noLocalStore).toBeUndefined()
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

      expect(mockStores.room.getRoom).toHaveBeenCalledWith('contact@example.com')
      expect(emitSDKSpy).toHaveBeenCalledWith('chat:message', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
    })
  })

  describe('whisper operations (send)', () => {
    const ROOM = 'room@conference.example.com'

    function roomWithBob(occupants: Map<string, any> = new Map([
      ['bob', { nick: 'bob', affiliation: 'member', role: 'participant', occupantId: 'occ-bob' }],
    ])) {
      return createMockRoom(ROOM, { joined: true, nickname: 'me', occupants })
    }

    function storedWhisper(overrides: Record<string, unknown> = {}) {
      return {
        // id and originId are INTENTIONALLY different so that send tests can prove the
        // code uses origin-id (not message-id) as the protocol reference. Whispers are
        // <no-store>, so the correct reference is `originId ?? messageId`.
        type: 'groupchat', id: 'w-msg-1', originId: 'w-1', roomJid: ROOM,
        from: `${ROOM}/me`, nick: 'me', body: 'secret', timestamp: new Date(),
        isOutgoing: true, isPrivate: true, whisperWith: 'bob', whisperWithOccupantId: 'occ-bob',
        ...overrides,
      }
    }

    it('sendCorrection on a whisper addresses room/nick privately (type=chat, muc#user, no-store, origin-id)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
      vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

      // Pass the message-id (w-msg-1) to the operation; assert that the protocol
      // reference is the origin-id (w-1). If the code used message-id, this would
      // be 'w-msg-1' and the test would fail — proving origin-id is used.
      await xmppClient.chat.sendCorrection(ROOM, 'w-msg-1', 'fixed secret', 'groupchat')

      const sent = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sent.attrs.to).toBe(`${ROOM}/bob`)
      expect(sent.attrs.type).toBe('chat')
      const replace = sent.children.find((c: any) => c.name === 'replace')
      expect(replace.attrs.id).toBe('w-1')
      expect(sent.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user')).toBeDefined()
      const noStore = sent.children.find((c: any) => c.name === 'no-store')
      expect(noStore).toBeDefined()
      expect(noStore.attrs.xmlns).toBe('urn:xmpp:hints')
    })

    it('sendCorrection on a public room message still broadcasts to the room (no regression)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        type: 'groupchat', id: 'm-1', originId: 'm-1', roomJid: ROOM, from: `${ROOM}/me`,
        nick: 'me', body: 'hi', timestamp: new Date(), isOutgoing: true,
      } as any)

      await xmppClient.chat.sendCorrection(ROOM, 'm-1', 'hi fixed', 'groupchat')

      const sent = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sent.attrs.to).toBe(ROOM)
      expect(sent.attrs.type).toBe('groupchat')
      expect(sent.children.find((c: any) => c.name === 'no-store')).toBeUndefined()
    })

    it('throws WhisperCounterpartGoneError and sends nothing when the counterpart has left', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob(new Map()))
      vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

      await expect(
        xmppClient.chat.sendCorrection(ROOM, 'w-msg-1', 'x', 'groupchat'),
      ).rejects.toThrow(WhisperCounterpartGoneError)
      expect(mockXmppClientInstance.send).not.toHaveBeenCalled()
    })

    it('re-resolves the current nick from occupant-id after a rename', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob(new Map([
        ['bobby', { nick: 'bobby', affiliation: 'member', role: 'participant', occupantId: 'occ-bob' }],
      ])))
      vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

      await xmppClient.chat.sendCorrection(ROOM, 'w-msg-1', 'fixed', 'groupchat')

      expect(mockXmppClientInstance.send.mock.calls[0][0].attrs.to).toBe(`${ROOM}/bobby`)
    })

    it('sendReaction on a whisper addresses room/nick privately with no-store (not the room)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
      vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

      // Pass the message-id (w-msg-1); the protocol reference must be the origin-id (w-1).
      await xmppClient.chat.sendReaction(ROOM, 'w-msg-1', ['👍'], 'groupchat')

      const sent = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sent.attrs.to).toBe(`${ROOM}/bob`)
      expect(sent.attrs.type).toBe('chat')
      const reactions = sent.children.find((c: any) => c.name === 'reactions')
      expect(reactions.attrs.id).toBe('w-1')
      expect(sent.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user')).toBeDefined()
      const noStore = sent.children.find((c: any) => c.name === 'no-store')
      expect(noStore).toBeDefined()
      expect(noStore.attrs.xmlns).toBe('urn:xmpp:hints')
      expect(sent.children.find((c: any) => c.name === 'store')).toBeUndefined()
    })

    it('sendRetraction on a whisper addresses room/nick privately with no-store (not the room)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
      vi.mocked(mockStores.room.getMessage).mockReturnValue(storedWhisper() as any)

      // Pass the message-id (w-msg-1); the protocol reference must be the origin-id (w-1).
      await xmppClient.chat.sendRetraction(ROOM, 'w-msg-1', 'groupchat')

      const sent = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sent.attrs.to).toBe(`${ROOM}/bob`)
      expect(sent.attrs.type).toBe('chat')
      const retract = sent.children.find((c: any) => c.name === 'retract')
      expect(retract.attrs.id).toBe('w-1')
      expect(sent.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user')).toBeDefined()
      const noStore = sent.children.find((c: any) => c.name === 'no-store')
      expect(noStore).toBeDefined()
      expect(noStore.attrs.xmlns).toBe('urn:xmpp:hints')
    })

    it('sendReaction on a public room message still broadcasts to the room (no regression)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        type: 'groupchat', id: 'm-1', originId: 'm-1', roomJid: ROOM,
        from: `${ROOM}/me`, nick: 'me', body: 'hi', timestamp: new Date(), isOutgoing: true,
      } as any)

      await xmppClient.chat.sendReaction(ROOM, 'm-1', ['👍'], 'groupchat')

      const sent = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sent.attrs.to).toBe(ROOM)
      expect(sent.attrs.type).toBe('groupchat')
      expect(sent.children.find((c: any) => c.name === 'no-store')).toBeUndefined()
      expect(sent.children.find((c: any) => c.name === 'x')).toBeUndefined()
      expect(sent.children.find((c: any) => c.name === 'store')).toBeDefined()
    })

    it('sendRetraction on a public room message still broadcasts to the room (no regression)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(roomWithBob())
      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        type: 'groupchat', id: 'm-1', originId: 'm-1', roomJid: ROOM,
        from: `${ROOM}/me`, nick: 'me', body: 'hi', timestamp: new Date(), isOutgoing: true,
      } as any)

      await xmppClient.chat.sendRetraction(ROOM, 'm-1', 'groupchat')

      const sent = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sent.attrs.to).toBe(ROOM)
      expect(sent.attrs.type).toBe('groupchat')
      expect(sent.children.find((c: any) => c.name === 'no-store')).toBeUndefined()
      expect(sent.children.find((c: any) => c.name === 'x')).toBeUndefined()
    })

    it('sendWhisperChatState sends a private chat-state to room/nick (muc#user, no-store)', async () => {
      await connectClient()

      await xmppClient.chat.sendWhisperChatState(ROOM, 'bob', 'composing')

      const sent = mockXmppClientInstance.send.mock.calls[0][0]
      expect(sent.attrs.to).toBe(`${ROOM}/bob`)
      expect(sent.attrs.type).toBe('chat')
      const composingEl = sent.children.find((c: any) => c.name === 'composing')
      expect(composingEl).toBeDefined()
      expect(composingEl.attrs.xmlns).toBe('http://jabber.org/protocol/chatstates')
      expect(sent.children.find((c: any) => c.name === 'x' && c.attrs.xmlns === 'http://jabber.org/protocol/muc#user')).toBeDefined()
      const noStoreEl = sent.children.find((c: any) => c.name === 'no-store')
      expect(noStoreEl).toBeDefined()
      expect(noStoreEl.attrs.xmlns).toBe('urn:xmpp:hints')
    })
  })

  describe('whisper operations (receive)', () => {
    const ROOM = 'room@conference.example.com'

    beforeEach(() => {
      vi.mocked(mockStores.room.getRoom).mockReturnValue(
        createMockRoom(ROOM, { joined: true, nickname: 'me' }),
      )
    })

    it('incoming whisper reaction updates the whisper thread, not a new whisper', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(createMockRoom(ROOM, { joined: true, nickname: 'me' }))

      const stanza = createMockElement('message', {
        from: `${ROOM}/bob`, to: 'user@example.com', type: 'chat', id: 'r-1',
      }, [
        { name: 'reactions', attrs: { xmlns: 'urn:xmpp:reactions:0', id: 'w-1' }, children: [{ name: 'reaction', text: '👍' }] },
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
        { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' } },
      ])
      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:reactions', expect.objectContaining({
        roomJid: ROOM, messageId: 'w-1', reactorNick: 'bob', emojis: ['👍'],
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
    })

    it('incoming whisper correction updates the existing whisper (not a new whisper)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(createMockRoom(ROOM, { joined: true, nickname: 'me' }))
      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        id: 'bw-1', originId: 'bw-1', from: `${ROOM}/bob`, nick: 'bob', body: 'old',
        isPrivate: true, whisperWith: 'bob', occupantId: 'occ-bob', timestamp: new Date(),
      } as any)

      const stanza = createMockElement('message', {
        from: `${ROOM}/bob`, to: 'user@example.com', type: 'chat', id: 'corr-1',
      }, [
        { name: 'body', text: 'new text' },
        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'bw-1' } },
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
        { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' } },
      ])
      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', expect.objectContaining({
        roomJid: ROOM, messageId: 'bw-1', updates: expect.objectContaining({ body: 'new text', isEdited: true }),
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
    })

    it('incoming whisper retraction marks the whisper retracted (not a new whisper)', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(createMockRoom(ROOM, { joined: true, nickname: 'me' }))
      vi.mocked(mockStores.room.getMessage).mockReturnValue({
        id: 'bw-1', from: `${ROOM}/bob`, nick: 'bob', occupantId: 'occ-bob',
        isPrivate: true, whisperWith: 'bob', timestamp: new Date(),
      } as any)

      const stanza = createMockElement('message', {
        from: `${ROOM}/bob`, to: 'user@example.com', type: 'chat', id: 'rt-1',
      }, [
        { name: 'body', text: 'This person attempted to retract a previous message...' },
        { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'bw-1' } },
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
        { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' } },
      ])
      mockXmppClientInstance._emit('stanza', stanza)

      expect(emitSDKSpy).toHaveBeenCalledWith('room:message-updated', expect.objectContaining({
        roomJid: ROOM, messageId: 'bw-1', updates: expect.objectContaining({ isRetracted: true }),
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
    })

    it('incoming whisper retraction with no matching message is consumed, not shown as a new whisper', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(createMockRoom(ROOM, { joined: true, nickname: 'me' }))
      // getMessage is left at its fresh default (returns undefined) — no match.

      const stanza = createMockElement('message', {
        from: `${ROOM}/bob`, to: 'user@example.com', type: 'chat', id: 'rt-x',
      }, [
        { name: 'body', text: 'This person attempted to retract a previous message...' },
        { name: 'retract', attrs: { xmlns: 'urn:xmpp:message-retract:1', id: 'nonexistent' } },
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
        { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' } },
      ])
      mockXmppClientInstance._emit('stanza', stanza)

      // The body is the XEP-0428 fallback notice; it must NOT surface as a new whisper,
      // and with no match there is nothing to update.
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:whisper', expect.anything())
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message-updated', expect.anything())
    })

    it('incoming whisper correction with no matching message falls through to a new whisper', async () => {
      await connectClient()
      vi.mocked(mockStores.room.getRoom).mockReturnValue(createMockRoom(ROOM, { joined: true, nickname: 'me' }))
      // getMessage is left at its fresh default (returns undefined) — handleIncomingCorrection returns false.

      const stanza = createMockElement('message', {
        from: `${ROOM}/bob`, to: 'user@example.com', type: 'chat', id: 'corr-x',
      }, [
        { name: 'body', text: 'corrected but orphaned' },
        { name: 'replace', attrs: { xmlns: 'urn:xmpp:message-correct:0', id: 'nonexistent' } },
        { name: 'x', attrs: { xmlns: 'http://jabber.org/protocol/muc#user' } },
        { name: 'occupant-id', attrs: { xmlns: 'urn:xmpp:occupant-id:0', id: 'occ-bob' } },
      ])
      mockXmppClientInstance._emit('stanza', stanza)

      // No stored original to correct, so the corrected text is shown as a new whisper.
      expect(emitSDKSpy).toHaveBeenCalledWith('room:whisper', expect.objectContaining({
        roomJid: ROOM,
        message: expect.objectContaining({ body: 'corrected but orphaned', isPrivate: true }),
      }))
      expect(emitSDKSpy).not.toHaveBeenCalledWith('room:message-updated', expect.anything())
    })
  })
})
