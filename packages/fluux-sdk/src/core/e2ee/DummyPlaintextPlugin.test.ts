import { describe, it, expect, beforeEach } from 'vitest'
import { DummyPlaintextPlugin } from './DummyPlaintextPlugin'
import { InMemoryStorageBackend, createPluginStorage } from './PluginStorage'
import type { PluginContext, XMPPPrimitives } from './types'

function makeCtx(): PluginContext {
  const xmpp: XMPPPrimitives = {
    sendStanza: async () => {},
    queryDisco: async () => ({ features: [], identities: [] }),
    publishPEP: async () => {},
    retractPEP: async () => {},
    deletePEP: async () => {},
    queryPEP: async () => [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
  return {
    storage: createPluginStorage(new InMemoryStorageBackend(), 'dummy'),
    xmpp,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    account: { jid: 'me@example.com' },
    reportSecurityContextUpdate: () => {},
  }
}

describe('DummyPlaintextPlugin', () => {
  let plugin: DummyPlaintextPlugin

  beforeEach(async () => {
    plugin = new DummyPlaintextPlugin()
    await plugin.init(makeCtx())
  })

  it('round-trips plaintext through encrypt/decrypt', async () => {
    const target = { kind: 'direct', peer: 'bob@example.com' } as const
    const handle = await plugin.openConversation(target)

    const plaintext = new TextEncoder().encode('Hello, world!')
    const payload = await plugin.encrypt(handle, plaintext)

    expect(payload.protocolId).toBe('dummy-plaintext')
    expect(payload.stanzaElement.name).toBe('plain')
    expect(payload.stanzaElement.attrs.xmlns).toBe('urn:fluux:e2ee-dummy:0')

    const decrypted = await plugin.decrypt(handle, payload)
    expect(new TextDecoder().decode(decrypted.plaintext)).toBe('Hello, world!')
    expect(decrypted.securityContext.trust).toBe('untrusted')
  })

  it('claims its own inbound element shape', () => {
    const claim = plugin.tryClaimInbound({
      name: 'plain',
      attrs: { xmlns: 'urn:fluux:e2ee-dummy:0' },
      children: ['aGV5'],
    })
    expect(claim).not.toBeNull()
    expect(claim?.protocolId).toBe('dummy-plaintext')
  })

  it('refuses to claim elements from other protocols', () => {
    expect(
      plugin.tryClaimInbound({
        name: 'encrypted',
        attrs: { xmlns: 'urn:xmpp:omemo:2' },
        children: [],
      }),
    ).toBeNull()

    expect(
      plugin.tryClaimInbound({
        name: 'plain',
        attrs: { xmlns: 'urn:unknown' },
        children: [],
      }),
    ).toBeNull()
  })

  it('refuses to decrypt payloads from other protocols', async () => {
    const target = { kind: 'direct', peer: 'bob@example.com' } as const
    const handle = await plugin.openConversation(target)
    await expect(
      plugin.decrypt(handle, {
        protocolId: 'omemo:2',
        stanzaElement: { name: 'plain', attrs: { xmlns: 'urn:fluux:e2ee-dummy:0' }, children: ['aGV5'] },
      }),
    ).rejects.toThrow(/cannot decrypt/)
  })

  it('probes all peers as supported (permissive for testing)', async () => {
    const support = await plugin.probePeer('anyone@example.com')
    expect(support.supported).toBe(true)
    expect(support.ttl).toBeGreaterThan(0)
  })
})
