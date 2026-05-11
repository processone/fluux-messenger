/**
 * Unit tests for the shared inbound-decrypt step, focused on the stash
 * mechanism that lets downstream message parsers pick up the sender-
 * attested `authoredAt` timestamp a plugin recovers from the envelope.
 * End-to-end encrypt→decrypt round-trips are covered by Chat.e2ee /
 * MAM.e2ee / SequoiaPgpPlugin integration tests.
 */
import { describe, it, expect } from 'vitest'
import { xml } from '@xmpp/client'
import type { Element } from '@xmpp/client'
import {
  decryptStanzaInPlace,
  readStashedAuthoredAt,
  readStashedSecurityContext,
  readStashedEncryptedPayload,
  stanzaHasEMEHint,
} from './stanzaDecrypt'
import { E2EEManager, InMemoryStorageBackend, type XMPPPrimitives } from './index'
import { serialize as serializePayloadEnvelope } from './payloadEnvelope'
import type {
  ConversationHandle,
  ConversationTarget,
  DecryptResult,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  IdentityInfo,
  PeerSupport,
  PluginContext,
  SecurityContext,
  TrustState,
  VerificationFlow,
  VerificationMethod,
  XMLElementData,
} from './types'

const TEST_PROTOCOL_ID = 'test-e2ee'
const TEST_NAMESPACE = 'urn:test:e2ee:0'

const descriptor: E2EEProtocolDescriptor = {
  id: TEST_PROTOCOL_ID,
  displayName: 'Test E2EE',
  securityLevel: 10,
  features: {
    forwardSecrecy: false,
    postCompromiseSecurity: false,
    multiDevice: false,
    groupChat: false,
    asynchronous: true,
    deniability: false,
  },
}

/**
 * Minimal plugin that claims `<enc xmlns='urn:test:e2ee:0'>` elements
 * and returns a DecryptResult with a caller-controllable `authoredAt`.
 * Lets stanzaDecrypt tests exercise the stash without a real crypto
 * protocol underneath.
 */
class FakeE2EEPlugin implements E2EEPlugin {
  readonly descriptor = descriptor
  private ctx: PluginContext | null = null

  constructor(private readonly authoredAt: Date | undefined) {}

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
  }
  async shutdown(): Promise<void> {
    this.ctx = null
  }
  async ensureIdentity(): Promise<IdentityInfo> {
    return { fingerprint: 'FP-test' }
  }
  async probePeer(_peer: string): Promise<PeerSupport> {
    return { supported: true, ttl: 300 }
  }
  async openConversation(target: ConversationTarget): Promise<ConversationHandle> {
    return { protocolId: TEST_PROTOCOL_ID, state: { target } }
  }
  async closeConversation(_h: ConversationHandle): Promise<void> {}
  async encrypt(
    _h: ConversationHandle,
    _plaintext: Uint8Array,
  ): Promise<EncryptedPayload> {
    return {
      protocolId: TEST_PROTOCOL_ID,
      stanzaElement: { name: 'enc', attrs: { xmlns: TEST_NAMESPACE }, children: [] },
    }
  }
  async decrypt(
    _h: ConversationHandle,
    _payload: EncryptedPayload,
  ): Promise<DecryptResult> {
    const securityContext: SecurityContext = {
      protocolId: TEST_PROTOCOL_ID,
      trust: 'tofu',
    }
    // Emit a shape-valid payload envelope so stanzaDecrypt's unwrap path
    // runs without falling back to the legacy body-string flow.
    const plaintextXml = serializePayloadEnvelope([xml('body', {}, 'decrypted body')])
    return {
      plaintext: new TextEncoder().encode(plaintextXml),
      senderDevice: { jid: 'peer@example.com', deviceId: 'dev' },
      securityContext,
      ...(this.authoredAt && { authoredAt: this.authoredAt }),
    }
  }
  tryClaimInbound(child: XMLElementData): EncryptedPayload | null {
    if (child.name !== 'enc' || child.attrs?.xmlns !== TEST_NAMESPACE) return null
    return { protocolId: TEST_PROTOCOL_ID, stanzaElement: child }
  }
  getVerificationMethods(): VerificationMethod[] {
    return []
  }
  async startVerification(_p: string, _m: VerificationMethod): Promise<VerificationFlow> {
    throw new Error('not supported')
  }
  async getPeerTrust(_p: string): Promise<TrustState> {
    return 'tofu'
  }
  async getDeviceTrust(_p: string, _d: string): Promise<TrustState> {
    return 'tofu'
  }
}

