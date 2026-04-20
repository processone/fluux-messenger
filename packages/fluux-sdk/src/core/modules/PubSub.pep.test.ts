/**
 * PubSub PEP publish/query/subscribe tests.
 *
 * Uses real @xmpp/client (no mocking) so stanza construction and parsing
 * go through the real `xml` builder — matches the integration patterns
 * real plugins will exercise.
 */
import { describe, it, expect, vi } from 'vitest'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { PubSub } from './PubSub'
import type { ModuleDependencies } from './BaseModule'
import type { PEPItem } from '../e2ee'

function makeDeps(sendIQ: (iq: Element) => Promise<Element>): ModuleDependencies {
  return {
    stores: null,
    sendStanza: async () => {},
    sendIQ,
    getCurrentJid: () => 'me@example.com',
    emit: () => {},
    emitSDK: () => {},
    getXmpp: () => null,
  }
}

describe('PubSub.publish', () => {
  it('sends an IQ set with pubsub/publish/item carrying the payload', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => {
      captured = iq
      return xml('iq', { type: 'result', id: iq.attrs.id })
    })
    const pubsub = new PubSub(deps)

    await pubsub.publish('urn:xmpp:openpgp:0:public-keys', {
      id: 'current',
      payload: {
        name: 'pubkey',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: ['BASE64DATA'],
      },
    })

    expect(captured).not.toBeNull()
    expect(captured!.attrs.type).toBe('set')
    const pubsubEl = captured!.getChild('pubsub', 'http://jabber.org/protocol/pubsub')
    expect(pubsubEl).toBeDefined()
    const publish = pubsubEl!.getChild('publish')
    expect(publish?.attrs.node).toBe('urn:xmpp:openpgp:0:public-keys')
    const item = publish?.getChild('item')
    expect(item?.attrs.id).toBe('current')
    const pubkey = item?.getChild('pubkey', 'urn:xmpp:openpgp:0')
    expect(pubkey?.text()).toBe('BASE64DATA')
  })

  it('includes publish-options form fields when options are supplied', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => {
      captured = iq
      return xml('iq', { type: 'result', id: iq.attrs.id })
    })
    const pubsub = new PubSub(deps)

    await pubsub.publish(
      'node',
      { id: '1', payload: { name: 'x', attrs: {}, children: [] } },
      { persistItems: true, accessModel: 'whitelist', maxItems: 1 },
    )

    const options = captured!
      .getChild('pubsub', 'http://jabber.org/protocol/pubsub')!
      .getChild('publish-options')
    expect(options).toBeDefined()
    const form = options!.getChild('x', 'jabber:x:data')
    const fields = form?.getChildren('field') ?? []
    const byVar = new Map(fields.map((f: Element) => [f.attrs.var, f.getChild('value')?.text()]))
    expect(byVar.get('FORM_TYPE')).toBe('http://jabber.org/protocol/pubsub#publish-options')
    expect(byVar.get('pubsub#persist_items')).toBe('1')
    expect(byVar.get('pubsub#access_model')).toBe('whitelist')
    expect(byVar.get('pubsub#max_items')).toBe('1')
  })

  it('omits publish-options when no options are provided', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => {
      captured = iq
      return xml('iq', { type: 'result', id: iq.attrs.id })
    })
    const pubsub = new PubSub(deps)

    await pubsub.publish('n', { id: 'i', payload: { name: 'x', attrs: {}, children: [] } })

    const options = captured!
      .getChild('pubsub', 'http://jabber.org/protocol/pubsub')!
      .getChild('publish-options')
    expect(options).toBeUndefined()
  })
})

describe('PubSub.retract', () => {
  it('sends an IQ set with pubsub/retract/item[@id]', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => {
      captured = iq
      return xml('iq', { type: 'result', id: iq.attrs.id })
    })
    const pubsub = new PubSub(deps)

    await pubsub.retract('node', 'item-5')

    const retract = captured!
      .getChild('pubsub', 'http://jabber.org/protocol/pubsub')!
      .getChild('retract')
    expect(retract?.attrs.node).toBe('node')
    expect(retract?.getChild('item')?.attrs.id).toBe('item-5')
  })
})

describe('PubSub.query', () => {
  it('parses returned items and their payload children', async () => {
    const response = xml(
      'iq',
      { type: 'result', id: 'x' },
      xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
        xml('items', { node: 'urn:xmpp:openpgp:0:public-keys' },
          xml('item', { id: 'key-1' },
            xml('pubkey', { xmlns: 'urn:xmpp:openpgp:0' }, 'AAA'),
          ),
          xml('item', { id: 'key-2' },
            xml('pubkey', { xmlns: 'urn:xmpp:openpgp:0' }, 'BBB'),
          ),
        ),
      ),
    )
    const deps = makeDeps(async () => response)
    const pubsub = new PubSub(deps)

    const items = await pubsub.query('bob@example.com', 'urn:xmpp:openpgp:0:public-keys')
    expect(items).toHaveLength(2)
    expect(items[0].id).toBe('key-1')
    expect(items[0].payload.name).toBe('pubkey')
    expect(items[0].payload.attrs.xmlns).toBe('urn:xmpp:openpgp:0')
    expect(items[0].payload.children).toEqual(['AAA'])
    expect(items[1].id).toBe('key-2')
    expect(items[1].payload.children).toEqual(['BBB'])
  })

  it('returns empty array when the node has no items', async () => {
    const deps = makeDeps(async () =>
      xml('iq', { type: 'result' },
        xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' }),
      ),
    )
    const pubsub = new PubSub(deps)
    const items = await pubsub.query('bob@example.com', 'some:node')
    expect(items).toEqual([])
  })

  it('includes max_items on the items element when requested', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => {
      captured = iq
      return xml('iq', { type: 'result' })
    })
    const pubsub = new PubSub(deps)

    await pubsub.query('bob@example.com', 'node', 5)
    const itemsEl = captured!
      .getChild('pubsub', 'http://jabber.org/protocol/pubsub')!
      .getChild('items')
    expect(itemsEl?.attrs.max_items).toBe('5')
  })

  it('propagates the target JID on the IQ', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => {
      captured = iq
      return xml('iq', { type: 'result' })
    })
    const pubsub = new PubSub(deps)

    await pubsub.query('bob@example.com', 'n')
    expect(captured!.attrs.to).toBe('bob@example.com')
    expect(captured!.attrs.type).toBe('get')
  })
})

