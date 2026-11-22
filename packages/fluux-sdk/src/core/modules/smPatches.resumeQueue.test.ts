/**
 * Resending after a XEP-0198 resumption, through the installed `@xmpp/client`
 * with the SDK's patches applied.
 *
 * A real client resumes a session without a socket: elements go in through the
 * library's own stream handling, and what it writes is captured at the transport.
 * The stanzas have the shape Fluux sends to ejabberd 26.09.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { client, xml, type Client, type Element } from '@xmpp/client'
import { patchSmAckQueue, patchSmOutboundCount, patchSmResumeQueue } from './smPatches'

const NS_SM = 'urn:xmpp:sm:3'
const NS_STREAM = 'http://etherx.jabber.org/streams'
const NS_SASL2 = 'urn:xmpp:sasl:2'
const NS_BIND2 = 'urn:xmpp:bind:0'
const SESSION = 'g2gCbQAAAAxmbHV1eC13ejRkcXRt'
const NEW_SESSION = 'g2gCbQAAAAxmbHV1eC1rN3BxdnM'
const SENT_AT = '2026-11-22T11:16:38.441Z'

interface Harness {
  xmppClient: Client
  session: string
  /** Stanzas written to the transport, in order. */
  wire: Element[]
  receive: (element: Element) => void
}

/** A new client holding what the previous one left unacknowledged, as Connection hydrates it. */
function resumingClient(acked: number, unacknowledged: Element[], session = SESSION): Harness {
  const xmppClient = client({
    service: 'wss://example.invalid/ws',
    domain: 'localhost',
    username: 'alice',
    password: 'unused',
  })
  const entity = xmppClient as unknown as {
    emit: (event: string, element: Element) => void
    _onElement: (element: Element) => void
    sendMany: (elements: Element[]) => Promise<void>
  }
  const wire: Element[] = []
  const write = (element: Element) => {
    wire.push(element)
    entity.emit('send', element)
  }
  xmppClient.send = async (element: Element) => write(element)
  entity.sendMany = async (elements: Element[]) => elements.forEach(write)

  const sm = xmppClient.streamManagement
  patchSmAckQueue(sm)
  patchSmOutboundCount(xmppClient)
  patchSmResumeQueue(xmppClient)
  sm.id = session
  sm.outbound = acked
  sm.outbound_q.push(...unacknowledged.map(stanza => ({ stanza, stamp: SENT_AT })))
  return { xmppClient, session, wire, receive: element => entity._onElement(element) }
}

function chat(id: string, body: string): Element {
  return xml('message', { to: 'bob@localhost', type: 'chat', id, xmlns: 'jabber:client' },
    xml('body', {}, body),
    xml('active', { xmlns: 'http://jabber.org/protocol/chatstates' }),
    xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id }))
}

function resumeWith(harness: Harness, h: number): Promise<void> {
  const { xmppClient, session, wire, receive } = harness
  receive(xml('stream:features', { 'xmlns:stream': NS_STREAM }, xml('sm', { xmlns: NS_SM })))
  return vi.waitFor(() => {
    if (!wire.some(element => element.is('resume', NS_SM))) throw new Error('no <resume/> yet')
  }).then(async () => {
    receive(xml('resumed', { xmlns: NS_SM, previd: session, h: String(h) }))
    await vi.waitFor(() => expect(xmppClient.status).toBe('online'))
  })
}

const stanzasOn = (wire: Element[]) => wire.filter(element => ['message', 'iq', 'presence'].includes(element.name))

