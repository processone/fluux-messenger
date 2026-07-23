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
  COULD_NOT_DECRYPT_BODY,
} from './stanzaDecrypt'
import { E2EEManager, InMemoryStorageBackend, type XMPPPrimitives } from './index'
import { serialize as serializePayloadEnvelope } from './payloadEnvelope'
import { E2EEPluginError } from './errors'
import type {
  ConversationHandle,
  ConversationTarget,
  DecryptResult,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  IdentityInfo,
  Logger,
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

  /** When true, {@link decrypt} throws to exercise the failure-logging path. */
  public failDecrypt = false

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
    if (this.failDecrypt) throw new Error('decrypt boom')
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

/** Records every call to the injected diagnostic logger for assertions. */
function makeSpyLogger(): { logger: Logger; calls: { level: string; message: string }[] } {
  const calls: { level: string; message: string }[] = []
  const rec = (level: string) => (message: string) => calls.push({ level, message })
  return {
    logger: { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') },
    calls,
  }
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

// Claims the encrypted child but throws a caller-supplied E2EEPluginError —
// lets us exercise the rejection-vs-retry routing per error code/kind.
class ThrowingSignaturePlugin extends FakeE2EEPlugin {
  constructor(private readonly error: E2EEPluginError) {
    super(undefined)
  }

  override async decrypt(): Promise<DecryptResult> {
    throw this.error
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

  it('routes a transient signature failure (clock skew) to retry, not rejection', async () => {
    // Guard for the sticky-rejection recovery: a transient
    // `signature-not-yet-valid` error must be stashed for retryPendingDecrypts,
    // NOT rendered as a permanent rejection. Only `signature-failed` /
    // `signature-missing` map to a rejection — anything else is retryable.
    const manager = await makeManager(
      new ThrowingSignaturePlugin(
        new E2EEPluginError('transient', 'signature-not-yet-valid', 'clock skew'),
      ),
    )
    const stanza = buildStanza()
    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')
    expect(result.securityContext?.trust).not.toBe('rejected')
    expect(result.encryptedPayloadXml).toBeDefined()
    expect(readStashedEncryptedPayload(stanza)).toBe(result.encryptedPayloadXml)
  })

  it('routes a permanent signature failure to a final rejection (no retry)', async () => {
    const manager = await makeManager(
      new ThrowingSignaturePlugin(
        new E2EEPluginError('permanent', 'signature-failed', 'bad signature'),
      ),
    )
    const stanza = buildStanza()
    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')
    expect(result.securityContext?.trust).toBe('rejected')
    expect(result.encryptedPayloadXml).toBeUndefined()
  })

  it('does not stash a structurally malformed payload (permanent, never retried)', async () => {
    // A 'malformed-data' failure means the ciphertext is not valid OpenPGP and
    // will never decrypt regardless of keys (e.g. legacy/corrupt test-era
    // messages). It must NOT be stashed for retry — otherwise it re-fails on
    // every reconnect. It is also not a security rejection.
    const manager = await makeManager(
      new ThrowingSignaturePlugin(
        new E2EEPluginError('permanent', 'malformed-data', 'not a valid OpenPGP message'),
      ),
    )
    const stanza = buildStanza()
    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')
    expect(result.attempted).toBe(true)
    expect(result.securityContext?.trust).not.toBe('rejected')
    expect(result.encryptedPayloadXml).toBeUndefined()
    expect(readStashedEncryptedPayload(stanza)).toBeUndefined()
  })

  it('replaces the sender fallback body with the placeholder on a terminal malformed payload', async () => {
    // A malformed payload will never decrypt, so the sender's XEP-0373 fallback
    // <body> (cleartext the sender controls) must NOT stand in as the message —
    // it would be shown verbatim forever and even counted as a successful
    // decrypt on retry. Replace it with the could-not-decrypt placeholder,
    // mirroring the signature-rejection path.
    const manager = await makeManager(
      new ThrowingSignaturePlugin(
        new E2EEPluginError('permanent', 'malformed-data', 'not a valid OpenPGP message'),
      ),
    )
    const stanza = buildStanza() // carries <body>[Encrypted message]</body>
    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(stanza.getChild('body')?.children[0]).toBe(COULD_NOT_DECRYPT_BODY)
    expect(stanza.getChild('body')?.children[0]).not.toBe('[Encrypted message]')
    expect(result.securityContext?.trust).toBe('untrusted')
    expect(result.encryptedPayloadXml).toBeUndefined()
  })

  it('keeps the sender fallback body on a retryable (non-terminal) decrypt failure', async () => {
    // Key-locked / plugin-not-ready failures are retryable: the message is
    // stashed and the sender's fallback hint is shown until a successful retry
    // replaces it. The terminal-only overwrite must NOT touch this path.
    const manager = await makeManager(new FailingE2EEPlugin())
    const stanza = buildStanza()
    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(stanza.getChild('body')?.children[0]).toBe('[Encrypted message]')
    expect(result.encryptedPayloadXml).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Full-stanza stash: outer cleartext context (XEP-0461 <reply> and XEP-0428
// <fallback> ranges live OUTSIDE the encrypted element) must survive the
// stash, otherwise retryPendingDecrypts cannot re-run fallback stripping and
// overwrites the store body with the raw quote-prefixed plaintext.
// ---------------------------------------------------------------------------

function buildReplyStanza(): Element {
  return xml(
    'message',
    { from: 'peer@example.com/resource', id: 'm-reply', type: 'chat' },
    xml('reply', { xmlns: 'urn:xmpp:reply:0', id: 'orig-1', to: 'me@example.com' }),
    xml(
      'fallback',
      { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
      xml('body', { start: '0', end: '32' }),
    ),
    xml('body', {}, '[Encrypted message]'),
    xml('enc', { xmlns: TEST_NAMESPACE }),
  ) as Element
}

describe('stanzaDecrypt full-stanza stash (outer reply/fallback context)', () => {
  it('stashes the whole message stanza when plugin decrypt fails', async () => {
    const manager = await makeManager(new FailingE2EEPlugin())
    const stanza = buildReplyStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.encryptedPayloadXml).toMatch(/^<message/)
    expect(result.encryptedPayloadXml).toContain('urn:xmpp:reply:0')
    expect(result.encryptedPayloadXml).toContain('urn:xmpp:fallback:0')
    expect(result.encryptedPayloadXml).toContain(TEST_NAMESPACE)
  })

  it('stashes the whole message stanza when decrypt succeeds but trust is untrusted', async () => {
    const manager = await makeManager(new UntrustedE2EEPlugin())
    const stanza = buildReplyStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.encryptedPayloadXml).toMatch(/^<message/)
    expect(result.encryptedPayloadXml).toContain('urn:xmpp:reply:0')
    expect(result.encryptedPayloadXml).toContain('urn:xmpp:fallback:0')
    // The stash must hold the ENCRYPTED original (re-decryptable), not the
    // in-place-decrypted stanza.
    expect(result.encryptedPayloadXml).toContain(TEST_NAMESPACE)
    expect(result.encryptedPayloadXml).not.toContain('decrypted body')
  })

  it('stashes the whole message stanza for an unclaimed EME-hinted stanza', async () => {
    const manager = makeEmptyManager()
    const stanza = xml(
      'message',
      { from: 'peer@example.com/resource', id: 'm-eme', type: 'chat' },
      xml('reply', { xmlns: 'urn:xmpp:reply:0', id: 'orig-1', to: 'me@example.com' }),
      xml(
        'fallback',
        { xmlns: 'urn:xmpp:fallback:0', for: 'urn:xmpp:reply:0' },
        xml('body', { start: '0', end: '32' }),
      ),
      xml('body', {}, 'This message is encrypted'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:xmpp:openpgp:0' }),
      xml('openpgp', { xmlns: 'urn:xmpp:openpgp:0' }, 'ciphertext'),
    ) as Element

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(false)
    expect(result.encryptedPayloadXml).toMatch(/^<message/)
    expect(result.encryptedPayloadXml).toContain('urn:xmpp:reply:0')
    expect(result.encryptedPayloadXml).toContain('urn:xmpp:fallback:0')
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
// XEP-0384 "empty" OMEMO messages (KeyTransportElement)
// ---------------------------------------------------------------------------

describe('recordUnclaimedEME — payload-less OMEMO (empty message)', () => {
  /**
   * An OMEMO element carrying a <header> but no <payload>. Per XEP-0384 these
   * are "empty OMEMO messages, which are used in various places throughout the
   * protocol purely to manage sessions and not to transfer content" — session
   * completion acks and ratchet heartbeats. They carry nothing a user ever
   * typed and MUST NOT surface as a message.
   *
   * Shape copied verbatim (minus base64 bulk) from a stanza a Conversations
   * client sent after our device announced itself — see the phantom-message
   * report where Conversations itself rendered nothing for these.
   */
  function emptyOmemoStanza(namespace = 'eu.siacs.conversations.axolotl'): Element {
    return xml(
      'message',
      { from: 'ralphm@example.com/Conversations.cMny', type: 'chat' },
      xml(
        'encrypted',
        { xmlns: namespace },
        xml('header', { sid: '600125587' }, xml('key', { rid: '445710346' }, 'Mwoh'), xml('iv', {}, '4pEg')),
      ),
      xml('store', { xmlns: 'urn:xmpp:hints' }),
    ) as Element
  }

  /** The same envelope, but a real message: <header> AND <payload>. */
  function payloadOmemoStanza(): Element {
    return xml(
      'message',
      { from: 'ralphm@example.com/Conversations.cMny', type: 'chat' },
      xml(
        'encrypted',
        { xmlns: 'eu.siacs.conversations.axolotl' },
        xml('header', { sid: '600125587' }, xml('key', { rid: '445710346' }, 'Mwoh'), xml('iv', {}, '4pEg')),
        xml('payload', {}, 'zqPUb2xwZQ'),
      ),
    ) as Element
  }

  it('drops an empty OMEMO message instead of tagging it unsupported', () => {
    const stanza = emptyOmemoStanza()

    expect(recordUnclaimedEME(stanza, true).kind).toBe('none')
    expect(readStashedUnsupportedEncryption(stanza)).toBeUndefined()
  })

  it('drops an empty OMEMO message rather than stashing it for retry', () => {
    // No plugin registered yet. There is still nothing to show once it
    // decrypts, so stashing would only manufacture a placeholder in the
    // meantime.
    const stanza = emptyOmemoStanza()

    expect(recordUnclaimedEME(stanza, false).kind).toBe('none')
    expect(readStashedEncryptedPayload(stanza)).toBeUndefined()
  })

  it('drops an empty OMEMO 2 message', () => {
    const stanza = emptyOmemoStanza('urn:xmpp:omemo:2')

    expect(recordUnclaimedEME(stanza, true).kind).toBe('none')
    expect(readStashedUnsupportedEncryption(stanza)).toBeUndefined()
  })

  // --- controls: the drop must not widen beyond empty OMEMO -----------------

  it('still reports unsupported for an OMEMO message that carries a payload', () => {
    const stanza = payloadOmemoStanza()

    const disposition = recordUnclaimedEME(stanza, true)
    expect(disposition.kind).toBe('unsupported')
    expect(readStashedUnsupportedEncryption(stanza)).toEqual({
      namespace: 'eu.siacs.conversations.axolotl',
      name: 'OMEMO',
    })
  })

  it('still reports unsupported for OpenPGP, which has no <payload> child by design', () => {
    // <openpgp> wraps base64 directly. A blanket "no <payload> means empty"
    // rule would silently swallow every OX message — the drop is keyed on the
    // OMEMO <header>/<payload> shape, not on the absence of a payload alone.
    const stanza = xml(
      'message',
      { from: 'peer@example.com/r', id: 'pgp2', type: 'chat' },
      xml('openpgp', { xmlns: 'urn:xmpp:openpgp:0' }, 'cipher'),
      xml('encryption', { xmlns: 'urn:xmpp:eme:0', namespace: 'urn:xmpp:openpgp:0', name: 'OpenPGP' }),
    ) as Element

    const disposition = recordUnclaimedEME(stanza, true)
    expect(disposition.kind).toBe('unsupported')
    if (disposition.kind === 'unsupported') {
      expect(disposition.info.name).toBe('OpenPGP')
    }
  })

  it('still reports unsupported for an OMEMO element with neither header nor payload', () => {
    // Malformed, not an empty message: nothing identifies it as key transport,
    // so it keeps the visible "unsupported" treatment rather than vanishing.
    const stanza = xml(
      'message',
      { from: 'peer@example.com/r', type: 'chat' },
      xml('encrypted', { xmlns: 'eu.siacs.conversations.axolotl' }, 'cipher'),
    ) as Element

    expect(recordUnclaimedEME(stanza, true).kind).toBe('unsupported')
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

// ---------------------------------------------------------------------------
// Decrypt-path diagnostics route through the manager's injected logger
// ---------------------------------------------------------------------------

describe('decryptStanzaInPlace — failure logging routes through the manager logger', () => {
  it('warns via the diagnostic logger with domain only on decrypt failure', async () => {
    const { logger, calls } = makeSpyLogger()
    const manager = new E2EEManager({
      storage: new InMemoryStorageBackend(),
      xmpp: stubXmppPrimitives(),
      account: { jid: 'me@example.com' },
      logger,
    })
    const plugin = new FakeE2EEPlugin(undefined)
    plugin.failDecrypt = true
    await manager.register(plugin)

    const stanza = xml(
      'message',
      { from: 'eve@private.example.org/res', id: 'm1' },
      xml('enc', { xmlns: TEST_NAMESPACE }, 'ciphertext'),
    ) as unknown as Element
    await decryptStanzaInPlace(stanza, manager, 'eve@private.example.org', 'live')

    const warn = calls.find((c) => c.level === 'warn' && c.message.includes('decrypt failed'))
    expect(warn).toBeDefined()
    expect(warn!.message).toContain('private.example.org')
    expect(warn!.message).not.toContain('eve@')
  })
})

// ---------------------------------------------------------------------------
// Ratcheting status: control-message (silent consume) + broken-session (repair)
// ---------------------------------------------------------------------------

/** Returns a `control-message` result: decrypt advanced the session but there
 *  is no user-visible plaintext (a key-transport / ratchet-advance message). */
class ControlMessagePlugin extends FakeE2EEPlugin {
  constructor() {
    super(undefined)
  }
  override async decrypt(): Promise<DecryptResult> {
    return {
      status: 'control-message',
      senderDevice: { jid: 'peer@example.com', deviceId: 'dev' },
      securityContext: { protocolId: TEST_PROTOCOL_ID, trust: 'tofu' },
    }
  }
}

/** Returns a `broken-session` result and records repairSession invocations. */
class BrokenSessionPlugin extends FakeE2EEPlugin {
  public repairCalls: { peer: string }[] = []
  constructor() {
    super(undefined)
  }
  override async decrypt(): Promise<DecryptResult> {
    return {
      status: 'broken-session',
      senderDevice: { jid: 'peer@example.com', deviceId: 'dev' },
      securityContext: { protocolId: TEST_PROTOCOL_ID, trust: 'untrusted', notes: ['ratchet gap'] },
    }
  }
  async repairSession(_h: ConversationHandle, peer: string): Promise<void> {
    this.repairCalls.push({ peer })
  }
}

function bodilessStanza(): Element {
  return xml(
    'message',
    { from: 'peer@example.com/resource', id: 'mc', type: 'chat' },
    xml('enc', { xmlns: TEST_NAMESPACE }),
  ) as Element
}

describe('stanzaDecrypt — control-message status', () => {
  it('consumes a bodiless control message silently (no placeholder body)', async () => {
    const manager = await makeManager(new ControlMessagePlugin())
    const stanza = bodilessStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(result.attempted).toBe(true)
    // No plaintext → no body is synthesized for a control message.
    expect(stanza.getChild('body')).toBeUndefined()
    // The encrypted child is still stripped so it isn't re-claimed.
    expect(stanza.getChild('enc')).toBeUndefined()
    // Not a failure → nothing stashed for deferred retry.
    expect(result.encryptedPayloadXml).toBeUndefined()
    expect(result.securityContext?.trust).toBe('tofu')
  })

  it('does not overwrite an existing fallback body with a placeholder', async () => {
    const manager = await makeManager(new ControlMessagePlugin())
    const stanza = buildStanza() // carries a '[Encrypted message]' hint body

    await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    // Control message leaves the sender hint as-is — it is neither replaced
    // with plaintext nor with a could-not-decrypt placeholder.
    expect(stanza.getChild('body')?.text()).toBe('[Encrypted message]')
  })
})

describe('stanzaDecrypt — broken-session status', () => {
  it('shows a could-not-decrypt placeholder and triggers session repair', async () => {
    const plugin = new BrokenSessionPlugin()
    const manager = await makeManager(plugin)
    const stanza = buildStanza()

    const result = await decryptStanzaInPlace(stanza, manager, 'peer@example.com')
    // repairSession is fire-and-forget; let the microtask/selectStrategy settle.
    await new Promise((r) => setTimeout(r, 0))

    expect(result.attempted).toBe(true)
    expect(stanza.getChild('body')?.text()).toBe(COULD_NOT_DECRYPT_BODY)
    expect(result.securityContext?.trust).toBe('untrusted')
    expect(result.securityContext?.notes?.[0]).toContain('session needs repair')
    // Not stashed for a plain retry — repair is the recovery path.
    expect(result.encryptedPayloadXml).toBeUndefined()
    expect(plugin.repairCalls).toEqual([{ peer: 'peer@example.com' }])
  })

  it('does not stash a broken-session message for deferred retry', async () => {
    const manager = await makeManager(new BrokenSessionPlugin())
    const stanza = buildStanza()

    await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    expect(readStashedEncryptedPayload(stanza)).toBeUndefined()
  })

  it('logs the broken-session disposition (not retryable, not rejected)', async () => {
    const { logger, calls } = makeSpyLogger()
    const manager = new E2EEManager({
      storage: new InMemoryStorageBackend(),
      xmpp: stubXmppPrimitives(),
      account: { jid: 'me@example.com' },
      logger,
    })
    await manager.register(new BrokenSessionPlugin())
    const stanza = buildStanza()

    await decryptStanzaInPlace(stanza, manager, 'peer@example.com')

    const warn = calls.find((c) => c.level === 'warn' && c.message.includes('decrypt failed'))
    expect(warn?.message).toContain('broken session')
  })
})
