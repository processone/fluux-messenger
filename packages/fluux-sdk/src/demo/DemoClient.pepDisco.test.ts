/**
 * Demo-mode account disco: the encryption settings panel probes the
 * account bare JID for PEP (XEP-0163) via `Discovery.checkPepSupport`.
 * The demo simulates a full-featured server, so the DemoClient must
 * answer that probe positively — otherwise the demo shows a bogus
 * "your server does not support PEP" warning.
 */
import { describe, it, expect } from 'vitest'
import { DemoClient } from './DemoClient'
import { discoSupportsPep } from '../core/modules/Discovery'

interface ElementLike {
  attrs: Record<string, string>
  getChild: (name: string, xmlns?: string) => ElementLike | undefined
  getChildren: (name: string) => ElementLike[]
}

describe('DemoClient disco#info on the account bare JID', () => {
  it('advertises PEP so the encryption settings probe passes', async () => {
    const client = new DemoClient()
    ;(client as unknown as { currentJid: string | null }).currentJid = 'you@fluux.chat'
    ;(client as unknown as { selfJid: string }).selfJid = 'you@fluux.chat'

    const iq = {
      name: 'iq',
      attrs: { type: 'get', to: 'you@fluux.chat', id: 'disco_demo' },
      children: [
        { name: 'query', attrs: { xmlns: 'http://jabber.org/protocol/disco#info' }, children: [] },
      ],
    }
    const result = await (
      client as unknown as { sendIQ: (s: unknown) => Promise<ElementLike> }
    ).sendIQ(iq)

    const query = result.getChild('query', 'http://jabber.org/protocol/disco#info')
    expect(query).toBeDefined()
    const identities = query!
      .getChildren('identity')
      .map((i) => ({ category: i.attrs.category, type: i.attrs.type }))
    const features = query!.getChildren('feature').map((f) => ({ var: f.attrs.var }))
    expect(discoSupportsPep({ features, identities })).toBe(true)
  })
})
