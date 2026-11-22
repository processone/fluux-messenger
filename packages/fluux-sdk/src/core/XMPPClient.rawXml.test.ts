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
