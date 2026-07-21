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
import type { KeyBundle, VerifiedKeysView } from '@fluux/openpgp-plugin'
import { fingerprintsEqual } from '@fluux/openpgp-plugin'

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
 * Small in-memory holder for demo verified-key state, satisfying the same
 * `VerifiedKeysView` contract the real plugins expose via
 * `OpenPGPPluginBase.getVerifiedKeysView()` (`VerifiedKeysCache` in
 * `@fluux/openpgp-plugin`). `DemoOpenPGPPlugin` doesn't extend
 * `OpenPGPPluginBase` (no `PluginStorage`, no PEP, no real crypto), so it
 * can't reuse `VerifiedKeysCache` directly — but the app's read path
 * (`useVerifiedFingerprint` / `useConversationEncryptionState`, via
 * `apps/fluux/src/e2ee/verifiedPeersView.ts`) doesn't care which class
 * implements the interface, only that it does.
 *
 * Mirrors `VerifiedKeysCache`'s two load-bearing properties:
 * - `getSnapshot()` is referentially stable between mutations (cached,
 *   invalidated on write) — required by `useSyncExternalStore`'s
 *   infinite-loop guard.
 * - `isVerified` compares fingerprints via `fingerprintsEqual` (case- and
 *   whitespace-insensitive), not `===`, so this demo stand-in can't be
 *   stricter than the real plugin it's standing in for.
 */
class DemoVerifiedKeysHolder implements VerifiedKeysView {
  private map = new Map<string, string>()
  private listeners = new Set<() => void>()
  /** Cached immutable snapshot; invalidated (set to null) on every mutation. */
  private snapshot: Record<string, string> | null = null

  isVerified(jid: string, fingerprint: string): boolean {
    if (!fingerprint) return false
    const stored = this.map.get(jid)
    return stored !== undefined && fingerprintsEqual(stored, fingerprint)
  }

  getVerifiedFingerprint(jid: string): string | null {
    return this.map.get(jid) ?? null
  }

  getSnapshot(): Record<string, string> {
    if (this.snapshot === null) this.snapshot = Object.freeze(Object.fromEntries(this.map))
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setVerified(jid: string, fingerprint: string): void {
    this.map.set(jid, fingerprint)
    this.notify()
  }

  clearVerified(jid: string): void {
    if (!this.map.has(jid)) return
    this.map.delete(jid)
    this.notify()
  }

  private notify(): void {
    this.snapshot = null
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // One bad subscriber must not stop the others.
      }
    }
  }
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
  private readonly verifiedKeys = new DemoVerifiedKeysHolder()

  constructor(opts?: { forceConflict?: boolean }) {
    this.state = {
      fingerprint: opts?.forceConflict ? null : DEMO_FINGERPRINT,
      hasBackup: opts?.forceConflict ? true : false,
      backupPassphrase: opts?.forceConflict ? DEMO_BACKUP_PASSPHRASE : null,
      backupFingerprint: opts?.forceConflict ? DEMO_FINGERPRINT : null,
      forceNoLocalKey: opts?.forceConflict ?? false,
    }
    // Boot seed: Ava's identity is pre-verified so the encryption badge is
    // visible on her conversation from first paint. Previously seeded from
    // `demo.tsx` into the (now-deleted) `useVerifiedPeerKeysStore`; moved
    // here so the seed lives with the fingerprint it seeds (`probePeer`/
    // `getPeerFingerprint` already hardcode `DEMO_AVA_FINGERPRINT` for this
    // same peer) instead of depending on demo.tsx's construction order.
    this.verifiedKeys.setVerified('ava@fluux.chat', DEMO_AVA_FINGERPRINT)
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

  /**
   * Per-identity trust write (E2EEPlugin trait), mirroring the real
   * `OpenPGPPluginBase.setIdentityTrust`: OpenPGP is single-key per peer,
   * so `'verified'` pins the marker to the peer's current fingerprint and
   * `'untrusted'` clears it. Writes straight to this plugin's own
   * `verifiedKeys` holder (see `getVerifiedKeysView()`) — the chat header /
   * contact profile chip read that view via `apps/fluux/src/e2ee/
   * verifiedPeersView.ts`, so the demo's verify/revoke flow actually flips
   * the chip instead of hitting the "plugin unavailable" branch (this
   * plugin doesn't extend `OpenPGPPluginBase`, so it needs its own trait
   * implementation; without it every demo verify surfaced a red error
   * toast instead of succeeding). No-ops when the peer has no known
   * fingerprint, or when a non-empty `id` no longer matches the current
   * one (stale identity reference).
   */
  async setIdentityTrust(peer: string, id: string, decision: 'verified' | 'untrusted'): Promise<void> {
    await delay(200)
    const cur = this.getPeerFingerprint(peer)
    if (!cur) return
    if (id && id !== cur) return
    if (decision === 'verified') {
      this.verifiedKeys.setVerified(peer, cur)
    } else {
      this.verifiedKeys.clearVerified(peer)
    }
  }

  /**
   * Read-only view onto this plugin's verified-key state, satisfying the
   * same contract the real plugins expose via `OpenPGPPluginBase.
   * getVerifiedKeysView()`. `demo.tsx` wires this into `apps/fluux/src/e2ee/
   * verifiedPeersView.ts` (`setVerifiedKeysView`) after registering the
   * plugin — the demo path builds its `E2EEManager` by hand and never runs
   * `registerE2EEPlugins`/`registerPlugins.ts`, so that Task-3 wiring's
   * usual call site doesn't apply here and demo.tsx must call this itself.
   */
  getVerifiedKeysView(): VerifiedKeysView {
    return this.verifiedKeys
  }

  // --- Settings-panel methods (called via casts) ---

  getOwnFingerprint(): string | null {
    return this.state.fingerprint
  }

  async hasNoLocalKey(): Promise<boolean> {
    return this.state.forceNoLocalKey
  }

  async hasSecretKeyBackup(): Promise<boolean> {
    await delay(200)
    return this.state.hasBackup
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
