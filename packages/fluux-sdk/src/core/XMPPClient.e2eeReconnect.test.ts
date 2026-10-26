/**
 * FLM-157: the E2EE manager across a network loss.
 *
 * On a Stream Management resume the server replays, at once, the messages it
 * queued during the outage. The client used to drop its E2EE manager (and the
 * plugins registered on it) as soon as the socket closed, and build a new,
 * empty one only in the post-connect flow, so the replayed encrypted messages
 * and carbons were stored with their fallback text. The manager now stays
 * while the client reconnects on its own, and goes only when the session
 * ends: an explicit disconnect, a cancelled reconnect, a resource conflict or
 * an authentication failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { localStorageMock } from './sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const transport = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@xmpp/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xmpp/client')>()
  return { ...actual, client: vi.fn(() => transport.current) }
})
vi.mock('@xmpp/debug', () => ({ default: vi.fn() }))

import { xml, type Element } from '@xmpp/client'
import { XMPPClient } from './XMPPClient'
import { createMockXmppClient, type MockXmppClient } from './test-utils'
import { DummyPlaintextPlugin } from './e2ee/DummyPlaintextPlugin'
import { chatStore } from '../stores/chatStore'
import { rosterStore } from '../stores/rosterStore'
import type { Contact } from './types/roster'
import type { Message } from './types'

const ALICE = 'alice@example.test'
const BOB = 'bob@example.test'
// What the test plugin puts in <body> for clients that cannot decrypt.
const FALLBACK = '[dummy-plaintext payload]'

/** A message in Fluux's encrypted wire shape (Chat.applyE2EEToOutboundChat). */
function encrypted(attrs: Record<string, string>, text: string): Element {
  return xml('message', { type: 'chat', ...attrs },
    xml('body', {}, FALLBACK),
    xml('plain', { xmlns: 'urn:fluux:e2ee-dummy:0' }, Buffer.from(text).toString('base64')),
    xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:fluux:e2ee-dummy:0' }),
    xml('store', { xmlns: 'urn:xmpp:hints' }))
}

/** A carbon copy (XEP-0280) of `inner`, as the server sends it to this device. */
function carbon(kind: 'received' | 'sent', inner: Element): Element {
  return xml('message', { from: ALICE, to: `${ALICE}/web` },
    xml(kind, { xmlns: 'urn:xmpp:carbons:2' },
      xml('forwarded', { xmlns: 'urn:xmpp:forward:0' }, inner)))
}