describe('Resending after a resumption (patchSmResumeQueue)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resends the message the server did not receive, with its original time', async () => {
    const received = chat('6421e651', 'reached the server')
    const lost = chat('7b1f0a22', 'lost on the network')
    const harness = resumingClient(14, [received, lost])

    await resumeWith(harness, 15)

    const resent = stanzasOn(harness.wire)
    expect(resent.map(stanza => stanza.attrs.id)).toEqual(['7b1f0a22'])
    expect(resent[0].getChild('delay', 'urn:xmpp:delay')?.attrs.stamp).toBe(SENT_AT)
  })

  it('sends nothing again when the server already has every message', async () => {
    const harness = resumingClient(14, [chat('6421e651', 'ack was lost'), chat('7b1f0a22', 'ack was lost too')])

    await resumeWith(harness, 16)

    expect(stanzasOn(harness.wire)).toEqual([])
    expect(harness.xmppClient.streamManagement.outbound_q).toHaveLength(0)
    expect(harness.xmppClient.streamManagement.outbound).toBe(16)
  })

  it('counts a request the server received when working out which message is missing', async () => {
    const request = xml('iq', { type: 'get', id: 'vcard_48', to: 'bob@localhost', xmlns: 'jabber:client' },
      xml('vCard', { xmlns: 'vcard-temp' }))
    const harness = resumingClient(20, [request, chat('7b1f0a22', 'behind the request')])

    await resumeWith(harness, 21)

    expect(stanzasOn(harness.wire).map(stanza => stanza.attrs.id)).toEqual(['7b1f0a22'])
  })

  it('does not replay requests or presence the server did not receive', async () => {
    const request = xml('iq', { type: 'get', id: 'blocklist_1', xmlns: 'jabber:client' },
      xml('blocklist', { xmlns: 'urn:xmpp:blocking' }))
    const presence = xml('presence', { xmlns: 'jabber:client' }, xml('show', {}, 'away'))
    const harness = resumingClient(30, [request, presence, chat('7b1f0a22', 'still delivered')])

    await resumeWith(harness, 30)

    expect(stanzasOn(harness.wire).map(stanza => stanza.name)).toEqual(['message'])
  })

  it('completes the resume and resends the rest when a lost console message has an unusable address', async () => {
    const unusable = xml('message', { to: '@', type: 'chat', id: 'console_1', xmlns: 'jabber:client' }, xml('body', {}, 'typed in the console'))
    const harness = resumingClient(14, [unusable, chat('7b1f0a22', 'still delivered')])

    await resumeWith(harness, 14)

    expect(stanzasOn(harness.wire).map(stanza => stanza.attrs.id)).toEqual(['7b1f0a22'])
    expect(harness.xmppClient.streamManagement.outbound).toBe(14)
    expect(harness.xmppClient.streamManagement.outbound_q.map(item => item.stanza?.attrs.id)).toEqual(['7b1f0a22'])
  })

  it('keeps the resent message until the server acknowledges it', async () => {
    const harness = resumingClient(14, [chat('7b1f0a22', 'lost on the network')])
    await resumeWith(harness, 14)
    const sm = harness.xmppClient.streamManagement
    expect(sm.outbound_q.map(item => item.stanza?.attrs.id)).toEqual(['7b1f0a22'])

    harness.receive(xml('a', { xmlns: NS_SM, h: '15' }))

    await vi.waitFor(() => expect(sm.outbound_q).toHaveLength(0))
    expect(sm.outbound).toBe(15)
  })

  it('lowers a saved count that is ahead of the server, so the next ack is not held back', async () => {
    // After a page reload nothing can be resent, and the saved total still counts the lost message.
    const harness = resumingClient(16, [])
    await resumeWith(harness, 15)
    const sm = harness.xmppClient.streamManagement
    expect(sm.outbound).toBe(15)

    await harness.xmppClient.send(chat('9c44d1e0', 'after the reload'))
    harness.receive(xml('a', { xmlns: NS_SM, h: '16' }))

    await vi.waitFor(() => expect(sm.outbound_q).toHaveLength(0))
    expect(sm.outbound).toBe(16)
  })

  it('applies the count of a resumption inlined in the SASL2 success', () => {
    const lost = chat('7b1f0a22', 'lost on the network')
    const { xmppClient, receive } = resumingClient(14, [chat('6421e651', 'reached the server'), lost])

    receive(xml('success', { xmlns: NS_SASL2 }, xml('resumed', { xmlns: NS_SM, previd: SESSION, h: '15' })))

    const sm = xmppClient.streamManagement
    expect(sm.outbound).toBe(15)
    expect(sm.outbound_q.map(item => item.stanza)).toEqual([lost])
  })

  it('does not replay an old message after the server enabled a new session through Bind 2', async () => {
    const delivered = chat('6421e651', 'reached the old session')
    const harness = resumingClient(20, [delivered])
    const sm = harness.xmppClient.streamManagement

    // A server with Bind 2 stream management but no inline resumption: no <resume/> is offered.
    harness.receive(xml('stream:features', { 'xmlns:stream': NS_STREAM },
      xml('authentication', { xmlns: NS_SASL2 },
        xml('mechanism', {}, 'SCRAM-SHA-1'),
        xml('inline', {},
          xml('bind', { xmlns: NS_BIND2 },
            xml('inline', {}, xml('feature', { var: NS_SM })))))))
    await vi.waitFor(() => {
      if (!harness.wire.some(element => element.is('authenticate', NS_SASL2))) throw new Error('no <authenticate/> yet')
    })
    harness.receive(xml('success', { xmlns: NS_SASL2 },
      xml('authorization-identifier', {}, 'alice@localhost/fluux-wz4d'),
      xml('bound', { xmlns: NS_BIND2 }, xml('enabled', { xmlns: NS_SM, id: NEW_SESSION, resume: 'true', max: '600' }))))
    await vi.waitFor(() => expect(sm.id).toBe(NEW_SESSION))

    const unanswered = chat('9c44d1e0', 'sent in the new session')
    await harness.xmppClient.send(unanswered)
    const next = resumingClient(sm.outbound, sm.outbound_q.map(item => item.stanza as Element), NEW_SESSION)
    await resumeWith(next, 0)

    expect(stanzasOn(next.wire).map(stanza => stanza.attrs.id)).toEqual(['9c44d1e0'])
  })
})
