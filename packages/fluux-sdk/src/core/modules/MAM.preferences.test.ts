import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { MAM } from './MAM'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader, createMockStores } from '../test-utils'

const NS = 'urn:xmpp:mam:2'

function prefsResult(defaultPolicy: string | undefined, always: string[] = [], never: string[] = []): Element {
  return xml('iq', { type: 'result' },
    xml('prefs', { xmlns: NS, ...(defaultPolicy ? { default: defaultPolicy } : {}) },
      xml('always', {}, ...always.map(jid => xml('jid', {}, jid))),
      xml('never', {}, ...never.map(jid => xml('jid', {}, jid)))))
}

/** An account whose server answers prefs get/set like ejabberd's mod_mam. */
function harness(initial: Element | Error) {
  const sent: Element[] = []
  const sendIQ = vi.fn(async (iq: Element) => {
    sent.push(iq)
    if (iq.attrs.type === 'get') {
      if (initial instanceof Error) throw initial
      return initial
    }
    // XEP-0313 §6.1: the server answers a set with the preferences it applied.
    return xml('iq', { type: 'result' }, iq.getChild('prefs', NS)!)
  })
  const deps: ModuleDependencies = {
    stores: createMockStores(), presence: createMockPresenceReader(), getCurrentJid: () => 'me@example.com/web',
    getXmpp: () => null, sendStanza: vi.fn(), sendIQ, emit: vi.fn(), emitSDK: vi.fn(),
  }
  return { mam: new MAM(deps), sendIQ, sent }
}

const jids = (prefs: Element, list: 'always' | 'never') =>
  prefs.getChild(list)!.getChildren('jid').map(j => j.text())

describe('MAM archiving preferences', () => {
  it('reads the default policy and both JID lists', async () => {
    const h = harness(prefsResult('roster', ['romeo@montague.lit'], ['tybalt@capulet.lit', 'paris@verona.lit']))

    const prefs = await h.mam.getArchivingPreferences()

    expect(prefs).toEqual({ default: 'roster', always: ['romeo@montague.lit'], never: ['tybalt@capulet.lit', 'paris@verona.lit'] })
    const get = h.sent[0]
    expect(get.attrs.type).toBe('get')
    expect(get.attrs.to).toBeUndefined()
    expect(get.getChild('prefs', NS)).toBeDefined()
  })

  it('sets the given preferences and returns what the server applied', async () => {
    const h = harness(prefsResult('never'))

    const applied = await h.mam.setArchivingPreferences({ default: 'always', always: ['a@x.lit'], never: ['b@x.lit'] })

    expect(applied).toEqual({ default: 'always', always: ['a@x.lit'], never: ['b@x.lit'] })
    const set = h.sent[0]
    expect(set.attrs.type).toBe('set')
    const prefs = set.getChild('prefs', NS)!
    expect(prefs.attrs.default).toBe('always')
    expect(jids(prefs, 'always')).toEqual(['a@x.lit'])
    expect(jids(prefs, 'never')).toEqual(['b@x.lit'])
  })
})
