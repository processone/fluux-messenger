/**
 * Discovery.queryInfo round-trip tests. Uses real @xmpp/client (no mocking)
 * to exercise the same stanza path plugins will hit.
 */
import { describe, it, expect } from 'vitest'
import { createPresenceReader } from '../presenceReader'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import { Discovery } from './Discovery'
import type { ModuleDependencies } from './BaseModule'

function makeDeps(sendIQ: (iq: Element) => Promise<Element>): ModuleDependencies {
  return {
    stores: null,
    presence: createPresenceReader(),
    sendStanza: async () => {},
    sendIQ,
    getCurrentJid: () => 'me@example.com',
    emit: () => {},
    emitSDK: () => {},
    getXmpp: () => null,
  }
}

describe('Discovery.queryInfo', () => {
  it('sends disco#info to the right JID and parses features + identities', async () => {
    let captured: Element | null = null
    const response = xml(
      'iq',
      { type: 'result', from: 'bob@example.com' },
      xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' },
        xml('identity', { category: 'account', type: 'registered' }),
        xml('identity', { category: 'client', type: 'pc', name: 'Fluux' }),
        xml('feature', { var: 'http://jabber.org/protocol/pubsub#publish' }),
        xml('feature', { var: 'urn:xmpp:openpgp:0:public-keys+notify' }),
      ),
    )
    const deps = makeDeps(async (iq) => {
      captured = iq
      return response
    })
    const discovery = new Discovery(deps)

    const result = await discovery.queryInfo('bob@example.com')

    expect(captured!.attrs.type).toBe('get')
    expect(captured!.attrs.to).toBe('bob@example.com')
    const query = captured!.getChild('query', 'http://jabber.org/protocol/disco#info')
    expect(query).toBeDefined()

    expect(result.identities).toHaveLength(2)
    expect(result.identities[0]).toEqual({ category: 'account', type: 'registered' })
    expect(result.identities[1]).toEqual({ category: 'client', type: 'pc', name: 'Fluux' })

    expect(result.features.map((f) => f.var)).toEqual([
      'http://jabber.org/protocol/pubsub#publish',
      'urn:xmpp:openpgp:0:public-keys+notify',
    ])
  })

  it('returns empty arrays when the peer has no disco#info query child', async () => {
    const deps = makeDeps(async () => xml('iq', { type: 'result' }))
    const discovery = new Discovery(deps)
    const result = await discovery.queryInfo('peer@example.com')
    expect(result).toEqual({ features: [], identities: [] })
  })

  it('skips features with no var attribute', async () => {
    const response = xml(
      'iq',
      { type: 'result' },
      xml('query', { xmlns: 'http://jabber.org/protocol/disco#info' },
        xml('feature', {}),
        xml('feature', { var: 'urn:valid:feature' }),
      ),
    )
    const deps = makeDeps(async () => response)
    const discovery = new Discovery(deps)
    const result = await discovery.queryInfo('peer@example.com')
    expect(result.features).toEqual([{ var: 'urn:valid:feature' }])
  })
})
