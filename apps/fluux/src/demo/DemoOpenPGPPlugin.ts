import type {
  E2EEPlugin,
  E2EEProtocolDescriptor,
  PluginContext,
  PeerSupport,
  IdentityInfo,
  ConversationTarget,
  ConversationHandle,
  EncryptedPayload,
  DecryptResult,
} from '@fluux/sdk'
import type { KeyBundle } from '../e2ee/OpenPGPPluginBase'

const OPENPGP_DESCRIPTOR: E2EEProtocolDescriptor = {
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

const DEMO_FINGERPRINT = 'BAF0DF7BE3E7B61C891E7FEB3E37798300000001'
const DEMO_AVA_FINGERPRINT = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2'
const DEMO_BACKUP_PASSPHRASE = 'correct horse battery staple demo phrase two three'

function randomFingerprint(): string {
  const hex = '0123456789ABCDEF'
  let fp = ''
  for (let i = 0; i < 40; i++) fp += hex[Math.floor(Math.random() * 16)]
  return fp
}

function delay(ms = 300): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

interface DemoE2EEState {
  fingerprint: string | null
  hasBackup: boolean
  backupPassphrase: string | null
  backupFingerprint: string | null
  forceNoLocalKey: boolean
}

/**
 * In-memory OpenPGP plugin for demo mode.
 *
 * Implements both the SDK's E2EEPlugin interface and all the extra
 * methods that EncryptionSettings.tsx / OwnKeyConflictBanner.tsx call
 * via casts on `client.e2ee.getPlugin('openpgp')`.
 *
 * State lives in memory — no IndexedDB, no keychain, no PEP. Every
 * operation simulates a short delay so loading states are visible.
 *
 * URL param `?e2ee=conflict` starts the plugin with no local key but
 * an existing "server" identity, triggering the IdentityChoiceDialog.
 */
export class DemoOpenPGPPlugin implements E2EEPlugin {
  readonly descriptor = OPENPGP_DESCRIPTOR

  private state: DemoE2EEState
  private ctx: PluginContext | null = null

  constructor(opts?: { forceConflict?: boolean }) {
    this.state = {
      fingerprint: opts?.forceConflict ? null : DEMO_FINGERPRINT,
      hasBackup: opts?.forceConflict ? true : false,
      backupPassphrase: opts?.forceConflict ? DEMO_BACKUP_PASSPHRASE : null,
      backupFingerprint: opts?.forceConflict ? DEMO_FINGERPRINT : null,
      forceNoLocalKey: opts?.forceConflict ?? false,
    }
  }

  // --- E2EEPlugin interface ---

  async init(ctx: PluginContext) {
    this.ctx = ctx
  }
  async shutdown() {}

  async ensureIdentity(): Promise<IdentityInfo> {
    if (!this.state.fingerprint) {
      this.state.fingerprint = DEMO_FINGERPRINT
      this.state.forceNoLocalKey = false
    }
    return { fingerprint: this.state.fingerprint }
  }

  async probePeer(peer: string): Promise<PeerSupport> {
    return {
      supported: peer === 'ava@fluux.chat',
      ttl: 3600,
      fingerprint: peer === 'ava@fluux.chat' ? DEMO_AVA_FINGERPRINT : undefined,
    }
  }

  getPeerFingerprint(peer: string): string | null {
    return peer === 'ava@fluux.chat' ? DEMO_AVA_FINGERPRINT : null
  }

  async openConversation(_target: ConversationTarget): Promise<ConversationHandle> {
    return { protocolId: 'openpgp', state: null }
  }

  async closeConversation() {}

  async encrypt(
    _handle: ConversationHandle,
    _plaintext: Uint8Array,
  ): Promise<EncryptedPayload> {
    return {
      protocolId: 'openpgp',
      stanzaElement: {
        name: 'openpgp',
        attrs: { xmlns: 'urn:xmpp:openpgp:0' },
        children: [],
      },
      fallbackBody: '[OpenPGP-encrypted message]',
    }
  }

  async decrypt(): Promise<DecryptResult> {
    return {
      plaintext: new Uint8Array(),
      senderDevice: { jid: '', deviceId: '' },
      securityContext: { protocolId: 'openpgp', trust: 'tofu' },
    }
  }

  getVerificationMethods() {
    return []
  }

  async startVerification() {
    return {
      method: { id: '', displayName: '' },
      cancel: async () => {},
      result: Promise.resolve('unknown' as const),
    }
  }

  async getPeerTrust() {
    return 'unknown' as const
  }

  async getDeviceTrust() {
    return 'unknown' as const
  }

  tryClaimInbound() {
    return null
  }

  // --- Settings-panel methods (called via casts) ---

  getOwnFingerprint(): string | null {
    return this.state.fingerprint
  }

  async hasNoLocalKey(): Promise<boolean> {
    return this.state.forceNoLocalKey
  }

  async probeSecretKeyBackup(): Promise<'present' | 'absent' | 'unknown'> {
    await delay(200)
    // Demo mode has no failing transport, so the probe is always definitive.
    return this.state.hasBackup ? 'present' : 'absent'
  }

  getBackedUpFingerprint(): string | null {
    return this.state.backupFingerprint
  }

  async backupSecretKey(passphrase: string): Promise<void> {
    await delay(500)
    this.state.hasBackup = true
    this.state.backupPassphrase = passphrase
    this.state.backupFingerprint = this.state.fingerprint
  }

  async restoreSecretKey(
    passphrase: string,
  ): Promise<
    | { fingerprint: string }
    | { needsPicker: true; candidates: KeyBundle[]; backupContext: { message: string; passphrase: string } }
  > {
    await delay(500)
    if (passphrase !== this.state.backupPassphrase) {
      throw new Error('Incorrect passphrase')
    }
    const fp = this.state.backupFingerprint ?? DEMO_FINGERPRINT
    this.state.fingerprint = fp
    this.state.forceNoLocalKey = false
    this.ctx?.notifyKeyUnlocked?.()
    return { fingerprint: fp }
  }

  async installSelectedKey(
    _msg: string,
    _passphrase: string,
    selectedFingerprint: string,
  ): Promise<{ fingerprint: string }> {
    await delay(500)
    this.state.fingerprint = selectedFingerprint
    this.state.forceNoLocalKey = false
    this.ctx?.notifyKeyUnlocked?.()
    return { fingerprint: selectedFingerprint }
  }

  async rotateEncryptionKey(passphrase?: string): Promise<{ fingerprint: string }> {
    await delay(500)
    const fp = this.state.fingerprint ?? randomFingerprint()
    if (passphrase && this.state.hasBackup) {
      this.state.backupPassphrase = passphrase
      this.state.backupFingerprint = fp
    }
    return { fingerprint: fp }
  }

  async retractPublicKeys(): Promise<void> {
    await delay(200)
  }

  async retractSecretKeyBackup(): Promise<void> {
    await delay(200)
    this.state.hasBackup = false
    this.state.backupPassphrase = null
    this.state.backupFingerprint = null
  }

  async deleteIdentity(): Promise<void> {
    await delay(200)
    this.state.fingerprint = null
    this.state.forceNoLocalKey = false
  }

  async retireAndGenerateIdentity(): Promise<{ fingerprint: string }> {
    await delay(500)
    const fp = randomFingerprint()
    this.state.fingerprint = fp
    this.state.forceNoLocalKey = false
    this.ctx?.notifyKeyUnlocked?.()
    return { fingerprint: fp }
  }

  // File operations — not available in web demo
  async exportKeyToFile(_passphrase: string): Promise<boolean> {
    return false
  }

  async pickKeyFile(): Promise<string | null> {
    return null
  }

  async importKeyFromFile(
    _armored: string,
    _passphrase: string,
  ): Promise<
    | { fingerprint: string }
    | { needsPicker: true; candidates: KeyBundle[]; backupContext: { message: string; passphrase: string } }
  > {
    throw new Error('File import not available in demo mode')
  }

  // OwnKeyConflictBanner methods
  async resolveOwnKeyConflict_overwriteServer(): Promise<void> {
    await delay(300)
  }

  async resolveOwnKeyConflict_importFromServer(passphrase: string): Promise<unknown> {
    return this.restoreSecretKey(passphrase)
  }

  async unlock(_passphrase: string): Promise<void> {
    await delay(300)
    if (!this.state.fingerprint) {
      this.state.fingerprint = DEMO_FINGERPRINT
    }
    this.state.forceNoLocalKey = false
  }
}

export { DEMO_AVA_FINGERPRINT }
