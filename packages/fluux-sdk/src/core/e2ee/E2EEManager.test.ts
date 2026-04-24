import { describe, it, expect, vi } from 'vitest'
import { E2EEManager } from './E2EEManager'
import { DummyPlaintextPlugin } from './DummyPlaintextPlugin'
import { InMemoryStorageBackend } from './PluginStorage'
import type {
  BareJID,
  ConversationHandle,
  ConversationTarget,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  PeerSupport,
  PluginContext,
  VerificationFlow,
  XMLElementData,
  XMPPPrimitives,
} from './types'

function makeXmpp(): XMPPPrimitives {
  return {
    sendStanza: async () => {},
    queryDisco: async () => ({ features: [], identities: [] }),
    publishPEP: async () => {},
    retractPEP: async () => {},
    queryPEP: async () => [],
    subscribePEP: () => ({ unsubscribe: () => {} }),
  }
}

function makeManager(): E2EEManager {
  return new E2EEManager({
    storage: new InMemoryStorageBackend(),
    xmpp: makeXmpp(),
    account: { jid: 'me@example.com' },
  })
}

/** Minimal configurable plugin for selection / dispatch tests. */
class FakePlugin implements E2EEPlugin {
  readonly descriptor: E2EEProtocolDescriptor
  private readonly xmlns: string
  public probed: BareJID[] = []
  public closedHandles = 0
  public support: (peer: BareJID) => PeerSupport
  public encryptImpl: ((plaintext: Uint8Array) => EncryptedPayload) | null = null
  public decryptThrows = false

  constructor(
    descriptor: E2EEProtocolDescriptor,
    xmlns: string,
    opts: { support?: (peer: BareJID) => PeerSupport } = {},
  ) {
    this.descriptor = descriptor
    this.xmlns = xmlns
    this.support = opts.support ?? (() => ({ supported: true, ttl: 60 }))
  }

  async init(_ctx: PluginContext): Promise<void> {}
  async shutdown(): Promise<void> {}
  async ensureIdentity() {
    return { fingerprint: `fake-${this.descriptor.id}` }
  }

  async probePeer(peer: BareJID): Promise<PeerSupport> {
    this.probed.push(peer)
    return this.support(peer)
  }

  async openConversation(target: ConversationTarget): Promise<ConversationHandle> {
    return { protocolId: this.descriptor.id, state: { target } }
  }

  async closeConversation(_handle: ConversationHandle): Promise<void> {
    this.closedHandles++
  }

