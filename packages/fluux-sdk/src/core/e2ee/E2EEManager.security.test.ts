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
  constructor(id = 'listing', level = 50) {
    super()
    this.descriptor = { ...new DummyPlaintextPlugin().descriptor, id, displayName: id === 'listing' ? 'Listing' : id, securityLevel: level }
  }
  override readonly descriptor: DummyPlaintextPlugin['descriptor']
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
      used: 2, verified: 1, waiting: 1, partlyVerified: true,
    })
  })

  it('a replaced verified key (listed unused) makes the new key read partly verified', async () => {
    const { manager, plugin } = await setup()
    plugin.identities = [
      identity('2'),
      identity('1', { trust: 'verified', usedForEncryption: false, notUsedReason: 'no-key' }),
    ]
    expect(await manager.getConversationSecurity(target)).toMatchObject({ trust: 'tofu', used: 1, verified: 0, partlyVerified: true })
  })

  it('a recent key replacing a verified one reads partly verified, not new', async () => {
    const { manager, plugin } = await setup()
    plugin.identities = [
      identity('2', { isNew: true }),
      identity('1', { trust: 'verified', usedForEncryption: false, notUsedReason: 'no-key' }),
    ]
    const sec = await manager.getConversationSecurity(target)
    expect(sec).toMatchObject({ partlyVerified: true })
    expect(sec).not.toHaveProperty('isNew')
  })

  it('flags a recent unverified key as new, and never a verified contact', async () => {
    const { manager, plugin } = await setup()
    plugin.identities = [identity('1', { isNew: true })]
    expect(await manager.getConversationSecurity(target)).toMatchObject({ trust: 'tofu', isNew: true })
    expect(await manager.getConversationSecurity(target)).not.toHaveProperty('partlyVerified')
    plugin.identities = [identity('1', { trust: 'verified', isNew: true })]
    expect(await manager.getConversationSecurity(target)).not.toHaveProperty('isNew')
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

describe('E2EEManager.getConversationSecurity with failing or empty listings', () => {
  it('an empty listing from a supporting plugin is unusable, not encrypted', async () => {
    const { manager } = await setup()
    expect(await manager.getConversationSecurity(target)).toMatchObject({ kind: 'unusable', problems: [] })
  })

  it('a failed listing is unusable and says so, instead of reusing aggregate trust', async () => {
    const { manager, plugin } = await setup()
    plugin.listPeerIdentities = async () => {
      throw new Error('boom')
    }
    vi.spyOn(plugin, 'getPeerTrust').mockResolvedValue('verified')
    expect(await manager.getConversationSecurity(target)).toMatchObject({
      kind: 'unusable',
      problems: [{ code: 'listing-failed' }],
    })
  })
})

describe('E2EEManager with two registered methods', () => {
  async function two() {
    const manager = new E2EEManager({ storage: new InMemoryStorageBackend(), xmpp: xmpp(), account: { jid: 'me@example.com' } })
    const high = new ListingPlugin('high', 80)
    const low = new ListingPlugin('low', 30)
    high.identities = [identity('h1', { trust: 'verified' })]
    low.identities = [identity('l1')]
    await manager.register(low)
    await manager.register(high)
    return { manager, high, low }
  }

  it('groups identities by method, highest rank first, and marks the ranked one in use', async () => {
    const { manager } = await two()
    const groups = await manager.listPeerIdentities(PEER)
    expect(groups.map((g) => [g.protocolId, g.inUse])).toEqual([['high', true], ['low', false]])
    expect(await manager.getConversationSecurity(target)).toMatchObject({ kind: 'encrypted', protocolId: 'high', trust: 'verified' })
  })

  it('a pin moves the in-use mark and the conversation state, and signals the change', async () => {
    const { manager } = await two()
    const seen: (string | null)[] = []
    manager.onConversationSecurityChanged((p) => seen.push(p))
    manager.setPinnedStrategy(target, 'low')
    manager.setPinnedStrategy(target, 'low') // no change, no signal
    expect(seen).toEqual([PEER])
    expect((await manager.listPeerIdentities(PEER)).map((g) => [g.protocolId, g.inUse])).toEqual([['high', false], ['low', true]])
    expect(await manager.getConversationSecurity(target)).toMatchObject({ protocolId: 'low', trust: 'tofu' })
  })

  it('forced plaintext wins over both methods and signals once per change', async () => {
    const { manager } = await two()
    const seen: (string | null)[] = []
    manager.onConversationSecurityChanged((p) => seen.push(p))
    manager.setForcedPlaintext(target, true)
    manager.setForcedPlaintext(target, true)
    expect(await manager.getConversationSecurity(target)).toEqual({ kind: 'plaintextForced' })
    manager.setForcedPlaintext(target, false)
    expect(seen).toEqual([PEER, PEER])
  })

  it('when the ranked method has nothing usable the pinned fallback is not chosen silently', async () => {
    const { manager, high } = await two()
    high.identities = [identity('h1', { usedForEncryption: false, notUsedReason: 'awaiting-decision', trust: 'unknown' })]
    expect(await manager.getConversationSecurity(target)).toMatchObject({ kind: 'needsDecision', protocolId: 'high' })
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
