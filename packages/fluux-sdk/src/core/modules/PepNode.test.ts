/**
 * PepNode tests.
 *
 * Uses real @xmpp/client (no mocking) so stanza construction and parsing go
 * through the real `xml` builder, matching the surrounding module tests.
 */
import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { createPresenceReader } from '../presenceReader'
import { PepNode, buildPublishOptions, type PepCodec } from './PepNode'
import type { ModuleDependencies } from './BaseModule'

const NODE = 'urn:example:thing'

interface Thing { id: string; name: string }

const codec: PepCodec<Thing> = {
  encode: (thing) => xml('thing', { xmlns: NODE, name: thing.name }),
  decode: (item) => {
    const name = item.getChild('thing', NODE)?.attrs.name
    return name ? { id: item.attrs.id, name } : undefined
  },
}

function makeDeps(
  sendIQ: (iq: Element, timeoutMs?: number) => Promise<Element>,
  currentJid: string | null = 'me@example.com/res',
): ModuleDependencies {
  return {
    stores: null,
    presence: createPresenceReader(),
    sendStanza: async () => {},
    sendIQ,
    getCurrentJid: () => currentJid,
    emit: () => {},
    emitSDK: () => {},
    getXmpp: () => null,
  }
}

function itemsResult(iq: Element, ...items: Element[]): Element {
  return xml('iq', { type: 'result', id: iq.attrs.id },
    xml('pubsub', { xmlns: 'http://jabber.org/protocol/pubsub' },
      xml('items', { node: NODE }, ...items),
    ),
  )
}

function thingItem(id: string, name: string): Element {
  return xml('item', { id }, xml('thing', { xmlns: NODE, name }))
}

/** The shape `sendIQ` rejects with when the server answers a stanza error. */
function stanzaError(condition: string): Error & { condition: string } {
  return Object.assign(new Error(condition), { condition })
}

const itemNotFound = () => stanzaError('item-not-found')

describe('PepNode.get', () => {
  it('decodes items and reports ok', async () => {
    const deps = makeDeps(async (iq) => itemsResult(iq, thingItem('a', 'Ada'), thingItem('b', 'Bob')))
    const result = await new PepNode(deps, NODE, codec).get()
    expect(result).toEqual({ status: 'ok', items: [{ id: 'a', name: 'Ada' }, { id: 'b', name: 'Bob' }] })
  })

  it('skips items the codec cannot decode rather than failing the read', async () => {
    const deps = makeDeps(async (iq) => itemsResult(iq, thingItem('a', 'Ada'), xml('item', { id: 'junk' })))
    const result = await new PepNode(deps, NODE, codec).get()
    expect(result).toEqual({ status: 'ok', items: [{ id: 'a', name: 'Ada' }] })
  })

  it('reads our own bare JID by default, stripping the resource', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => { captured = iq; return itemsResult(iq) })
    await new PepNode(deps, NODE, codec).get()
    expect(captured!.attrs.to).toBe('me@example.com')
    expect(captured!.attrs.type).toBe('get')
  })

  it('scopes the request to one item when itemId is given', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => { captured = iq; return itemsResult(iq) })
    await new PepNode(deps, NODE, codec).get({ itemId: 'current' })
    const items = captured!.getChild('pubsub')!.getChild('items')!
    expect(items.attrs.node).toBe(NODE)
    expect(items.getChild('item')!.attrs.id).toBe('current')
  })

  it('passes maxItems and a remote JID through', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => { captured = iq; return itemsResult(iq) })
    await new PepNode(deps, NODE, codec).get({ jid: 'them@example.org', maxItems: 1 })
    expect(captured!.attrs.to).toBe('them@example.org')
    expect(captured!.getChild('pubsub')!.getChild('items')!.attrs.max_items).toBe('1')
  })

  it('forwards the timeout to sendIQ', async () => {
    let seen: number | undefined
    const deps = makeDeps(async (iq, timeoutMs) => { seen = timeoutMs; return itemsResult(iq) })
    await new PepNode(deps, NODE, codec).get({ timeoutMs: 1234 })
    expect(seen).toBe(1234)
  })

  // The three-way split is the point of this type: `absent` is the server
  // stating there is nothing published, which callers act on.
  it('classifies item-not-found as absent, not as an empty read', async () => {
    const deps = makeDeps(async () => { throw itemNotFound() })
    expect(await new PepNode(deps, NODE, codec).get()).toEqual({ status: 'absent' })
  })

  // A refusal is an ANSWER: the server said this node is not ours to read, and
  // that holds for every item on it. Callers remember it; they must not remember
  // a timeout.
  it('classifies forbidden as refused, carrying the condition', async () => {
    const deps = makeDeps(async () => { throw stanzaError('forbidden') })
    expect(await new PepNode(deps, NODE, codec).get())
      .toEqual({ status: 'refused', condition: 'forbidden' })
  })

  it('classifies service-unavailable as refused', async () => {
    const deps = makeDeps(async () => { throw stanzaError('service-unavailable') })
    expect(await new PepNode(deps, NODE, codec).get())
      .toEqual({ status: 'refused', condition: 'service-unavailable' })
  })

  it('classifies any other rejection as unavailable', async () => {
    const deps = makeDeps(async () => { throw new Error('timeout') })
    expect(await new PepNode(deps, NODE, codec).get()).toEqual({ status: 'unavailable' })
  })

  it('keeps item-not-found ahead of the refusal conditions', async () => {
    const deps = makeDeps(async () => { throw stanzaError('item-not-found') })
    expect(await new PepNode(deps, NODE, codec).get()).toEqual({ status: 'absent' })
  })

  it('treats a result without <items/> as unavailable rather than empty', async () => {
    const deps = makeDeps(async (iq) => xml('iq', { type: 'result', id: iq.attrs.id }))
    expect(await new PepNode(deps, NODE, codec).get()).toEqual({ status: 'unavailable' })
  })

  it('is unavailable with no session and sends nothing', async () => {
    let sent = false
    const deps = makeDeps(async (iq) => { sent = true; return itemsResult(iq) }, null)
    expect(await new PepNode(deps, NODE, codec).get()).toEqual({ status: 'unavailable' })
    expect(sent).toBe(false)
  })
})

