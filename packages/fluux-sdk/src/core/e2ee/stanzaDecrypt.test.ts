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
  deriveConversationContext,
  readStashedAuthoredAt,
  readStashedSecurityContext,
  readStashedEncryptedPayload,
  stanzaHasEMEHint,
  recordUnclaimedEME,
  readStashedUnsupportedEncryption,
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

async function makeManager(plugin: E2EEPlugin): Promise<E2EEManager> {
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

class NonClaimingOpenPgpPlugin extends FakeE2EEPlugin {
  readonly descriptor: E2EEProtocolDescriptor = {
    ...descriptor,
    id: 'openpgp',
    displayName: 'OpenPGP',
  }

  constructor() {
    super(undefined)
  }

  override tryClaimInbound(_child: XMLElementData): EncryptedPayload | null {
    return null
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

  it('does not stash payload on successful decrypt with trusted context', async () => {
    const manager = await makeManager(new FakeE2EEPlugin(undefined))
    const stanza = buildStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(true)
    expect(result.encryptedPayloadXml).toBeUndefined()
    expect(readStashedEncryptedPayload(stanza)).toBeUndefined()
  })

  it('stashes payload when decrypt succeeds but trust is untrusted', async () => {
    const manager = await makeManager(new UntrustedE2EEPlugin())
    const stanza = buildStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(true)
    // Body should be decrypted
    const body = stanza.getChild('body')
    expect(body?.children[0]).toBe('decrypted body')
    // But encrypted payload should be preserved for later re-verification
    expect(result.encryptedPayloadXml).toBeDefined()
    expect(result.encryptedPayloadXml).toContain(TEST_NAMESPACE)
    expect(readStashedEncryptedPayload(stanza)).toBe(result.encryptedPayloadXml)
    // Security context should reflect untrusted
    expect(result.securityContext?.trust).toBe('untrusted')
  })
})

// ---------------------------------------------------------------------------
// Untrusted plugin: decrypt succeeds but reports untrusted trust (e.g. peer
// key not cached, so signature could not be verified)
// ---------------------------------------------------------------------------

class UntrustedE2EEPlugin extends FakeE2EEPlugin {
  constructor() {
    super(undefined)
  }

  override async decrypt(
    _h: ConversationHandle,
    _payload: EncryptedPayload,
  ): Promise<DecryptResult> {
    const securityContext: SecurityContext = {
      protocolId: TEST_PROTOCOL_ID,
      trust: 'untrusted',
      notes: ['Sender key not cached — signature not checked'],
    }
    const plaintextXml = serializePayloadEnvelope([xml('body', {}, 'decrypted body')])
    return {
      plaintext: new TextEncoder().encode(plaintextXml),
      senderDevice: { jid: 'peer@example.com', deviceId: 'dev' },
      securityContext,
    }
  }
}

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

describe('deriveConversationContext', () => {
  const ME = 'alice@example.com'

  it('regular received message: peer is the sender, not self-outgoing', () => {
    const stanza = xml(
      'message',
      { from: 'bob@example.com/laptop', to: `${ME}/desktop`, type: 'chat', id: 'm1' },
      xml('body', {}, 'hi'),
    ) as Element

    expect(deriveConversationContext(stanza, ME)).toEqual({
      peer: 'bob@example.com',
      isSelfOutgoing: false,
    })
  })

  it('XEP-0280 sent carbon shape: peer is the recipient (to), self-outgoing', () => {
    // After carbon unwrapping the inner message has from=us, to=peer.
    // This is what the live Chat path sees when our other device's
    // outgoing send is fanned out to us via `<sent xmlns=carbons:2>`.
    const innerSentCarbon = xml(
      'message',
      { from: `${ME}/device-A`, to: 'bob@example.com', type: 'chat', id: 'm-sent' },
      xml('body', {}, 'hello from device-A'),
    ) as Element

    expect(deriveConversationContext(innerSentCarbon, ME)).toEqual({
      peer: 'bob@example.com',
      isSelfOutgoing: true,
    })
  })

  it('XEP-0280 received carbon shape: peer is still the original sender, not self-outgoing', () => {
    // A received carbon wraps an INBOUND message, so the inner shape
    // looks identical to a regular received: from=peer, to=us.
    const innerReceivedCarbon = xml(
      'message',
      { from: 'bob@example.com/laptop', to: `${ME}/desktop`, type: 'chat', id: 'm-recv' },
      xml('body', {}, 'hi from bob'),
    ) as Element

    expect(deriveConversationContext(innerReceivedCarbon, ME)).toEqual({
      peer: 'bob@example.com',
      isSelfOutgoing: false,
    })
  })

  it('MUC groupchat: peer is the room JID, not self-outgoing', () => {
    // Room messages come from `roomJid/nickname`. The bare from is the
    // room JID, never our own JID, so the helper correctly attributes
    // them to the room without flipping the self-outgoing flag — even
    // for messages we sent ourselves to the room.
    const roomMessage = xml(
      'message',
      {
        from: 'room@conference.example.com/alice',
        to: `${ME}/desktop`,
        type: 'groupchat',
        id: 'm-room',
      },
      xml('body', {}, 'hey everyone'),
    ) as Element

    expect(deriveConversationContext(roomMessage, ME)).toEqual({
      peer: 'room@conference.example.com',
      isSelfOutgoing: false,
    })
  })

  it('full JIDs are reduced to bare JIDs in both peer and self-detection', () => {
    // The plugin operates on bare JIDs for conversation handles; the
    // helper must do the resource-stripping itself so callers do not
    // have to remember to. Tested by feeding full JIDs and asserting
    // the bare ones come back.
    const stanza = xml(
      'message',
      { from: `${ME}/longest-resource-name`, to: 'bob@example.com/phone', type: 'chat' },
      xml('body', {}, 'reduce'),
    ) as Element

    expect(deriveConversationContext(stanza, ME)).toEqual({
      peer: 'bob@example.com',
      isSelfOutgoing: true,
    })
  })

  it('empty own JID disables self-outgoing detection (defensive)', () => {
    // Callers (Chat, MAM) read the current JID lazily and may end up
    // with an empty string during teardown or before connect. Without
    // the guard, a message from `@example.com` could match by
    // coincidence and be mis-flagged as self-outgoing.
    const stanza = xml(
      'message',
      { from: `${ME}/device-A`, to: 'bob@example.com', type: 'chat' },
      xml('body', {}, 'careful'),
    ) as Element

    expect(deriveConversationContext(stanza, '')).toEqual({
      peer: 'alice@example.com',
      isSelfOutgoing: false,
    })
  })

  it('missing from attribute: peer falls back to empty, never claims self-outgoing', () => {
    const stanza = xml('message', { to: 'bob@example.com', type: 'chat' }) as Element

    expect(deriveConversationContext(stanza, ME)).toEqual({
      peer: '',
      isSelfOutgoing: false,
    })
  })

  it('missing to attribute on a self-outgoing stanza: peer is empty rather than guessing', () => {
    // A self-outgoing inner message must have a `to` (the recipient).
    // If it somehow arrives without one (malformed carbon, server
    // bug), the helper returns peer = '' rather than echoing our own
    // JID — the downstream decrypt step will then fail loudly instead
    // of opening a self-conversation handle.
    const stanza = xml('message', { from: `${ME}/device-A`, type: 'chat' }) as Element

    expect(deriveConversationContext(stanza, ME)).toEqual({
      peer: '',
      isSelfOutgoing: true,
    })
  })

  it('case-sensitive JID comparison (no normalisation, mirrors getBareJid)', () => {
    // getBareJid does not lowercase — neither does this helper, so a
    // server that ships a different case in `from` would be treated as
    // a different account. Documented here so the behavior is explicit
    // and any future stringprep work is a deliberate change.
    const stanza = xml(
      'message',
      { from: 'Alice@example.com/device-A', to: 'bob@example.com', type: 'chat' },
      xml('body', {}, 'cased'),
    ) as Element

    expect(deriveConversationContext(stanza, ME)).toEqual({
      peer: 'Alice@example.com',
      isSelfOutgoing: false,
    })
  })
})

// ---------------------------------------------------------------------------
// Unsupported vs not-ready classification (recordUnclaimedEME)
// ---------------------------------------------------------------------------

describe('recordUnclaimedEME', () => {
  function omemoStanza(): Element {
    return xml(
      'message',
      { from: 'peer@example.com/r', id: 'o1', type: 'chat' },
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' }),
      xml('body', {}, 'I sent you an OMEMO encrypted message.'),
    ) as Element
  }

  function openPgpStanza(): Element {
    return xml(
      'message',
      { from: 'peer@example.com/r', id: 'pgp1', type: 'chat' },
      xml('openpgp', { xmlns: 'urn:xmpp:openpgp:0' }, 'cipher'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:xmpp:openpgp:0', name: 'OpenPGP' }),
      xml('body', {}, '[OpenPGP-encrypted message]'),
    ) as Element
  }

  it('classifies an EME-tagged stanza as unsupported when plugins are ready', () => {
    const stanza = omemoStanza()
    const disposition = recordUnclaimedEME(stanza, true)

    expect(disposition.kind).toBe('unsupported')
    if (disposition.kind === 'unsupported') {
      expect(disposition.info).toEqual({ namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' })
    }
    expect(readStashedUnsupportedEncryption(stanza)).toEqual({
      namespace: 'eu.siacs.conversations.axolotl',
      name: 'OMEMO',
    })
    // Fallback body is left untouched
    expect(stanza.getChildText('body')).toBe('I sent you an OMEMO encrypted message.')
  })

  it('classifies as retry (stash for deferred decrypt) when no plugins are ready', () => {
    const stanza = omemoStanza()
    const disposition = recordUnclaimedEME(stanza, false)

    expect(disposition.kind).toBe('retry')
    if (disposition.kind === 'retry') {
      expect(disposition.encryptedPayloadXml).toContain('eu.siacs.conversations.axolotl')
    }
    expect(readStashedUnsupportedEncryption(stanza)).toBeUndefined()
  })

  it('keeps unclaimed OpenPGP retryable when the OpenPGP plugin is registered', async () => {
    const manager = await makeManager(new NonClaimingOpenPgpPlugin())
    const stanza = openPgpStanza()
    const disposition = recordUnclaimedEME(stanza, manager)

    expect(disposition.kind).toBe('retry')
    if (disposition.kind === 'retry') {
      expect(disposition.encryptedPayloadXml).toContain('urn:xmpp:openpgp:0')
    }
    expect(readStashedUnsupportedEncryption(stanza)).toBeUndefined()
  })

  it('detects the protocol from the child namespace when there is no EME hint (retry-shaped stanza)', () => {
    // retryDecryptSingle rebuilds a stanza from the stashed <encrypted> element
    // only — no EME hint. The child namespace alone must still classify it.
    const stanza = xml(
      'message',
      { from: 'peer@example.com/r', id: 'o2', type: 'chat' },
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
    ) as Element

    const disposition = recordUnclaimedEME(stanza, true)
    expect(disposition.kind).toBe('unsupported')
    if (disposition.kind === 'unsupported') {
      expect(disposition.info.name).toBe('OMEMO')
    }
  })

  it('returns none for a cleartext stanza', () => {
    const stanza = xml('message', { from: 'peer@example.com/r', type: 'chat' }, xml('body', {}, 'hi')) as Element
    expect(recordUnclaimedEME(stanza, true).kind).toBe('none')
    expect(recordUnclaimedEME(stanza, false).kind).toBe('none')
  })
})

// ---------------------------------------------------------------------------
// decryptStanzaInPlace: unsupported protocol with a registered plugin
// ---------------------------------------------------------------------------

describe('decryptStanzaInPlace unsupported encryption', () => {
  function omemoStanza(): Element {
    return xml(
      'message',
      { from: 'peer@example.com/r', id: 'u1', type: 'chat' },
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'eu.siacs.conversations.axolotl', name: 'OMEMO' }),
      xml('body', {}, 'OMEMO fallback'),
    ) as Element
  }

  it('flags OMEMO as unsupported (no payload stash) when a non-claiming plugin is registered', async () => {
    // FakeE2EEPlugin only claims urn:test:e2ee:0, so it never claims OMEMO,
    // but its presence means hasPlugins() === true.
    const manager = await makeManager(new FakeE2EEPlugin(undefined))
    const stanza = omemoStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(false)
    expect(result.encryptedPayloadXml).toBeUndefined()
    expect(result.unsupportedEncryption).toEqual({
      namespace: 'eu.siacs.conversations.axolotl',
      name: 'OMEMO',
    })
    expect(readStashedUnsupportedEncryption(stanza)).toEqual({
      namespace: 'eu.siacs.conversations.axolotl',
      name: 'OMEMO',
    })
    expect(stanza.getChildText('body')).toBe('OMEMO fallback')
  })

  it('stashes OMEMO for retry when no plugin is registered', async () => {
    const manager = makeEmptyManager()
    const stanza = omemoStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(false)
    expect(result.unsupportedEncryption).toBeUndefined()
    expect(result.encryptedPayloadXml).toContain('eu.siacs.conversations.axolotl')
  })
})