function stubXmppPrimitives(): XMPPPrimitives {
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

async function makeManager(plugin: FakeE2EEPlugin): Promise<E2EEManager> {
  const manager = new E2EEManager({
    storage: new InMemoryStorageBackend(),
    xmpp: stubXmppPrimitives(),
    account: { jid: 'me@example.com' },
  })
  await manager.register(plugin)
  return manager
}

function buildStanza(): Element {
  return xml(
    'message',
    { from: 'peer@example.com/resource', id: 'm1', type: 'chat' },
    xml('body', {}, '[Encrypted message]'),
    xml('enc', { xmlns: TEST_NAMESPACE }),
  ) as Element
}

describe('stanzaDecrypt authoredAt stash', () => {
  it('stashes authoredAt when the plugin returns it', async () => {
    const authored = new Date('2026-03-15T12:34:56Z')
    const manager = await makeManager(new FakeE2EEPlugin(authored))
    const stanza = buildStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(true)
    expect(result.authoredAt?.toISOString()).toBe(authored.toISOString())
    expect(readStashedAuthoredAt(stanza)?.toISOString()).toBe(authored.toISOString())
    expect(readStashedSecurityContext(stanza)?.protocolId).toBe(TEST_PROTOCOL_ID)
  })

  it('leaves authoredAt undefined when the plugin did not supply one', async () => {
    const manager = await makeManager(new FakeE2EEPlugin(undefined))
    const stanza = buildStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(true)
    expect(result.authoredAt).toBeUndefined()
    expect(readStashedAuthoredAt(stanza)).toBeUndefined()
  })

  it('returns the stashed authoredAt on a second decrypt of the same stanza (idempotence)', async () => {
    const authored = new Date('2026-03-15T12:34:56Z')
    const manager = await makeManager(new FakeE2EEPlugin(authored))
    const stanza = buildStanza()

    const first = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')
    const second = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(first.authoredAt?.toISOString()).toBe(authored.toISOString())
    expect(second.authoredAt?.toISOString()).toBe(authored.toISOString())
  })
})

// ---------------------------------------------------------------------------
// Failing plugin: claims the encrypted child but throws on decrypt
// ---------------------------------------------------------------------------

class FailingE2EEPlugin extends FakeE2EEPlugin {
  constructor() {
    super(undefined)
  }

  override async decrypt(): Promise<DecryptResult> {
    throw new Error('key locked')
  }
}

// ---------------------------------------------------------------------------
// Helper: create a manager with no plugins registered
// ---------------------------------------------------------------------------

function makeEmptyManager(): E2EEManager {
  return new E2EEManager({
    storage: new InMemoryStorageBackend(),
    xmpp: stubXmppPrimitives(),
    account: { jid: 'me@example.com' },
  })
}

// ---------------------------------------------------------------------------
// Deferred decryption: encrypted payload stash on failure
// ---------------------------------------------------------------------------

describe('stanzaDecrypt encrypted payload stash on failure', () => {
  it('stashes serialized encrypted XML when plugin decrypt fails', async () => {
    const manager = await makeManager(new FailingE2EEPlugin())
    const stanza = buildStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(true)
    expect(result.encryptedPayloadXml).toBeDefined()
    expect(result.encryptedPayloadXml).toContain(TEST_NAMESPACE)
    expect(readStashedEncryptedPayload(stanza)).toBe(result.encryptedPayloadXml)
  })

  it('does not stash payload on successful decrypt', async () => {
    const manager = await makeManager(new FakeE2EEPlugin(undefined))
    const stanza = buildStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(true)
    expect(result.encryptedPayloadXml).toBeUndefined()
    expect(readStashedEncryptedPayload(stanza)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Deferred decryption: EME-based stash without plugin
// ---------------------------------------------------------------------------

describe('stanzaDecrypt EME-based stash without plugin', () => {
  it('stashes encrypted child via EME when no plugin claims', async () => {
    const manager = makeEmptyManager()
    const stanza = xml(
      'message',
      { from: 'peer@example.com/resource', id: 'm2', type: 'chat' },
      xml('body', {}, 'This message is encrypted'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:xmpp:openpgp:0' }),
      xml('openpgp', { xmlns: 'urn:xmpp:openpgp:0' }, 'ciphertext'),
    ) as Element

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(false)
    expect(result.encryptedPayloadXml).toBeDefined()
    expect(result.encryptedPayloadXml).toContain('urn:xmpp:openpgp:0')
    expect(readStashedEncryptedPayload(stanza)).toBe(result.encryptedPayloadXml)
  })

  it('does not stash when there is no EME hint and no plugin claims', async () => {
    const manager = makeEmptyManager()
    const stanza = xml(
      'message',
      { from: 'peer@example.com/resource', id: 'm3', type: 'chat' },
      xml('body', {}, 'Hello, plain text'),
    ) as Element

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(false)
    expect(result.encryptedPayloadXml).toBeUndefined()
    expect(readStashedEncryptedPayload(stanza)).toBeUndefined()
  })

  it('does not stash when EME namespace attr is missing', async () => {
    const manager = makeEmptyManager()
    const stanza = xml(
      'message',
      { from: 'peer@example.com/resource', id: 'm4', type: 'chat' },
      xml('body', {}, 'Encrypted without namespace hint'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0' }),
    ) as Element

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(false)
    expect(result.encryptedPayloadXml).toBeUndefined()
    expect(readStashedEncryptedPayload(stanza)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// stanzaHasEMEHint
// ---------------------------------------------------------------------------

describe('stanzaHasEMEHint', () => {
  it('returns true when EME element is present', () => {
    const stanza = xml(
      'message',
      { from: 'peer@example.com/resource', id: 'm5', type: 'chat' },
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:xmpp:openpgp:0' }),
    ) as Element

    expect(stanzaHasEMEHint(stanza)).toBe(true)
  })

  it('returns false when no EME element', () => {
    const stanza = xml(
      'message',
      { from: 'peer@example.com/resource', id: 'm6', type: 'chat' },
      xml('body', {}, 'plain text message'),
    ) as Element

    expect(stanzaHasEMEHint(stanza)).toBe(false)
  })
})
