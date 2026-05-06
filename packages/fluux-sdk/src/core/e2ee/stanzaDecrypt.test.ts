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
