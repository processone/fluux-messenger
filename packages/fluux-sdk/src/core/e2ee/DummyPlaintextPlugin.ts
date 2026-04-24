import type {
  BareJID,
  ConversationHandle,
  ConversationTarget,
  DecryptResult,
  E2EEPlugin,
  E2EEProtocolDescriptor,
  EncryptedPayload,
  IdentityInfo,
  InboundDecryptContext,
  PeerSupport,
  PluginContext,
  SecurityContext,
  TrustState,
  VerificationFlow,
  VerificationMethod,
  XMLElementData,
} from './types'

const DUMMY_XMLNS = 'urn:fluux:e2ee-dummy:0'

/**
 * Plaintext "plugin" used to validate the host machinery end-to-end.
 *
 * Encrypt and decrypt are identity transforms; the payload wraps the
 * plaintext in a single element so we can exercise the stanza-plumbing
 * path that real plugins will use. NOT secure and NOT selectable above
 * a real plugin (securityLevel is 0).
 *
 * **Not exported from the public SDK surface by design.** Auto-selection
 * would never pick this over a real plugin, but an app that pins it would
 * transmit plaintext while the UI suggests encryption. Keeping it out of
 * the public surface removes that foot-gun. SDK tests import it via
 * relative path.
 */
export class DummyPlaintextPlugin implements E2EEPlugin {
  readonly descriptor: E2EEProtocolDescriptor = {
    id: 'dummy-plaintext',
    displayName: 'Dummy (plaintext)',
    securityLevel: 0,
    features: {
      forwardSecrecy: false,
      postCompromiseSecurity: false,
      multiDevice: false,
      groupChat: true,
      asynchronous: true,
      deniability: true,
    },
  }

  private ctx: PluginContext | null = null
  private readonly openHandles = new Set<ConversationHandle>()

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
  }

  async shutdown(): Promise<void> {
    this.openHandles.clear()
    this.ctx = null
  }

  async ensureIdentity(): Promise<IdentityInfo> {
    return { fingerprint: 'dummy:no-identity' }
  }

  async probePeer(_peer: BareJID): Promise<PeerSupport> {
    return { supported: true, ttl: 60 }
  }

  async openConversation(target: ConversationTarget): Promise<ConversationHandle> {
    const handle: ConversationHandle = {
      protocolId: this.descriptor.id,
      state: { target },
    }
    this.openHandles.add(handle)
    return handle
  }

  async closeConversation(handle: ConversationHandle): Promise<void> {
    this.openHandles.delete(handle)
  }

  async encrypt(_handle: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload> {
    const b64 = bytesToBase64(plaintext)
    const stanzaElement: XMLElementData = {
      name: 'plain',
      attrs: { xmlns: DUMMY_XMLNS },
      children: [b64],
    }
    return {
      protocolId: this.descriptor.id,
      stanzaElement,
      fallbackBody: '[dummy-plaintext payload]',
    }
  }

  async decrypt(
    _handle: ConversationHandle,
    payload: EncryptedPayload,
    _context?: InboundDecryptContext,
  ): Promise<DecryptResult> {
    if (payload.protocolId !== this.descriptor.id) {
      throw new Error(`DummyPlaintextPlugin cannot decrypt protocol: ${payload.protocolId}`)
    }
    const text = extractBase64(payload.stanzaElement)
    if (text === null) throw new Error('Malformed dummy-plaintext payload')
    const plaintext = base64ToBytes(text)
    const senderJid = this.ctx?.account.jid ?? 'unknown@localhost'
    const securityContext: SecurityContext = {
      protocolId: this.descriptor.id,
      trust: 'untrusted',
      notes: ['dummy plugin — plaintext transport'],
    }
    return {
      plaintext,
      senderDevice: { jid: senderJid, deviceId: 'dummy' },
      securityContext,
    }
  }

  getVerificationMethods(): VerificationMethod[] {
    return []
  }

  async startVerification(_peer: BareJID, _method: VerificationMethod): Promise<VerificationFlow> {
    throw new Error('DummyPlaintextPlugin does not support verification')
  }

  async getPeerTrust(_peer: BareJID): Promise<TrustState> {
    return 'untrusted'
  }

  async getDeviceTrust(_peer: BareJID, _deviceId: string): Promise<TrustState> {
    return 'untrusted'
  }

  tryClaimInbound(stanzaChild: XMLElementData): EncryptedPayload | null {
    if (stanzaChild.name !== 'plain') return null
    if (stanzaChild.attrs?.xmlns !== DUMMY_XMLNS) return null
    return {
      protocolId: this.descriptor.id,
      stanzaElement: stanzaChild,
    }
  }
}

function extractBase64(el: XMLElementData): string | null {
  const child = el.children[0]
  return typeof child === 'string' ? child : null
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  if (typeof btoa === 'function') return btoa(binary)
  // Node / test runtime fallback
  return Buffer.from(bytes).toString('base64')
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(b64)
    const out = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
    return out
  }
  return new Uint8Array(Buffer.from(b64, 'base64'))
}
