// `OmemoPlugin` — the `E2EEPlugin` adapter over `@fluux/omemo`.
//
// This file covers the identity/probe/trust half of the trait (Task 10).
// `openConversation`/`closeConversation`/`encrypt`/`decrypt`/`tryClaimInbound`
// are intentionally stubbed here — they land in Task 11 — but are still
// implemented (throwing / returning null) so the class satisfies the
// `E2EEPlugin` interface today.
import type {
  E2EEPlugin,
  E2EEProtocolDescriptor,
  PluginContext,
  IdentityInfo,
  PeerSupport,
  BareJID,
  TrustState,
  VerificationMethod,
  VerificationFlow,
  ConversationTarget,
  ConversationHandle,
  EncryptedPayload,
  DecryptResult,
  InboundDecryptContext,
  XMLElementData,
} from '@fluux/sdk'
import { OmemoAccount } from '@fluux/omemo'
import { PluginStorageOmemoStore } from './store'
import { publishDeviceList, fetchDeviceList, publishBundle } from './pep'
import { toTrustState, type BtbvState } from './trust'
import { NS_OMEMO } from './namespaces'

const hex = (u: Uint8Array): string => [...u].map((b) => b.toString(16).padStart(2, '0')).join('')

export class OmemoPlugin implements E2EEPlugin {
  readonly descriptor: E2EEProtocolDescriptor = {
    id: 'omemo:2',
    displayName: 'OMEMO',
    securityLevel: 80,
    features: {
      forwardSecrecy: true,
      postCompromiseSecurity: true,
      multiDevice: true,
      groupChat: false,
      asynchronous: true,
      deniability: true,
    },
  }

  private ctx!: PluginContext
  private account: OmemoAccount | null = null
  private readonly rng: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
  }

  async shutdown(): Promise<void> {
    this.account = null
  }

  /** Lazily creates/loads the local `OmemoAccount`. Idempotent across restarts (`OmemoAccount.create` loads an existing identity when the store has one). */
  private async ensureAccount(): Promise<OmemoAccount> {
    if (this.account) return this.account
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    this.account = await OmemoAccount.create(store, this.rng)
    return this.account
  }

  async ensureIdentity(): Promise<IdentityInfo> {
    const acc = await this.ensureAccount()
    const myDeviceId = acc.publishableDeviceId()
    await publishBundle(this.ctx.xmpp, myDeviceId, await acc.publishableBundleAsync())
    const existing = await fetchDeviceList(this.ctx.xmpp, this.ctx.account.jid)
    if (!existing.includes(myDeviceId)) {
      await publishDeviceList(this.ctx.xmpp, [...existing, myDeviceId])
    }
    return {
      fingerprint: hex(acc.identityFingerprint()),
      devices: [{ jid: this.ctx.account.jid, deviceId: String(myDeviceId) }],
    }
  }

  async probePeer(peer: BareJID): Promise<PeerSupport> {
    const ids = await fetchDeviceList(this.ctx.xmpp, peer)
    return { supported: ids.length > 0, ttl: 300, variant: NS_OMEMO }
  }

  getVerificationMethods(): VerificationMethod[] {
    return [
      {
        id: 'fingerprint-compare',
        displayName: 'Compare fingerprints',
        description: 'Confirm the safety number out of band.',
      },
    ]
  }

  async startVerification(_peer: BareJID, _method: VerificationMethod): Promise<VerificationFlow> {
    throw new Error('fingerprint-compare verification UI is a later sub-project')
  }

  async getPeerTrust(peer: BareJID): Promise<TrustState> {
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    const ids = await fetchDeviceList(this.ctx.xmpp, peer)
    let best: TrustState = 'unknown'
    for (const id of ids) {
      const t = await store.loadTrust(peer, id)
      const s = toTrustState((t?.state as BtbvState) ?? 'undecided')
      if (s === 'tofu' && best === 'unknown') best = 'tofu'
    }
    return best
  }

  async getDeviceTrust(peer: BareJID, deviceId: string): Promise<TrustState> {
    const store = new PluginStorageOmemoStore(this.ctx.storage)
    const t = await store.loadTrust(peer, Number(deviceId))
    return toTrustState((t?.state as BtbvState) ?? 'undecided')
  }

  // --- Task 11 stubs: encrypt/decrypt half of the trait. ---
  // These make `OmemoPlugin` satisfy `E2EEPlugin` today; real implementations
  // land in Task 11.

  async openConversation(_target: ConversationTarget): Promise<ConversationHandle> {
    throw new Error('implemented in Task 11')
  }

  async closeConversation(_handle: ConversationHandle): Promise<void> {
    throw new Error('implemented in Task 11')
  }

  async encrypt(_handle: ConversationHandle, _plaintext: Uint8Array): Promise<EncryptedPayload> {
    throw new Error('implemented in Task 11')
  }

  async decrypt(
    _handle: ConversationHandle,
    _payload: EncryptedPayload,
    _context?: InboundDecryptContext,
  ): Promise<DecryptResult> {
    throw new Error('implemented in Task 11')
  }

  tryClaimInbound(_stanzaChild: XMLElementData): EncryptedPayload | null {
    return null
  }
}
