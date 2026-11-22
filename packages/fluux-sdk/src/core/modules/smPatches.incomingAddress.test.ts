/**
 * Incoming stanzas whose address xmpp.js cannot parse.
 *
 * These feed the installed client's own parser for each transport, because the
 * failure is in how the parser recovers: a throw while it dispatches a stanza
 * leaves it nesting every later stanza inside that one. The first fixture is the
 * error reply ejabberd 26.09 sends to `<iq to='@'>`; the others are the same
 * stanza kinds with the address on either side.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { client, xml, type Client, type Element } from '@xmpp/client'
import { patchIncomingUnparsableAddress, patchSmInboundCount } from './smPatches'

const NS_CLIENT = 'jabber:client'
const ME = 'tester@localhost/fluux-wtd5cm'
const STREAM_HEADER =
  `<stream:stream xmlns='${NS_CLIENT}' xmlns:stream='http://etherx.jabber.org/streams' ` +
  `from='localhost' id='s1' version='1.0'>`

const BAD_ADDRESS_STANZAS: [string, string][] = [
  ['the server error reply to an iq sent to @',
    `<iq xmlns='${NS_CLIENT}' type='error' id='bad-address' from='@'><ping xmlns='urn:xmpp:ping'/>` +
    `<error type='modify'><text xml:lang='en' xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'>` +
    `Bad value of attribute &apos;to&apos; in tag &lt;iq/&gt; qualified by namespace ` +
    `&apos;jabber:client&apos;</text><bad-request xmlns='urn:ietf:params:xml:ns:xmpp-stanzas'/></error></iq>`],
  ['an iq with a bad to', `<iq xmlns='${NS_CLIENT}' type='result' id='bad-address' to='@' from='localhost'/>`],
  ['a message with a bad from', `<message xmlns='${NS_CLIENT}' id='bad-address' from='@' to='${ME}'><body>x</body></message>`],
  ['a message with a bad to', `<message xmlns='${NS_CLIENT}' id='bad-address' from='localhost' to='/phone'><body>x</body></message>`],
  ['a presence with a bad from', `<presence xmlns='${NS_CLIENT}' id='bad-address' from='@' to='${ME}'/>`],
  ['a presence with a bad to', `<presence xmlns='${NS_CLIENT}' id='bad-address' from='localhost' to='@'/>`],
]

const TRANSPORTS: { name: string; service: string; header: string }[] = [
  { name: 'WebSocket', service: 'wss://example.invalid/ws', header: '' },
  { name: 'TCP', service: 'xmpp://example.invalid:5222', header: STREAM_HEADER },
]

interface StreamParser {
  write: (data: string) => void
}

interface ConnectionInternals {
  Transport: { prototype: { Parser: new () => StreamParser } }
  _findTransport: (service: string) => ConnectionInternals['Transport']
  _attachParser: (parser: StreamParser) => void
}

interface Harness {
  xmppClient: Client
  /** Write one chunk to the parser, as the socket does. */
  receive: (data: string) => void
  /** Ids of the stanzas the app's handlers were given. */
  handled: string[]
  /** Serialized elements seen by `element` listeners, which feed the XMPP console. */
  logged: string[]
}

function startClient(service: string, header: string): Harness {
  const xmppClient = client({ service, domain: 'localhost', username: 'tester', password: 'unused' })
  xmppClient.send = async () => {}
  xmppClient.streamManagement.enabled = true
  patchSmInboundCount(xmppClient)
  patchIncomingUnparsableAddress(xmppClient)

  const handled: string[] = []
  const logged: string[] = []
  xmppClient.on('stanza', (stanza: Element) => { handled.push(stanza.attrs.id) })
  xmppClient.on('element', (element: Element) => { logged.push(element.toString()) })

  const connection = xmppClient as unknown as ConnectionInternals
  connection.Transport = connection._findTransport(service)
  const parser = new connection.Transport.prototype.Parser()
  connection._attachParser(parser)
  if (header) parser.write(header)
  return { xmppClient, receive: (data) => parser.write(data), handled, logged }
}

function pingReply(id: string): string {
  return `<iq xmlns='${NS_CLIENT}' type='result' id='${id}' from='localhost' to='${ME}'/>`
}

describe.each(TRANSPORTS)('incoming unparsable addresses over $name', ({ service, header }) => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(BAD_ADDRESS_STANZAS)('keeps receiving after %s', async (_shape, badStanza) => {
    const { xmppClient, receive, handled } = startClient(service, header)
    const request = xmppClient.iqCaller.request(
      xml('iq', { type: 'get', to: 'localhost', id: 'ping-after' }, xml('ping', { xmlns: 'urn:xmpp:ping' })))

    receive(badStanza)
    receive(pingReply('ping-after'))
    receive(`<message xmlns='${NS_CLIENT}' id='chat-after' from='bob@localhost/phone' to='${ME}'><body>hi</body></message>`)

    await expect(request).resolves.toBeDefined()
    expect(handled).toContain('chat-after')
    expect(handled).not.toContain('bad-address')
    // XEP-0198 counts every stanza received, including the one the app cannot use.
    expect(xmppClient.streamManagement.inbound).toBe(3)
  })

  it('still shows the unusable stanza in the XMPP console log', () => {
    const { receive, logged } = startClient(service, header)

    receive(BAD_ADDRESS_STANZAS[0][1])

    expect(logged).toHaveLength(1)
    expect(logged[0]).toContain(`id="bad-address"`)
  })
})

describe('incoming unparsable addresses in a TCP read', () => {
  it('delivers the stanzas that follow in the same chunk', () => {
    vi.useFakeTimers()
    try {
      const { xmppClient, receive, handled } = startClient('xmpp://example.invalid:5222', STREAM_HEADER)

      receive(BAD_ADDRESS_STANZAS[0][1] + pingReply('same-chunk'))

      expect(handled).toEqual(['same-chunk'])
      expect(xmppClient.streamManagement.inbound).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
