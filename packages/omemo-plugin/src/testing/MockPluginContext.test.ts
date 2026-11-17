import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import type { PEPItem, SecurityContextUpdate } from '@fluux/sdk'
import { createMockPluginContext, newMockNetwork, seedPeer } from './MockPluginContext'
import { elementToData } from '../stanzaData'

describe('MockPluginContext', () => {
  it('publishes to and queries a shared in-memory PEP', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    await a.ctx.xmpp.publishPEP('urn:xmpp:omemo:2:devices', {
      id: 'current',
      payload: elementToData(xml('devices', {}, xml('device', { id: '5' }))),
    })
    const items = await b.ctx.xmpp.queryPEP('a@x', 'urn:xmpp:omemo:2:devices')
    expect(items[0].payload.name).toBe('devices')
  })

  it('isolates unrelated jid/node pairs from a shared network', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    await a.ctx.xmpp.publishPEP('urn:xmpp:omemo:2:devices', {
      id: 'current',
      payload: elementToData(xml('devices', {})),
    })
    const unrelatedJid = await b.ctx.xmpp.queryPEP('c@x', 'urn:xmpp:omemo:2:devices')
    const unrelatedNode = await b.ctx.xmpp.queryPEP('a@x', 'urn:xmpp:omemo:2:bundles:5')
    expect(unrelatedJid).toEqual([])
    expect(unrelatedNode).toEqual([])
  })

  it('fires a subscriber when the subscribed peer later publishes', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    const received: PEPItem[] = []
    b.ctx.xmpp.subscribePEP('a@x', 'urn:xmpp:omemo:2:bundles:5', (item) => received.push(item))

    const item = { id: 'current', payload: elementToData(xml('bundle', { id: '5' })) }
    await a.ctx.xmpp.publishPEP('urn:xmpp:omemo:2:bundles:5', item)

    expect(received).toEqual([item])
  })

  it('does not fire a subscriber for a different node or a different publisher', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    const c = createMockPluginContext('c@x', a.net)
    const received: PEPItem[] = []
    b.ctx.xmpp.subscribePEP('a@x', 'urn:xmpp:omemo:2:bundles:5', (item) => received.push(item))

    await a.ctx.xmpp.publishPEP('urn:xmpp:omemo:2:bundles:6', {
      id: 'current',
      payload: elementToData(xml('bundle', { id: '6' })),
    })
    await c.ctx.xmpp.publishPEP('urn:xmpp:omemo:2:bundles:5', {
      id: 'current',
      payload: elementToData(xml('bundle', { id: '5' })),
    })

    expect(received).toEqual([])
  })

  it('stops delivering to a subscriber after unsubscribe', async () => {
    const a = createMockPluginContext('a@x')
    const b = createMockPluginContext('b@x', a.net)
    const received: PEPItem[] = []
    const sub = b.ctx.xmpp.subscribePEP('a@x', 'urn:xmpp:omemo:2:devices', (item) => received.push(item))
    sub.unsubscribe()

    await a.ctx.xmpp.publishPEP('urn:xmpp:omemo:2:devices', {
      id: 'current',
      payload: elementToData(xml('devices', {})),
    })

    expect(received).toEqual([])
  })

  it('records security context updates reported by the plugin', () => {
    const a = createMockPluginContext('a@x')
    const update: SecurityContextUpdate = {
      peer: 'b@x',
      messageId: 'msg-1',
      securityContext: { protocolId: 'omemo:2', trust: 'tofu' },
    }

    a.ctx.reportSecurityContextUpdate(update)

    expect(a.updates).toEqual([update])
  })

  it('seedPeer injects a foreign jid item that queryPEP then returns', async () => {
    const net = newMockNetwork()
    const payload = elementToData(xml('bundle', { id: '7' }))
    seedPeer(net, 'foreign@example.com', 'urn:xmpp:omemo:2:bundles:7', payload)

    const b = createMockPluginContext('b@x', net)
    const items = await b.ctx.xmpp.queryPEP('foreign@example.com', 'urn:xmpp:omemo:2:bundles:7')

    expect(items).toEqual([{ id: 'current', payload }])
  })
})