  async encrypt(_h: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload> {
    if (this.encryptImpl) return this.encryptImpl(plaintext)
    return {
      protocolId: this.descriptor.id,
      stanzaElement: { name: 'fake', attrs: { xmlns: this.xmlns }, children: [] },
    }
  }

  async decrypt(_h: ConversationHandle, payload: EncryptedPayload) {
    if (this.decryptThrows) throw new Error('boom')
    return {
      plaintext: new Uint8Array([0x42]),
      senderDevice: { jid: 'sender@example.com', deviceId: 'd1' },
      securityContext: { protocolId: payload.protocolId, trust: 'trusted' as const },
    }
  }

  getVerificationMethods() {
    return []
  }
  async startVerification(): Promise<VerificationFlow> {
    throw new Error('unused')
  }
  async getPeerTrust() {
    return 'unknown' as const
  }
  async getDeviceTrust() {
    return 'unknown' as const
  }

  tryClaimInbound(stanzaChild: XMLElementData): EncryptedPayload | null {
    if (stanzaChild.attrs?.xmlns !== this.xmlns) return null
    return { protocolId: this.descriptor.id, stanzaElement: stanzaChild }
  }
}

const strongDescriptor: E2EEProtocolDescriptor = {
  id: 'omemo:2',
  displayName: 'OMEMO 2',
  securityLevel: 80,
  features: {
    forwardSecrecy: true,
    postCompromiseSecurity: true,
    multiDevice: true,
    groupChat: true,
    asynchronous: true,
    deniability: true,
  },
}

const weakDescriptor: E2EEProtocolDescriptor = {
  id: 'openpgp',
  displayName: 'OpenPGP',
  securityLevel: 30,
  features: {
    forwardSecrecy: false,
    postCompromiseSecurity: false,
    multiDevice: true,
    groupChat: false,
    asynchronous: true,
    deniability: false,
  },
}

describe('E2EEManager — registration', () => {
  it('registers and lists plugins sorted by securityLevel desc', async () => {
    const mgr = makeManager()
    await mgr.register(new FakePlugin(weakDescriptor, 'urn:test:weak'))
    await mgr.register(new FakePlugin(strongDescriptor, 'urn:test:strong'))

    const descriptors = mgr.listPlugins()
    expect(descriptors.map((d) => d.id)).toEqual(['omemo:2', 'openpgp'])
  })

  it('calls plugin.init with a namespaced storage', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(weakDescriptor, 'urn:test:weak')
    const initSpy = vi.spyOn(plugin, 'init')
    await mgr.register(plugin)

    expect(initSpy).toHaveBeenCalledTimes(1)
    const ctx = initSpy.mock.calls[0][0]
    expect(ctx.account.jid).toBe('me@example.com')
    expect(typeof ctx.storage.get).toBe('function')
  })

  it('rejects duplicate plugin ids', async () => {
    const mgr = makeManager()
    await mgr.register(new FakePlugin(weakDescriptor, 'urn:test:weak'))
    await expect(
      mgr.register(new FakePlugin(weakDescriptor, 'urn:test:weak-2')),
    ).rejects.toThrow(/already registered/)
  })

  it('getAccountJid returns the bound JID so the host can detect identity changes', async () => {
    // After refactoring to construct-on-login, the host uses this to decide
    // whether to reuse an existing manager on reconnect (same JID) or rebuild
    // for a different identity (different JID).
    const mgr = new E2EEManager({
      storage: new InMemoryStorageBackend(),
      xmpp: makeXmpp(),
      account: { jid: 'alice@example.com' },
    })

    expect(mgr.getAccountJid()).toBe('alice@example.com')

    const plugin = new FakePlugin(weakDescriptor, 'urn:test:weak')
    const initSpy = vi.spyOn(plugin, 'init')
    await mgr.register(plugin)

    const ctx = initSpy.mock.calls[0][0]
    expect(ctx.account.jid).toBe('alice@example.com')
  })

  it('unregister calls shutdown and removes the plugin', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(weakDescriptor, 'urn:test:weak')
    const shutdown = vi.spyOn(plugin, 'shutdown')
    await mgr.register(plugin)
    await mgr.unregister(weakDescriptor.id)
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(mgr.getPlugin(weakDescriptor.id)).toBeNull()
  })
})

