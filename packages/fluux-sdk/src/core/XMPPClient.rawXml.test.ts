/**
 * Raw XML sends and XEP-0198 outbound counting.
 *
 * Drives `sendRawXml` on the installed `@xmpp/client` with a stub socket, so the
 * real stream-management queue decides what each server `<a h/>` acknowledges.
 * The stanzas are the shapes people send from the XMPP console.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { client, xml, type Client, type Element } from '@xmpp/client'
import { XMPPClient } from './XMPPClient'
import { patchSmOutboundCount } from './modules/smPatches'

const NS_SM = 'urn:xmpp:sm:3'
const DISCO_ITEMS = `<iq type='get' id='omemo-check-1'><query xmlns='http://jabber.org/protocol/disco#items'/></iq>`

interface Harness {
  console: XMPPClient
  xmppClient: Client
  wire: string[]
  acknowledge: (h: number) => void
  queued: () => (string | undefined)[]
}

function startClient(): Harness {
  const xmppClient = client({
    service: 'wss://example.invalid/ws',
    domain: 'localhost',
    username: 'tester',
    password: 'unused',
  })
  const wire: string[] = []
  xmppClient.socket = {
    write: (data: string, done: (err?: Error) => void) => {
      wire.push(data)
      done()
    },
  }
  xmppClient.streamManagement.enabled = true
  patchSmOutboundCount(xmppClient)
  // connect() picks the transport that send() delegates to; this test never connects.
  const connection = xmppClient as unknown as { Transport: unknown; _findTransport: (service: string) => unknown }
  connection.Transport = connection._findTransport('wss://example.invalid/ws')

  const consoleClient = new XMPPClient({})
  // `requireTransport` is private to TypeScript only; an own property shadows the
  // prototype method, which keeps this test free of a connection state machine.
  ;(consoleClient as unknown as { requireTransport: () => Client }).requireTransport = () => xmppClient

  // `emit` is not on the SDK-facing declaration; this injects the server's element.
  const emitter = xmppClient as unknown as { emit: (event: string, element: Element) => void }
  return {
    console: consoleClient,
    xmppClient,
    wire,
    acknowledge: (h) => emitter.emit('element', xml('a', { xmlns: NS_SM, h: String(h) })),
    queued: () => xmppClient.streamManagement.outbound_q.map(item => item.stanza?.attrs.id),
  }
}

describe('sendRawXml and Stream Management', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps a chat message queued when the server acknowledges only the console stanza before it', async () => {
    const { console: consoleClient, xmppClient, acknowledge, queued } = startClient()
    const acknowledged: (string | undefined)[] = []
    xmppClient.streamManagement.on('ack', stanza => acknowledged.push(stanza.attrs.id))

    await consoleClient.sendRawXml(DISCO_ITEMS)
    await xmppClient.send(xml('message', { to: 'bob@localhost', type: 'chat', id: 'chat-1' }, xml('body', {}, 'Hello')))

    acknowledge(1)
    expect(acknowledged).toEqual(['omemo-check-1'])
    expect(queued()).toEqual(['chat-1'])

    acknowledge(2)
    expect(acknowledged).toEqual(['omemo-check-1', 'chat-1'])
    expect(queued()).toEqual([])
  })

  // ejabberd 26.09 counts each of these, although it refuses their address.
  it.each([
    ['iq to', `<iq type='get' id='bad-address' to='@'><ping xmlns='urn:xmpp:ping'/></iq>`],
    ['iq from', `<iq type='get' id='bad-address' from='@'><ping xmlns='urn:xmpp:ping'/></iq>`],
    ['message to', `<message id='bad-address' to='@'><body>Hello</body></message>`],
    ['message from', `<message id='bad-address' from='@' to='bob@localhost'><body>Hello</body></message>`],
    ['presence to', `<presence id='bad-address' to='/resource'/>`],
    ['presence from', `<presence id='bad-address' from='@'/>`],
  ])('keeps a chat message queued behind a console stanza with an unparsable %s', async (_shape, raw) => {
    const { console: consoleClient, xmppClient, wire, acknowledge, queued } = startClient()
    const logged: string[] = []
    xmppClient.on('send', element => logged.push(element.attrs.id))

    await expect(consoleClient.sendRawXml(raw)).resolves.toBeUndefined()
    await xmppClient.send(xml('message', { to: 'bob@localhost', type: 'chat', id: 'chat-1' }, xml('body', {}, 'Hello')))

    expect(wire[0]).toBe(raw)
    expect(logged).toEqual(['bad-address', 'chat-1'])
    acknowledge(1)
    expect(queued()).toEqual(['chat-1'])
    acknowledge(2)
    expect(queued()).toEqual([])
  })

  it('keeps an ordinary send with an unparsable address in the count, and still rejects it', async () => {
    const { xmppClient, acknowledge, queued } = startClient()

    await expect(xmppClient.send(xml('message', { to: '@', type: 'chat', id: 'bad-address' }, xml('body', {}, 'Hi'))))
      .rejects.toThrow('Invalid domain')
    await xmppClient.send(xml('message', { to: 'bob@localhost', type: 'chat', id: 'chat-1' }, xml('body', {}, 'Hello')))

    acknowledge(1)
    expect(queued()).toEqual(['chat-1'])
  })

  it('writes the typed text unchanged and leaves a non-stanza out of the count', async () => {
    const { console: consoleClient, wire, queued } = startClient()
    const typed = `<iq type='get'\n  id='ping-1'>\n  <ping xmlns='urn:xmpp:ping'/>\n</iq>`

    await consoleClient.sendRawXml(typed)
    await consoleClient.sendRawXml(`<r xmlns='${NS_SM}'/>`)

    expect(wire).toEqual([typed, `<r xmlns='${NS_SM}'/>`])
    expect(queued()).toEqual(['ping-1'])
  })

  it('counts every stanza of a write that holds several', async () => {
    const { console: consoleClient, queued } = startClient()

    await consoleClient.sendRawXml(`${DISCO_ITEMS}\n<presence id='presence-1'/>`)

    expect(queued()).toEqual(['omemo-check-1', 'presence-1'])
  })
})
