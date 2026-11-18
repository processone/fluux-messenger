/**
 * XEP-0198 inbound counter `h` of the installed `@xmpp/client`, with the SDK's
 * patchSmInboundCount applied.
 *
 * These drive a real client without a socket: stanzas go in as incoming
 * elements through the library's own middleware, and what the client sends
 * back is captured at `send`. The stanza shapes are the ones ejabberd 26.09
 * sends during Fluux's startup. A resumed session sends this same counter as
 * `<resume h/>`, so a stanza missing from it is resent by the server.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { client, xml, type Client, type Element } from '@xmpp/client'
import { patchSmInboundCount } from './smPatches'

const NS_SM = 'urn:xmpp:sm:3'
const ME = 'tester@localhost/fluux-wtd5cm'

interface Harness {
  xmppClient: Client
  sent: Element[]
  receive: (element: Element) => void
}

function startClient(): Harness {
  const xmppClient = client({
    service: 'wss://example.invalid/ws',
    domain: 'localhost',
    username: 'tester',
    password: 'unused',
  })
  const sent: Element[] = []
  xmppClient.send = async (element: Element) => { sent.push(element) }
  xmppClient.streamManagement.enabled = true
  patchSmInboundCount(xmppClient)
  // The client is an EventEmitter underneath; `emit` is not on the SDK-facing
  // declaration because nothing in the SDK should be injecting stream elements.
  const emitter = xmppClient as unknown as { emit: (event: string, element: Element) => void }
  return { xmppClient, sent, receive: (element) => emitter.emit('element', element) }
}

function rosterResult(id: string): Element {
  return xml('iq', { xmlns: 'jabber:client', to: ME, from: 'tester@localhost', type: 'result', id },
    xml('query', { xmlns: 'jabber:iq:roster' }))
}

function nodeNotFound(id: string, node: string): Element {
  return xml('iq', { xmlns: 'jabber:client', to: ME, from: 'tester@localhost', type: 'error', id },
    xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' }, xml('items', { node })),
    xml('error', { type: 'cancel' },
      xml('item-not-found', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas' }),
      xml('text', { xmlns: 'urn:ietf:params:xml:ns:xmpp-stanzas', 'xml:lang': 'en' }, 'Node not found')))
}

/** The `h` of the last `<a/>` the client sent. */
function lastAck(sent: Element[]): string | undefined {
  return sent.filter(element => element.is('a', NS_SM)).at(-1)?.attrs.h
}

describe('Stream Management inbound counter (patchSmInboundCount)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('acknowledges the replies to our own requests when the server asks', async () => {
    const { xmppClient, sent, receive } = startClient()

    const roster = xmppClient.iqCaller.request(
      xml('iq', { type: 'get', id: 'roster_f2e39b50' }, xml('query', { xmlns: 'jabber:iq:roster' })))
    receive(rosterResult('roster_f2e39b50'))
    await expect(roster).resolves.toBeDefined()

    const avatar = xmppClient.iqCaller.request(
      xml('iq', { type: 'get', to: 'tester@localhost', id: 'pep_get_4b6e330d' },
        xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
          xml('items', { node: 'urn:xmpp:avatar:metadata', max_items: '1' }))))
    receive(nodeNotFound('pep_get_4b6e330d', 'urn:xmpp:avatar:metadata'))
    await expect(avatar).rejects.toMatchObject({ condition: 'item-not-found' })

    receive(xml('r', { xmlns: NS_SM }))

    expect(lastAck(sent)).toBe('2')
  })

  it('counts a malformed query that the library answers on its own', () => {
    const { xmppClient, sent, receive } = startClient()

    // An iq get must carry exactly one child; the library answers bad-request itself.
    receive(xml('iq', { xmlns: 'jabber:client', to: ME, from: 'localhost', type: 'get', id: 'malformed1' }))

    expect(xmppClient.streamManagement.inbound).toBe(1)
    return vi.waitFor(() => {
      expect(sent.find(element => element.attrs.id === 'malformed1')?.attrs.type).toBe('error')
    })
  })

  it('counts stanzas that already reach the library counter only once', async () => {
    const { xmppClient, sent, receive } = startClient()

    // A pushed bookmark event, room presence, the server's ping and a late reply to a request that timed out.
    receive(xml('message', { xmlns: 'jabber:client', to: ME, from: 'tester@localhost', type: 'headline' },
      xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
        xml('items', { node: 'urn:xmpp:bookmarks:1' },
          xml('item', { id: 'team@conference.localhost' },
            xml('conference', { xmlns: 'urn:xmpp:bookmarks:1', autojoin: 'true', name: 'Team' }))))))
    receive(xml('presence', { xmlns: 'jabber:client', to: ME, from: 'team@conference.localhost/tester' },
      xml('x', { xmlns: 'http://jabber.org/protocol/muc#user' },
        xml('item', { affiliation: 'owner', role: 'moderator' }))))
    receive(xml('iq', { xmlns: 'jabber:client', to: ME, from: 'localhost', type: 'get', id: 's2c1' },
      xml('ping', { xmlns: 'urn:xmpp:ping' })))
    receive(rosterResult('timed_out_request'))

    expect(xmppClient.streamManagement.inbound).toBe(4)
    await vi.waitFor(() => {
      expect(sent.find(element => element.attrs.id === 's2c1')?.attrs.type).toBe('result')
    })
  })
})