describe('E2EEManager — strategy selection', () => {
  it('picks highest securityLevel among mutually-supported plugins', async () => {
    const mgr = makeManager()
    const strong = new FakePlugin(strongDescriptor, 'urn:test:strong')
    const weak = new FakePlugin(weakDescriptor, 'urn:test:weak')
    await mgr.register(strong)
    await mgr.register(weak)

    const selected = await mgr.selectStrategy({ kind: 'direct', peer: 'bob@example.com' })
    expect(selected?.descriptor.id).toBe('omemo:2')
  })

  it('falls back to a lower-ranked plugin when the strong one is unsupported by the peer', async () => {
    const mgr = makeManager()
    const strong = new FakePlugin(strongDescriptor, 'urn:test:strong', {
      support: () => ({ supported: false, ttl: 60 }),
    })
    const weak = new FakePlugin(weakDescriptor, 'urn:test:weak')
    await mgr.register(strong)
    await mgr.register(weak)

    const selected = await mgr.selectStrategy({ kind: 'direct', peer: 'bob@example.com' })
    expect(selected?.descriptor.id).toBe('openpgp')
  })

  it('returns null when no plugin supports the peer (no plaintext fallback)', async () => {
    const mgr = makeManager()
    const weak = new FakePlugin(weakDescriptor, 'urn:test:weak', {
      support: () => ({ supported: false, ttl: 60 }),
    })
    await mgr.register(weak)

    const selected = await mgr.selectStrategy({ kind: 'direct', peer: 'bob@example.com' })
    expect(selected).toBeNull()
  })

  it('honors per-conversation pin even if stronger plugins are available', async () => {
    const mgr = makeManager()
    const strong = new FakePlugin(strongDescriptor, 'urn:test:strong')
    const weak = new FakePlugin(weakDescriptor, 'urn:test:weak')
    await mgr.register(strong)
    await mgr.register(weak)

    const target = { kind: 'direct' as const, peer: 'bob@example.com' }
    mgr.setPinnedStrategy(target, 'openpgp')

    const selected = await mgr.selectStrategy(target)
    expect(selected?.descriptor.id).toBe('openpgp')
  })

  it('excludes non-groupChat plugins from MUC selection', async () => {
    const mgr = makeManager()
    await mgr.register(new FakePlugin(weakDescriptor, 'urn:test:weak')) // groupChat=false
    await mgr.register(new FakePlugin(strongDescriptor, 'urn:test:strong')) // groupChat=true

    const selected = await mgr.selectStrategy({
      kind: 'muc',
      room: 'room@muc.example.com',
      participants: ['alice@example.com', 'bob@example.com'],
    })
    expect(selected?.descriptor.id).toBe('omemo:2')
  })

  it('caches probe results across repeated selections', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    await mgr.register(plugin)

    await mgr.selectStrategy({ kind: 'direct', peer: 'bob@example.com' })
    await mgr.selectStrategy({ kind: 'direct', peer: 'bob@example.com' })

    expect(plugin.probed).toEqual(['bob@example.com']) // only once
  })

  it('re-probes after invalidateCapability', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    await mgr.register(plugin)

    await mgr.selectStrategy({ kind: 'direct', peer: 'bob@example.com' })
    mgr.invalidateCapability('bob@example.com')
    await mgr.selectStrategy({ kind: 'direct', peer: 'bob@example.com' })

    expect(plugin.probed.length).toBe(2)
  })

  it('notifyPeerKeysChanged invalidates cache AND calls plugin hook', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    const onChanged = vi.fn()
    ;(plugin as E2EEPlugin).onPeerKeysChanged = onChanged
    await mgr.register(plugin)

    await mgr.selectStrategy({ kind: 'direct', peer: 'bob@example.com' })
    mgr.notifyPeerKeysChanged('bob@example.com', strongDescriptor.id)
    await mgr.selectStrategy({ kind: 'direct', peer: 'bob@example.com' })

    expect(plugin.probed.length).toBe(2) // cache was dropped
    expect(onChanged).toHaveBeenCalledWith('bob@example.com')
  })

  it('notifyPeerKeysChanged with no protocolId notifies every plugin', async () => {
    const mgr = makeManager()
    const a = new FakePlugin(strongDescriptor, 'urn:test:strong')
    const b = new FakePlugin(weakDescriptor, 'urn:test:weak')
    const aHook = vi.fn()
    const bHook = vi.fn()
    ;(a as E2EEPlugin).onPeerKeysChanged = aHook
    ;(b as E2EEPlugin).onPeerKeysChanged = bHook
    await mgr.register(a)
    await mgr.register(b)

    mgr.notifyPeerKeysChanged('bob@example.com')

    expect(aHook).toHaveBeenCalledWith('bob@example.com')
    expect(bHook).toHaveBeenCalledWith('bob@example.com')
  })
})