describe('PubSub.subscribe', () => {
  it('invokes the callback when a matching event arrives', () => {
    const deps = makeDeps(async () => xml('iq', {}))
    const pubsub = new PubSub(deps)
    const received: PEPItem[] = []
    pubsub.subscribe('bob@example.com', 'urn:xmpp:openpgp:0:public-keys', (item) => {
      received.push(item)
    })

    const eventStanza = xml(
      'message',
      { from: 'bob@example.com/r', to: 'me@example.com' },
      xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
        xml('items', { node: 'urn:xmpp:openpgp:0:public-keys' },
          xml('item', { id: 'current' },
            xml('pubkey', { xmlns: 'urn:xmpp:openpgp:0' }, 'BODY'),
          ),
        ),
      ),
    )
    const handled = pubsub.handle(eventStanza)

    expect(handled).toBe(true)
    expect(received).toHaveLength(1)
    expect(received[0].id).toBe('current')
    expect(received[0].payload.name).toBe('pubkey')
    expect(received[0].payload.children).toEqual(['BODY'])
  })

  it('does not invoke the callback for a different node', () => {
    const deps = makeDeps(async () => xml('iq', {}))
    const pubsub = new PubSub(deps)
    const received: PEPItem[] = []
    pubsub.subscribe('bob@example.com', 'other-node', (item) => received.push(item))

    const stanza = xml('message', { from: 'bob@example.com/r' },
      xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
        xml('items', { node: 'unrelated-node' },
          xml('item', { id: '1' }, xml('x', {}, 'hi')),
        ),
      ),
    )
    pubsub.handle(stanza)
    expect(received).toEqual([])
  })

  it('does not invoke the callback for a different JID', () => {
    const deps = makeDeps(async () => xml('iq', {}))
    const pubsub = new PubSub(deps)
    const received: PEPItem[] = []
    pubsub.subscribe('alice@example.com', 'node', (item) => received.push(item))

    const stanza = xml('message', { from: 'mallory@example.com/r' },
      xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
        xml('items', { node: 'node' },
          xml('item', { id: '1' }, xml('x', {}, 'hi')),
        ),
      ),
    )
    pubsub.handle(stanza)
    expect(received).toEqual([])
  })

  it('unsubscribe() removes the callback', () => {
    const deps = makeDeps(async () => xml('iq', {}))
    const pubsub = new PubSub(deps)
    const received: PEPItem[] = []
    const sub = pubsub.subscribe('bob@example.com', 'node', (item) => received.push(item))

    const buildStanza = (id: string) => xml('message', { from: 'bob@example.com/r' },
      xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
        xml('items', { node: 'node' },
          xml('item', { id }, xml('x', {}, id)),
        ),
      ),
    )

    pubsub.handle(buildStanza('1'))
    sub.unsubscribe()
    pubsub.handle(buildStanza('2'))

    expect(received.map((i) => i.id)).toEqual(['1'])
  })

  it('isolates throwing callbacks from each other', () => {
    const deps = makeDeps(async () => xml('iq', {}))
    const pubsub = new PubSub(deps)
    const received: string[] = []

    pubsub.subscribe('bob@example.com', 'node', () => {
      throw new Error('boom')
    })
    pubsub.subscribe('bob@example.com', 'node', () => {
      received.push('ok')
    })

    const stanza = xml('message', { from: 'bob@example.com/r' },
      xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
        xml('items', { node: 'node' },
          xml('item', { id: '1' }, xml('x', {}, 'hi')),
        ),
      ),
    )
    expect(() => pubsub.handle(stanza)).not.toThrow()
    expect(received).toEqual(['ok'])
  })

  it('supports multiple independent subscribers for the same (jid, node)', () => {
    const deps = makeDeps(async () => xml('iq', {}))
    const pubsub = new PubSub(deps)
    const a = vi.fn()
    const b = vi.fn()
    pubsub.subscribe('bob@example.com', 'node', a)
    pubsub.subscribe('bob@example.com', 'node', b)

    const stanza = xml('message', { from: 'bob@example.com/r' },
      xml('event', { xmlns: 'http://jabber.org/protocol/pubsub#event' },
        xml('items', { node: 'node' },
          xml('item', { id: '1' }, xml('x', {}, 'hi')),
        ),
      ),
    )
    pubsub.handle(stanza)

    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
  })
})
