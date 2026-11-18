import { describe, it, expect, vi } from 'vitest'
import { E2EEManager } from './E2EEManager'
import { InMemoryStorageBackend } from './PluginStorage'
import { DummyPlaintextPlugin } from './DummyPlaintextPlugin'
import type { E2EEPlugin, PeerIdentity, PluginContext, TrustState, XMPPPrimitives } from './types'

// Intent: FLM-268 piece 1 — the manager answers conversation security and
// identity lists from registered plugins alone, with no protocol knowledge.

const PEER = 'bob@example.com'

function xmpp(): XMPPPrimitives {
  return {
    sendStanza: async () => {},
    queryDisco: async () => ({ features: [], identities: [] }),
    publishPEP: async () => {},
    retractPEP: async () => {},
    deletePEP: async () => {},
    queryPEP: async () => [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
}

function identity(id: string, over: Partial<PeerIdentity> = {}): PeerIdentity {
  return { id, fingerprint: `FP${id}`, trust: 'tofu', usedForEncryption: true, allowedDecisions: ['verified'], ...over }
}

/** A plugin that lists the identities it is given and supports the peer when `supported`. */
class ListingPlugin extends DummyPlaintextPlugin {
  override readonly descriptor = { ...new DummyPlaintextPlugin().descriptor, id: 'listing', displayName: 'Listing', securityLevel: 50 }
  identities: PeerIdentity[] = []
  supported = true
  locked = false
  hostCtx: PluginContext | null = null
  decisions: [string, string][] = []
  override async init(ctx: PluginContext) {
    this.hostCtx = ctx
    await super.init(ctx)
  }
  override async probePeer() {
    return { supported: this.supported, ttl: 60 }
  }
  async listPeerIdentities() {
    return this.identities
  }
  async setIdentityTrust(_peer: string, id: string, decision: string) {
    this.decisions.push([id, decision])
  }
  async getOwnFingerprint() {
    return 'OWN'
  }
  isLocked() {
    return this.locked
  }
}

async function setup(plugin: E2EEPlugin = new ListingPlugin()) {
  const manager = new E2EEManager({ storage: new InMemoryStorageBackend(), xmpp: xmpp(), account: { jid: 'me@example.com' } })
  await manager.register(plugin)
  return { manager, plugin: plugin as ListingPlugin }
}

const target = { kind: 'direct' as const, peer: PEER }

describe('E2EEManager.getConversationSecurity', () => {
  it('reports plaintextForced when the user turned encryption off', async () => {
    const { manager } = await setup()
    manager.setForcedPlaintext(target, true)
    expect(await manager.getConversationSecurity(target)).toEqual({ kind: 'plaintextForced' })
  })

  it('reports unsupported when no protocol knows the peer', async () => {
    const { manager, plugin } = await setup()
    plugin.supported = false
    expect(await manager.getConversationSecurity(target)).toEqual({ kind: 'unsupported' })
  })

  it('reports encrypted with counts, aggregate trust and the single used fingerprint', async () => {
    const { manager, plugin } = await setup()
    plugin.identities = [identity('1', { trust: 'verified' })]
    expect(await manager.getConversationSecurity(target)).toEqual({
      kind: 'encrypted', protocolId: 'listing', displayName: 'Listing', trust: 'verified',
      fingerprint: 'FP1', used: 1, verified: 1, waiting: 0,
    })
  })

  it('partly verified keys read tofu, give no fingerprint, and count a waiting key without using it', async () => {
    const { manager, plugin } = await setup()
    plugin.identities = [
      identity('1', { trust: 'verified' }),
      identity('2'),
      identity('3', { trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision' }),
    ]
    const sec = await manager.getConversationSecurity(target)
    expect(sec).toEqual({
      kind: 'encrypted', protocolId: 'listing', displayName: 'Listing', trust: 'tofu',
      used: 2, verified: 1, waiting: 1,
    })
  })

  it('a verified contact whose keys all wait needs a decision, not encryption', async () => {
    const { manager, plugin } = await setup()
    plugin.identities = [
      identity('1', { trust: 'unknown', usedForEncryption: false, notUsedReason: 'awaiting-decision' }),
    ]
    expect(await manager.getConversationSecurity(target)).toMatchObject({ kind: 'needsDecision', waiting: 1 })
  })

  it('keys that exist but none can be used are unusable and carry each problem', async () => {
    const { manager, plugin } = await setup()
    plugin.identities = [
      identity('1', { usedForEncryption: false, notUsedReason: 'invalid-key', problem: { code: 'validation_failed', detail: 'bad' } }),
      identity('2', { trust: 'untrusted', usedForEncryption: false, notUsedReason: 'distrusted' }),
    ]
    expect(await manager.getConversationSecurity(target)).toMatchObject({
      kind: 'unusable',
      problems: [{ id: '1', code: 'validation_failed', detail: 'bad' }, { id: '2', code: 'distrusted' }],
    })
  })

  it('a plugin that cannot probe the peer still reports unusable when it lists rejected keys', async () => {
    const { manager, plugin } = await setup()
    plugin.supported = false
    plugin.identities = [identity('1', { usedForEncryption: false, notUsedReason: 'invalid-key' })]
    expect(await manager.getConversationSecurity(target)).toMatchObject({ kind: 'unusable', protocolId: 'listing' })
  })

  it('a locked own key reports locked', async () => {
    const { manager, plugin } = await setup()
    plugin.locked = true
    expect(await manager.getConversationSecurity(target)).toMatchObject({ kind: 'locked' })
  })

  it('falls back to the aggregate trust for a plugin that lists no identities', async () => {
    const dummy = new DummyPlaintextPlugin()
    vi.spyOn(dummy, 'getPeerTrust').mockResolvedValue('verified' as TrustState)
    const { manager } = await setup(dummy)
    expect(await manager.getConversationSecurity(target)).toMatchObject({ kind: 'encrypted', trust: 'verified', verified: 1 })
  })
})

describe('E2EEManager identities, decisions and events', () => {
  it('lists identities grouped by protocol and marks the one in use', async () => {
    const { manager, plugin } = await setup()
    plugin.identities = [identity('1')]
    const groups = await manager.listPeerIdentities(PEER)
    expect(groups).toEqual([{ protocolId: 'listing', displayName: 'Listing', inUse: true, identities: [identity('1')] }])
  })

  it('leaves out plugins that list nothing', async () => {
    const { manager } = await setup()
    expect(await manager.listPeerIdentities(PEER)).toEqual([])
  })

  it('setIdentityTrust reaches the named plugin, signals the change and rejects an unknown protocol', async () => {
    const { manager, plugin } = await setup()
    const seen: (string | null)[] = []
    manager.onConversationSecurityChanged((p) => seen.push(p))
    await manager.setIdentityTrust('listing', PEER, '1', 'tofu')
    expect(plugin.decisions).toEqual([['1', 'tofu']])
    expect(seen).toEqual([PEER])
    await expect(manager.setIdentityTrust('nope', PEER, '1', 'tofu')).rejects.toThrow()
  })

  it('answers the own fingerprint per protocol', async () => {
    const { manager } = await setup()
    expect(await manager.getOwnFingerprint('listing')).toBe('OWN')
    expect(await manager.getOwnFingerprint('nope')).toBeNull()
  })

  it('forwards plugin reports and stops after unsubscribe', async () => {
    const { manager, plugin } = await setup()
    const seen: (string | null)[] = []
    const off = manager.onConversationSecurityChanged((p) => seen.push(p))
    plugin.hostCtx!.reportPeerIdentitiesChanged!(PEER)
    plugin.hostCtx!.reportLocalKeyStateChanged!()
    plugin.hostCtx!.notifyKeyUnlocked!()
    expect(seen).toEqual([PEER, null, null])
    off()
    plugin.hostCtx!.reportPeerIdentitiesChanged!(PEER)
    expect(seen).toHaveLength(3)
  })
})