describe('E2EE manager across a network loss', () => {
  let client: XMPPClient
  let socket: MockXmppClient
  let stored: Message[]
  let managersBuilt: number

  const useNewSocket = () => {
    socket = createMockXmppClient()
    transport.current = socket
  }

  beforeEach(async () => {
    vi.useFakeTimers()
    chatStore.getState().reset()
    rosterStore.getState().reset()
    client = new XMPPClient({ debug: false })
    stored = []
    client.subscribe('chat:message', ({ message }) => { stored.push(message) })
    managersBuilt = 0
    client.subscribe('e2ee:manager-ready', () => { managersBuilt++ })

    useNewSocket()
    const connecting = client.connect({
      jid: ALICE, password: 'fixture-only', server: 'wss://example.test/ws', resource: 'web', skipDiscovery: true,
      smState: { id: 'sm-session', inbound: 3, outbound: 0 },
    })
    socket._emit('online')
    await connecting
    await vi.advanceTimersByTimeAsync(10)
    // Bob is a contact (the login scoped the roster to Alice): a message from
    // a stranger is held as a request.
    rosterStore.getState().setContacts([{ jid: BOB, name: 'Bob', presence: 'online', subscription: 'both' } as Contact])
    expect(client.e2ee).not.toBeNull()
    await client.e2ee!.register(new DummyPlaintextPlugin())
  })

  afterEach(() => {
    client.cancelReconnect()
    client.destroy()
    vi.useRealTimers()
    chatStore.getState().reset()
    rosterStore.getState().reset()
  })

  /** The socket dies without a stream close, as on a network loss. */
  const loseNetwork = () => socket._emit('disconnect', { clean: false })

  it('decrypts the messages and carbons a resumed session replays, with the plugin registered before the drop', async () => {
    const manager = client.e2ee!
    const plugin = manager.getPlugin('dummy-plaintext')!
    const shutdown = vi.spyOn(plugin, 'shutdown')

    loseNetwork()
    const whileReconnecting = client.e2ee

    // The reconnect attempt resumes the stream, and the server replays its
    // queue in the same breath as the resume.
    useNewSocket()
    await vi.advanceTimersByTimeAsync(1_000)
    socket._emitSM('resumed')
    socket._emit('stanza', encrypted({ from: `${BOB}/phone`, to: `${ALICE}/web`, id: 'during-outage' }, 'sent while you were away'))
    socket._emit('stanza', carbon('received', encrypted({ from: `${BOB}/phone`, to: `${ALICE}/laptop`, id: 'to-laptop' }, 'reply to your laptop')))
    socket._emit('stanza', carbon('sent', encrypted({ from: `${ALICE}/laptop`, to: BOB, id: 'from-laptop' }, 'typed on the laptop')))
    await vi.advanceTimersByTimeAsync(100)

    // Stored with the decrypted text, never with the sender's fallback body.
    expect(stored.map((m) => [m.id, m.body, m.isOutgoing])).toEqual([
      ['during-outage', 'sent while you were away', false],
      ['to-laptop', 'reply to your laptop', false],
      ['from-laptop', 'typed on the laptop', true],
    ])
    // Because the manager, and the plugin on it, outlived the drop.
    expect(whileReconnecting).toBe(manager)
    expect(client.e2ee).toBe(manager)
    expect(managersBuilt).toBe(1)
    expect(shutdown).not.toHaveBeenCalled()
  })

  it('keeps the manager through a server restart, which also reconnects on its own', () => {
    const manager = client.e2ee
    socket._emit('error', new Error('system-shutdown'))
    expect(client.e2ee).toBe(manager)
  })

  describe('drops the manager and shuts its plugins down when the session ends', () => {
    const expectDropped = async (shutdown: ReturnType<typeof vi.fn>) => {
      expect(client.e2ee).toBeNull()
      await vi.advanceTimersByTimeAsync(0)
      expect(shutdown).toHaveBeenCalledTimes(1)
    }
    const spyShutdown = () => vi.spyOn(client.e2ee!.getPlugin('dummy-plaintext')!, 'shutdown') as unknown as ReturnType<typeof vi.fn>

    it('on an explicit disconnect', async () => {
      const shutdown = spyShutdown()
      await client.disconnect()
      await expectDropped(shutdown)
    })

    it('on an explicit disconnect while reconnecting', async () => {
      const shutdown = spyShutdown()
      loseNetwork()
      expect(client.e2ee).not.toBeNull()
      await client.disconnect()
      await expectDropped(shutdown)
    })

    it('when the reconnect is cancelled', async () => {
      const shutdown = spyShutdown()
      loseNetwork()
      expect(client.e2ee).not.toBeNull()
      client.cancelReconnect()
      await expectDropped(shutdown)
    })

    it('when another client replaces the session', async () => {
      const shutdown = spyShutdown()
      socket._emit('error', new Error('conflict'))
      socket._emit('disconnect', { clean: false })
      await expectDropped(shutdown)
    })

    it('when authentication fails during a reconnect', async () => {
      const shutdown = spyShutdown()
      loseNetwork()
      expect(client.e2ee).not.toBeNull()
      useNewSocket()
      // The server refuses the saved credentials while the attempt authenticates.
      socket.start.mockReturnValue(new Promise(() => {}))
      await vi.advanceTimersByTimeAsync(1_000)
      expect(socket.start).toHaveBeenCalled()
      expect(client.e2ee).not.toBeNull()
      socket._emit('error', new Error('not-authorized'))
      await expectDropped(shutdown)
    })
  })
})
