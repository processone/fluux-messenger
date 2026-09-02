import { describe, it, expect } from 'vitest'
import { outboundFacts, inboundReplyFacts, type ElementLike } from './stanzaFacts'

function el(
  name: string,
  attrs: Record<string, unknown> = {},
  children: ElementLike[] = [],
): ElementLike {
  return {
    name,
    attrs,
    children,
    getChild(childName: string, ns?: string) {
      return children.find((c) => c.name === childName && (ns === undefined || c.attrs.xmlns === ns))
    },
  }
}

function textEl(name: string, value: string): ElementLike {
  return {
    name,
    attrs: {},
    children: [value],
    getChild: () => undefined,
  }
}

describe('outboundFacts', () => {
  it('classifies a disco#info query and makes it dedupable', () => {
    const iq = el('iq', { type: 'get', to: 'example.com', id: 'q1' }, [
      el('query', { xmlns: 'http://jabber.org/protocol/disco#info' }),
    ])
    expect(outboundFacts(iq)).toEqual({
      id: 'q1',
      kind: 'disco-info',
      to: 'example.com',
      dedupe: 'disco-info|example.com|',
    })
  })

  it('separates two disco#info queries for different nodes', () => {
    const withNode = el('iq', { type: 'get', to: 'example.com', id: 'q2' }, [
      el('query', { xmlns: 'http://jabber.org/protocol/disco#info', node: 'urn:x:caps#v1' }),
    ])
    expect(outboundFacts(withNode)?.dedupe).toBe('disco-info|example.com|urn:x:caps#v1')
  })

  it('separates successive disco#items RSM pages', () => {
    const page = (id: string, after?: string) =>
      el('iq', { type: 'get', to: 'conference.example.com', id }, [
        el('query', { xmlns: 'http://jabber.org/protocol/disco#items' }, [
          el('set', { xmlns: 'http://jabber.org/protocol/rsm' }, [
            textEl('max', '20'),
            ...(after === undefined ? [] : [textEl('after', after)]),
          ]),
        ]),
      ])

    expect(outboundFacts(page('q3'))?.dedupe)
      .not.toBe(outboundFacts(page('q4', 'room-20'))?.dedupe)
  })

  it('normalizes every disco#items RSM selector field', () => {
    const query = (children: ElementLike[]) =>
      el('iq', { type: 'get', to: 'conference.example.com', id: 'q3' }, [
        el('query', { xmlns: 'http://jabber.org/protocol/disco#items' }, [
          el('set', { xmlns: 'http://jabber.org/protocol/rsm' }, children),
        ]),
      ])
    const forward = query([
      textEl('max', '20'),
      textEl('after', 'room-20'),
      textEl('before', ''),
      textEl('index', '20'),
    ])
    const reversed = query([
      textEl('index', '20'),
      textEl('before', ''),
      textEl('after', 'room-20'),
      textEl('max', '20'),
    ])

    expect(outboundFacts(forward)?.dedupe).toBe(
      'disco-items|conference.example.com||{"max":"20","after":"room-20","before":"","index":"20"}',
    )
    expect(outboundFacts(reversed)?.dedupe).toBe(outboundFacts(forward)?.dedupe)
  })

  it('classifies an avatar fetch by its pubsub node', () => {
    const iq = el('iq', { type: 'get', to: 'a@example.com', id: 'q5' }, [
      el('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' }, [
        el('items', { node: 'urn:xmpp:avatar:data' }),
      ]),
    ])
    const facts = outboundFacts(iq)
    expect(facts?.kind).toBe('avatar')
    expect(facts?.dedupe).toBe(
      'avatar|a@example.com|urn:xmpp:avatar:data|{"itemIds":[],"maxItems":"","subid":""}',
    )
  })

  it('separates avatar fetches for different item hashes', () => {
    const avatar = (id: string, hash: string) => el('iq', { type: 'get', to: 'a@example.com', id }, [
      el('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' }, [
        el('items', { node: 'urn:xmpp:avatar:data' }, [el('item', { id: hash })]),
      ]),
    ])

    expect(outboundFacts(avatar('q5', 'hash-a'))?.dedupe)
      .not.toBe(outboundFacts(avatar('q6', 'hash-b'))?.dedupe)
  })

  it('refuses to call a MAM page redundant', () => {
    const iq = el('iq', { type: 'set', to: 'a@example.com', id: 'q3' }, [
      el('query', { xmlns: 'urn:xmpp:mam:2' }),
    ])
    const facts = outboundFacts(iq)
    // Paging queries the same archive on purpose; a shared dedupe key would report
    // every second page as a redundant query.
    expect(facts?.kind).toBe('mam')
    expect(facts?.dedupe).toBeNull()
  })

  it('tracks an IQ set for replies without deduplicating its payload', () => {
    const iq = el('iq', { type: 'set', to: 'a@example.com', id: 'q7' }, [
      el('vCard', { xmlns: 'vcard-temp' }, [el('FN', {}, [])]),
    ])

    expect(outboundFacts(iq)).toEqual({
      id: 'q7',
      kind: 'vcard',
      to: 'a@example.com',
      dedupe: null,
    })
  })

  it('ignores messages, presence and IQ replies', () => {
    expect(outboundFacts(el('message', { to: 'a@example.com', id: 'm1' }))).toBeNull()
    expect(outboundFacts(el('presence', { id: 'p1' }))).toBeNull()
    expect(outboundFacts(el('iq', { type: 'result', id: 'r1', to: 'a@example.com' }))).toBeNull()
  })

  it('ignores an IQ with no id, which could never be paired', () => {
    const iq = el('iq', { type: 'get', to: 'example.com' }, [
      el('query', { xmlns: 'http://jabber.org/protocol/disco#info' }),
    ])
    expect(outboundFacts(iq)).toBeNull()
  })

  it('keys a query with no target on the empty string, which is the account server', () => {
    const iq = el('iq', { type: 'get', id: 'q4' }, [el('query', { xmlns: 'jabber:iq:roster' })])
    expect(outboundFacts(iq)).toEqual({ id: 'q4', kind: 'roster', to: '', dedupe: null })
  })
})

describe('inboundReplyFacts', () => {
  it('reports a result and an error alike', () => {
    expect(inboundReplyFacts(el('iq', { type: 'result', id: 'q1' }))).toEqual({
      id: 'q1',
      type: 'result',
    })
    expect(inboundReplyFacts(el('iq', { type: 'error', id: 'q1' }))).toEqual({
      id: 'q1',
      type: 'error',
    })
  })

  it('ignores an inbound request, which answers nothing', () => {
    expect(inboundReplyFacts(el('iq', { type: 'get', id: 'srv-1' }))).toBeNull()
    expect(inboundReplyFacts(el('message', { id: 'm1' }))).toBeNull()
  })
})
