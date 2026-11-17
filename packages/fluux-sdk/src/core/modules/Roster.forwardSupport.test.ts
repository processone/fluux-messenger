import { describe, expect, it, vi } from 'vitest'
import { xml, type Element } from '@xmpp/client'
import { Roster } from './Roster'
import type { ModuleDependencies } from './BaseModule'
import { createMockPresenceReader, createMockStores } from '../test-utils'
import { NS_CAPS, NS_DISCO_INFO, NS_FORWARD_COPY } from '../namespaces'

// Plan: standalone forwarding is chosen only when every known online device of the contact advertises it.
const bob = 'bob@example.org'
function setup(online: string[], features: Record<string, string[]>) {
  const stores = createMockStores()
  stores.roster.getContact = vi.fn(() => ({ jid: bob, resources: new Map(online.map(resource => [resource, {}])) })) as never
  const sendIQ = vi.fn(async (iq: Element) =>
    xml('iq', { type: 'result' }, xml('query', { xmlns: NS_DISCO_INFO },
      ...(features[iq.attrs.to as string] ?? []).map(name => xml('feature', { var: name })))))
  const deps = { stores, presence: createMockPresenceReader(), getCurrentJid: () => 'alice@example.org/web', getXmpp: () => null,
    sendStanza: vi.fn(), sendIQ, emit: vi.fn(), emitSDK: vi.fn() } as unknown as ModuleDependencies
  const roster = new Roster(deps)
  const present = (resource: string, ver?: string, type?: string) => roster.handle(xml('presence', { from: `${bob}/${resource}`, ...(type ? { type } : {}) },
    ...(ver ? [xml('c', { xmlns: NS_CAPS, hash: 'sha-1', node: 'https://example.org/client', ver })] : [])))
  return { roster, present, sendIQ }
}

describe('Roster.supportsForwardedCopy', () => {
  it('accepts when every online device announced capabilities that include the feature', async () => {
    const { roster, present } = setup(['phone', 'web'], { [`${bob}/phone`]: [NS_FORWARD_COPY], [`${bob}/web`]: [NS_FORWARD_COPY] })
    present('phone', 'v1'); present('web', 'v2')
    expect(await roster.supportsForwardedCopy(bob)).toBe(true)
  })

  it('refuses mixed, unannounced and offline contacts', async () => {
    const mixed = setup(['phone', 'web'], { [`${bob}/phone`]: [NS_FORWARD_COPY] })
    mixed.present('phone', 'v1'); mixed.present('web', 'v2')
    expect(await mixed.roster.supportsForwardedCopy(bob)).toBe(false)
    const unknown = setup(['phone'], { [`${bob}/phone`]: [NS_FORWARD_COPY] })
    unknown.present('phone')
    expect(await unknown.roster.supportsForwardedCopy(bob)).toBe(false)
    const offline = setup([], {})
    expect(await offline.roster.supportsForwardedCopy(bob)).toBe(false)
    expect(offline.sendIQ).not.toHaveBeenCalled()
  })

  it('forgets a device that signs off', async () => {
    const { roster, present } = setup(['phone'], { [`${bob}/phone`]: [NS_FORWARD_COPY] })
    present('phone', 'v1')
    present('phone', undefined, 'unavailable')
    expect(await roster.supportsForwardedCopy(bob)).toBe(false)
  })
})