describe('PepNode.getOr', () => {
  it('returns items when the read succeeds', async () => {
    const deps = makeDeps(async (iq) => itemsResult(iq, thingItem('a', 'Ada')))
    expect(await new PepNode(deps, NODE, codec).getOr([])).toEqual([{ id: 'a', name: 'Ada' }])
  })

  it('falls back for absent, refused and unavailable alike', async () => {
    const absent = makeDeps(async () => { throw itemNotFound() })
    const refused = makeDeps(async () => { throw stanzaError('forbidden') })
    const broken = makeDeps(async () => { throw new Error('nope') })
    expect(await new PepNode(absent, NODE, codec).getOr([])).toEqual([])
    expect(await new PepNode(refused, NODE, codec).getOr([])).toEqual([])
    expect(await new PepNode(broken, NODE, codec).getOr([])).toEqual([])
  })
})

describe('PepNode.publish', () => {
  it('sends the encoded payload under the item id', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => { captured = iq; return xml('iq', { type: 'result', id: iq.attrs.id }) })
    await new PepNode(deps, NODE, codec).publish('current', { id: 'current', name: 'Ada' })

    expect(captured!.attrs.type).toBe('set')
    const publish = captured!.getChild('pubsub')!.getChild('publish')!
    expect(publish.attrs.node).toBe(NODE)
    const item = publish.getChild('item')!
    expect(item.attrs.id).toBe('current')
    expect(item.getChild('thing')!.attrs.name).toBe('Ada')
  })

  it('carries the node publish-options', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => { captured = iq; return xml('iq', { type: 'result', id: iq.attrs.id }) })
    const node = new PepNode(deps, NODE, codec, { persistItems: true, accessModel: 'whitelist', maxItems: 'max' })
    await node.publish('current', { id: 'current', name: 'Ada' })

    const fields = captured!.getChild('pubsub')!.getChild('publish-options')!
      .getChild('x')!.getChildren('field')
    const byVar = new Map(fields.map((f: Element) => [f.attrs.var, f.getChild('value')?.text()]))
    expect(byVar.get('pubsub#persist_items')).toBe('true')
    expect(byVar.get('pubsub#access_model')).toBe('whitelist')
    expect(byVar.get('pubsub#max_items')).toBe('max')
  })

  it('omits publish-options when the node declares none', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => { captured = iq; return xml('iq', { type: 'result', id: iq.attrs.id }) })
    await new PepNode(deps, NODE, codec).publish('current', { id: 'current', name: 'Ada' })
    expect(captured!.getChild('pubsub')!.getChild('publish-options')).toBeUndefined()
  })

  it('refuses to publish without a session', async () => {
    const deps = makeDeps(async (iq) => xml('iq', { type: 'result', id: iq.attrs.id }), null)
    await expect(new PepNode(deps, NODE, codec).publish('current', { id: 'c', name: 'A' }))
      .rejects.toThrow('Not connected')
  })
})

describe('PepNode.retract', () => {
  it('sends a retract for the item', async () => {
    let captured: Element | null = null
    const deps = makeDeps(async (iq) => { captured = iq; return xml('iq', { type: 'result', id: iq.attrs.id }) })
    await new PepNode(deps, NODE, codec).retract('gone')
    const retract = captured!.getChild('pubsub')!.getChild('retract')!
    expect(retract.attrs.node).toBe(NODE)
    expect(retract.getChild('item')!.attrs.id).toBe('gone')
  })

  it('propagates a server refusal so the caller can decide', async () => {
    const deps = makeDeps(async () => { throw itemNotFound() })
    await expect(new PepNode(deps, NODE, codec).retract('gone')).rejects.toThrow()
  })
})

describe('buildPublishOptions', () => {
  it('is null when there is nothing to say', () => {
    expect(buildPublishOptions(undefined)).toBeNull()
    expect(buildPublishOptions({})).toBeNull()
  })

  it('renders booleans as true/false', () => {
    const fields = buildPublishOptions({ persistItems: false })!.getChild('x')!.getChildren('field')
    const byVar = new Map(fields.map((f: Element) => [f.attrs.var, f.getChild('value')?.text()]))
    expect(byVar.get('pubsub#persist_items')).toBe('false')
  })
})