describe('E2EEManager — security context updates', () => {
  it('routes plugin reports to every registered listener', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    let captured: PluginContext | null = null
    plugin.init = async (ctx: PluginContext) => {
      captured = ctx
    }
    await mgr.register(plugin)

    const a = vi.fn()
    const b = vi.fn()
    mgr.onSecurityContextUpdated(a)
    mgr.onSecurityContextUpdated(b)

    captured!.reportSecurityContextUpdate({
      peer: 'bob@example.com',
      messageId: 'm-42',
      securityContext: { protocolId: strongDescriptor.id, trust: 'trusted' },
    })

    expect(a).toHaveBeenCalledWith({
      peer: 'bob@example.com',
      messageId: 'm-42',
      securityContext: { protocolId: strongDescriptor.id, trust: 'trusted' },
    })
    expect(b).toHaveBeenCalledWith(expect.objectContaining({ messageId: 'm-42' }))
  })

  it('unsubscribe stops further deliveries', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    let captured: PluginContext | null = null
    plugin.init = async (ctx: PluginContext) => {
      captured = ctx
    }
    await mgr.register(plugin)

    const listener = vi.fn()
    const unsubscribe = mgr.onSecurityContextUpdated(listener)
    unsubscribe()

    captured!.reportSecurityContextUpdate({
      peer: 'bob@example.com',
      messageId: 'm-1',
      securityContext: { protocolId: strongDescriptor.id, trust: 'trusted' },
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('a throwing listener does not stop dispatch to the next listener', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    let captured: PluginContext | null = null
    plugin.init = async (ctx: PluginContext) => {
      captured = ctx
    }
    await mgr.register(plugin)

    const survivor = vi.fn()
    mgr.onSecurityContextUpdated(() => {
      throw new Error('first listener exploded')
    })
    mgr.onSecurityContextUpdated(survivor)

    captured!.reportSecurityContextUpdate({
      peer: 'bob@example.com',
      messageId: 'm-1',
      securityContext: { protocolId: strongDescriptor.id, trust: 'trusted' },
    })
    expect(survivor).toHaveBeenCalled()
  })

  it('decryptInbound forwards InboundDecryptContext to the chosen plugin', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    const decryptSpy = vi.spyOn(plugin, 'decrypt')
    await mgr.register(plugin)

    await mgr.decryptInbound(
      { name: 'fake', attrs: { xmlns: 'urn:test:strong' }, children: [] },
      { kind: 'direct', peer: 'bob@example.com' },
      { messageId: 'm-99' },
    )

    expect(decryptSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { messageId: 'm-99' },
    )
  })

  it('shutdown clears subscribed listeners', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    let captured: PluginContext | null = null
    plugin.init = async (ctx: PluginContext) => {
      captured = ctx
    }
    await mgr.register(plugin)

    const listener = vi.fn()
    mgr.onSecurityContextUpdated(listener)
    // Snapshot the context before shutdown nukes the plugin.
    const ctxSnapshot = captured!
    await mgr.shutdown()

    // Calling reportSecurityContextUpdate after shutdown is a no-op
    // because listeners were cleared. (The closure still works — we're
    // asserting the listener side of the dispatch was emptied.)
    ctxSnapshot.reportSecurityContextUpdate({
      peer: 'bob@example.com',
      messageId: 'm-1',
      securityContext: { protocolId: strongDescriptor.id, trust: 'trusted' },
    })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('E2EEManager — send policy', () => {
  it('defaults to opportunistic', () => {
    const mgr = makeManager()
    expect(mgr.getSendPolicy()).toBe('opportunistic')
  })

  it('setSendPolicy round-trips', () => {
    const mgr = makeManager()
    mgr.setSendPolicy('strict')
    expect(mgr.getSendPolicy()).toBe('strict')
    mgr.setSendPolicy('opportunistic')
    expect(mgr.getSendPolicy()).toBe('opportunistic')
  })
})

describe('E2EEManager — dispatch', () => {
  it('encryptOutbound picks a plugin, opens a handle, and encrypts', async () => {
    const mgr = makeManager()
    await mgr.register(new DummyPlaintextPlugin())

    const plaintext = new TextEncoder().encode('hello')
    const result = await mgr.encryptOutbound({ kind: 'direct', peer: 'bob@example.com' }, plaintext)

    expect(result).not.toBeNull()
    expect(result!.payload.protocolId).toBe('dummy-plaintext')
  })

  it('encryptOutbound returns null if no plugin supports the target', async () => {
    const mgr = makeManager()
    await mgr.register(
      new FakePlugin(strongDescriptor, 'urn:test:strong', {
        support: () => ({ supported: false, ttl: 60 }),
      }),
    )
    const result = await mgr.encryptOutbound(
      { kind: 'direct', peer: 'bob@example.com' },
      new Uint8Array(),
    )
    expect(result).toBeNull()
  })

  it('encryptOutbound closes the handle if encrypt throws', async () => {
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    plugin.encryptImpl = () => {
      throw new Error('encrypt blew up')
    }
    await mgr.register(plugin)

    await expect(
      mgr.encryptOutbound({ kind: 'direct', peer: 'bob@example.com' }, new Uint8Array()),
    ).rejects.toThrow(/encrypt blew up/)
    expect(plugin.closedHandles).toBe(1)
  })

  it('decryptInbound routes stanza child to the plugin that claims it', async () => {
    const mgr = makeManager()
    const strong = new FakePlugin(strongDescriptor, 'urn:test:strong')
    const weak = new FakePlugin(weakDescriptor, 'urn:test:weak')
    await mgr.register(strong)
    await mgr.register(weak)

    const stanzaChild: XMLElementData = {
      name: 'fake',
      attrs: { xmlns: 'urn:test:weak' },
      children: [],
    }
    const result = await mgr.decryptInbound(stanzaChild, { kind: 'direct', peer: 'bob@example.com' })
    expect(result).not.toBeNull()
    expect(result!.securityContext.protocolId).toBe('openpgp')
    expect(weak.closedHandles).toBe(1)
  })

  it('decryptInbound returns null when no plugin claims the element', async () => {
    const mgr = makeManager()
    await mgr.register(new FakePlugin(weakDescriptor, 'urn:test:weak'))
    const result = await mgr.decryptInbound(
      { name: 'encrypted', attrs: { xmlns: 'urn:unknown' }, children: [] },
      { kind: 'direct', peer: 'bob@example.com' },
    )
    expect(result).toBeNull()
  })

  it('full outbound → inbound round-trip through the dummy plugin', async () => {
    const mgr = makeManager()
    await mgr.register(new DummyPlaintextPlugin())

    const plaintext = new TextEncoder().encode('round trip')
    const out = await mgr.encryptOutbound({ kind: 'direct', peer: 'bob@example.com' }, plaintext)
    expect(out).not.toBeNull()

    const decrypted = await mgr.decryptInbound(out!.payload.stanzaElement, {
      kind: 'direct',
      peer: 'me@example.com',
    })
    expect(decrypted).not.toBeNull()
    expect(new TextDecoder().decode(decrypted!.plaintext)).toBe('round trip')
  })

  it('decryptArchive prefers plugin.decryptArchive when the plugin implements it', async () => {
    // Stateful-ratchet plugins (OMEMO, MLS) implement decryptArchive so MAM
    // replay does not consume forward-only key material. Verify the host
    // actually routes the archive path — not the live one — when the plugin
    // advertises both.
    const mgr = makeManager()
    const plugin = new FakePlugin(strongDescriptor, 'urn:test:strong')
    const archiveSpy = vi.fn(async () => ({
      plaintext: new Uint8Array([0xAA]),
      senderDevice: { jid: 'sender@example.com', deviceId: 'archive-d' },
      securityContext: { protocolId: strongDescriptor.id, trust: 'trusted' as const },
    }))
    ;(plugin as unknown as { decryptArchive: typeof archiveSpy }).decryptArchive = archiveSpy
    const liveSpy = vi.spyOn(plugin, 'decrypt')
    await mgr.register(plugin)

    const result = await mgr.decryptArchive(
      { name: 'fake', attrs: { xmlns: 'urn:test:strong' }, children: [] },
      { kind: 'direct', peer: 'bob@example.com' },
      { messageId: 'arch-1' },
    )

    expect(result).not.toBeNull()
    expect(archiveSpy).toHaveBeenCalledTimes(1)
    expect(liveSpy).not.toHaveBeenCalled()
    expect(plugin.closedHandles).toBe(1)
  })

  it('decryptArchive falls back to plugin.decrypt when decryptArchive is not implemented', async () => {
    // OpenPGP (and any stateless plugin) can skip decryptArchive — the host
    // transparently reuses the live decrypt. Prevents a regression where a
    // plugin without ratchet state needs a no-op override just to participate
    // in archive flows.
    const mgr = makeManager()
    const plugin = new FakePlugin(weakDescriptor, 'urn:test:weak')
    const liveSpy = vi.spyOn(plugin, 'decrypt')
    await mgr.register(plugin)

    const result = await mgr.decryptArchive(
      { name: 'fake', attrs: { xmlns: 'urn:test:weak' }, children: [] },
      { kind: 'direct', peer: 'bob@example.com' },
    )

    expect(result).not.toBeNull()
    expect(liveSpy).toHaveBeenCalledTimes(1)
    expect(plugin.closedHandles).toBe(1)
  })

  it('decryptArchive returns null when no plugin claims the element', async () => {
    const mgr = makeManager()
    await mgr.register(new FakePlugin(weakDescriptor, 'urn:test:weak'))
    const result = await mgr.decryptArchive(
      { name: 'other', attrs: { xmlns: 'urn:unknown' }, children: [] },
      { kind: 'direct', peer: 'bob@example.com' },
    )
    expect(result).toBeNull()
  })
})

describe('E2EEManager — shutdown', () => {
  it('shuts down all plugins and clears state', async () => {
    const mgr = makeManager()
    const strong = new FakePlugin(strongDescriptor, 'urn:test:strong')
    const weak = new FakePlugin(weakDescriptor, 'urn:test:weak')
    const shutdownStrong = vi.spyOn(strong, 'shutdown')
    const shutdownWeak = vi.spyOn(weak, 'shutdown')

    await mgr.register(strong)
    await mgr.register(weak)
    await mgr.shutdown()

    expect(shutdownStrong).toHaveBeenCalledTimes(1)
    expect(shutdownWeak).toHaveBeenCalledTimes(1)
    expect(mgr.listPlugins()).toEqual([])
  })
})
