/**
 * Abstract base class for XEP-0373 (OpenPGP for XMPP) E2EE plugins.
 *
 * Contains all protocol-level logic that is independent of the crypto
 * backend:
 *
 * - PEP publication / fetching (XEP-0373 §4 & §5 node layout)
 * - Peer key management, TOFU pinning, key-change alerts
 * - Pending-verification stash and drain
 * - Cross-device verification sync
 * - Own-key conflict detection and resolution
 * - Trust evaluation and security-context construction
 *
 * Concrete subclasses supply the crypto layer by implementing the abstract
 * methods below:
 *
 * - {@link SequoiaPgpPlugin} — delegates to Rust via Tauri IPC (desktop)
 * - {@link WebOpenPGPPlugin} — uses openpgp.js in the browser (web)
 *
 * See `SequoiaPgpPlugin.ts` and `WebOpenPGPPlugin.ts` for the platform-
 * specific implementations.
 *
 * # PEP publication layout (XEP-0373 §4)
 *
 * Two nodes per identity:
 *
 * - **Metadata** at `urn:xmpp:openpgp:0:public-keys`. Single item
 *   `<public-keys-list>` listing every advertised key's
 *   `<pubkey-metadata v4-fingerprint='…' date='…'/>`.
 * - **Data** at `urn:xmpp:openpgp:0:public-keys:FINGERPRINT` (one node
 *   per key). Single item `<pubkey><data>BASE64</data></pubkey>`.
 *
 * # v6 fingerprints + dual-attribute metadata
 *
 * We emit BOTH `v4-fingerprint` and `v6-fingerprint` attributes on every
 * `<pubkey-metadata>` element with the same value. On parse we prefer
 * `v6-fingerprint` and fall back to `v4-fingerprint`. This covers Sequoia
 * v6 keys (64 hex chars) and openpgp.js v4 keys (40 hex chars) equally.
 */

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
  PEPItem,
  PeerSupport,
  PluginContext,
  SecurityContext,
  TrustState,
  VerificationFlow,
  VerificationMethod,
  XMLElementData,
} from '@fluux/sdk'
import {
  E2EEPluginError,
  SigncryptEnvelopeError,
  unwrapSigncrypt,
  wrapForSigncrypt,
  type E2EEErrorKind,
} from '@fluux/sdk'
import { getBareJid } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import {
  clearBackedUpFingerprint,
  readBackedUpFingerprint,
  writeBackedUpFingerprint,
} from './backupMarker'
import {
  probeRemoteIdentityState,
  probeRemotePublishedFingerprints,
  SecretKeyBackupProbeError,
} from './secretKeyProbe'
import {
  clearPeerVerified,
  isPeerVerified,
  setPeerVerified,
  useVerifiedPeerKeysStore,
} from '@/stores/verifiedPeerKeysStore'
import {
  VERIFICATIONS_NODE,
  fetchVerificationsFromServer,
  loadAppliedVerificationsVersion,
  planVerificationUpdate,
  publishVerificationsToServer,
  saveAppliedVerificationsVersion,
} from './verificationSync'
import {
  clearKeyChangeAlert,
  getKeyChangeAlert,
  recordKeyChangeAlert,
} from '@/stores/keyChangeAlertsStore'
import {
  clearOwnKeyConflict,
  getOwnKeyConflict,
  recordOwnKeyConflict,
} from '@/stores/ownKeyConflictStore'
import {
  getPinnedPrimaryFp,
  setPinnedPrimaryFp,
} from '@/stores/pinnedPrimaryFingerprintsStore'
import {
  clearCertRejections,
  recordCertRejections,
  type CertRejection,
} from '@/stores/certRejectionStore'
import {
  sealTrustState,
  verifyTrustStateSeal,
  isTofuBlockedByCompromise,
  clearCompromisedAndReseal,
} from './trustStateIntegrity'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { setTrustStateStatus } from '@/stores/trustStateStatusStore'

// ---------------------------------------------------------------------------
// XEP-0373 constants
// ---------------------------------------------------------------------------

const OX_NAMESPACE = 'urn:xmpp:openpgp:0'
const PUBSUB_NAMESPACE = 'http://jabber.org/protocol/pubsub'
const PUBSUB_PUBLISH_OPTIONS_FEATURE = 'http://jabber.org/protocol/pubsub#publish-options'
const PEP_IDENTITY_CATEGORY = 'pubsub'
const PEP_IDENTITY_TYPE = 'pep'
const PUBLIC_KEYS_METADATA_NODE = 'urn:xmpp:openpgp:0:public-keys'
const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'
const CURRENT_ITEM_ID = 'current'

function publicKeyDataNodeFor(fingerprint: string): string {
  return `${PUBLIC_KEYS_METADATA_NODE}:${fingerprint}`
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/**
 * Public key material for an identity (own or peer). Does NOT carry secret
 * key material — crypto backends keep that internally.
 */
export interface KeyBundle {
  fingerprint: string
  publicArmored: string
  /** True when the private key is protected by the OS keychain (Tauri only). */
  keychainBacked: boolean
  /** ISO 8601 primary-key creation time (present in backup-import results). */
  createdAt?: string
}

/**
 * Discriminated union returned by {@link restoreSecretKey} /
 * {@link importKeyFromFile}. When the backup contains a single key
 * (or auto-selection succeeds), the caller receives an `IdentityInfo`.
 * When multiple keys exist and no heuristic can confidently pick one,
 * the caller receives the candidates so a picker UI can be shown.
 */
export type RestoreResult =
  | IdentityInfo
  | {
      needsPicker: true
      candidates: KeyBundle[]
      backupContext: { message: string; passphrase: string }
    }

/** Decryption result returned by the crypto backend. */
export interface DecryptOutput {
  plaintext: string
  signatureVerified: boolean
  signerFingerprint: string | null
  signaturePresent: boolean
}

export interface CertValidation {
  fingerprint: string
  encryptionSubkeyCount: number
  userIds: string[]
}

interface PendingVerification {
  messageId: string
  ciphertext: string
  plaintext: string
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

const SIGNATURE_BUFFER_SIZE = 50
const SIGNATURE_BUFFER_TTL_MS = 10 * 60 * 1000
const SIGNCRYPT_CLOCK_SKEW_MS = 7 * 24 * 60 * 60 * 1000
const PROBE_NEGATIVE_TTL_SECONDS = 300
const PROBE_TRANSIENT_TTL_SECONDS = 30

// ---------------------------------------------------------------------------
// Shared error helpers
// ---------------------------------------------------------------------------

/**
 * Classify a raw error into transient/permanent + machine-readable code.
 * Handles XMPP-level IQ errors (same on all platforms) and common
 * Rust/openpgp.js failure messages.
 */
export function classifyBoundaryError(err: unknown): { kind: E2EEErrorKind; code: string } {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  if (msg.includes('no skesk matched') || msg.includes('session key decryption failed') || msg.includes('incorrect key passphrase')) {
    return { kind: 'permanent', code: 'wrong-passphrase' }
  }
  if (msg.includes('passphrase is empty')) return { kind: 'permanent', code: 'empty-passphrase' }
  if (msg.includes('passphrase for account') && msg.includes('not in the keychain')) {
    return { kind: 'permanent', code: 'key-unrecoverable' }
  }
  if (msg.includes('no key for account') || msg.includes('no identity')) {
    return { kind: 'permanent', code: 'key-missing' }
  }
  if (msg.includes('not a recognizable openpgp') || msg.includes('unknown pem type') || msg.includes('could not convert stream')) {
    return { kind: 'permanent', code: 'malformed-key' }
  }
  if (msg.includes('backup input is a public key')) {
    return { kind: 'permanent', code: 'malformed-backup' }
  }
  if (msg.includes('parse ') || msg.includes('not valid')) {
    return { kind: 'permanent', code: 'malformed-data' }
  }
  if (msg.includes('item-not-found')) return { kind: 'permanent', code: 'not-found' }
  if (msg.includes('feature-not-implemented') || msg.includes('does not advertise pep')) {
    return { kind: 'permanent', code: 'pep-unsupported' }
  }
  if (msg.includes('key-locked')) return { kind: 'transient', code: 'key-locked' }

  if (msg.includes('panicked')) return { kind: 'transient', code: 'ipc-panic' }
  if (msg.includes('timeout') || msg.includes('timed out')) {
    return { kind: 'transient', code: 'timeout' }
  }
  if (msg.includes('remote-server-timeout')) return { kind: 'transient', code: 'timeout' }
  if (msg.includes('remote-server-not-found') || msg.includes('service-unavailable')) {
    return { kind: 'transient', code: 'server-unreachable' }
  }
  if (msg.includes('internal-server-error') || msg.includes('resource-constraint')) {
    return { kind: 'transient', code: 'server-error' }
  }

  return { kind: 'transient', code: 'unknown' }
}

// ---------------------------------------------------------------------------
// Shared XEP-0373 protocol descriptor
// ---------------------------------------------------------------------------

export const OPENPGP_DESCRIPTOR: E2EEProtocolDescriptor = {
  id: 'openpgp',
  displayName: 'OpenPGP (XEP-0373)',
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

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

export abstract class OpenPGPPluginBase implements E2EEPlugin {
  readonly descriptor = OPENPGP_DESCRIPTOR

  protected ctx: PluginContext | null = null
  protected ownBundle: KeyBundle | null = null

  private readonly peerKeys = new Map<BareJID, KeyBundle>()
  private readonly pendingVerifications = new Map<BareJID, PendingVerification[]>()
  protected now: () => number = () => Date.now()

  private _verificationStoreUnsub: (() => void) | null = null
  private _trustStoreUnsubs: Array<() => void> = []
  private _trustStateSealTimeout: ReturnType<typeof setTimeout> | null = null
  private _syncingFromRemoteCount = 0
  private _publishVerificationTimeout: ReturnType<typeof setTimeout> | null = null

  /**
   * Cross-cutting bypass for the WebOpenPGPPlugin's silent-fork guard
   * inside {@link ensureKeyMaterial}. Set by {@link retireAndGenerateIdentity}
   * around its own explicit regeneration so the guard — which exists to
   * catch ACCIDENTAL silent generation — doesn't block the
   * user-authorised replacement. Read by the subclass's guard.
   *
   * Lives on the base because both subclasses share this concern: even
   * desktop (Sequoia) will inherit the same guard in a follow-up to fix
   * the symmetrical desktop bug. Always reset in a `finally`.
   */
  protected _allowSilentRegenerate = false

  // ---------------------------------------------------------------------------
  // Abstract crypto methods — implemented by each platform subclass
  // ---------------------------------------------------------------------------

  /**
   * Load or generate the account's key material. Returns public metadata.
   * Sets `this.ownBundle` is the responsibility of {@link ensureIdentity};
   * this method only needs to return the bundle.
   */
  protected abstract ensureKeyMaterial(accountJid: string): Promise<KeyBundle>

  /**
   * Sign and encrypt `plaintext` to `recipientPublicArmored`, returning
   * armored ciphertext. `senderAccountJid` identifies the signing identity.
   */
  protected abstract encryptToRecipient(
    senderAccountJid: string,
    recipientPublicArmored: string,
    plaintext: string,
  ): Promise<string>

  /**
   * Decrypt `ciphertext` encrypted to our own key. `senderPublicArmored`
   * is provided when available for signature verification; may be `null`.
   */
  protected abstract decryptWithOwnKey(
    accountJid: string,
    ciphertext: string,
    senderPublicArmored: string | null,
  ): Promise<DecryptOutput>

  /**
   * Parse `publicArmored` and return its fingerprint and the count of
   * usable encryption subkeys. Replaces the Tauri `openpgp_validate_cert`
   * command so both platforms can validate peer keys.
   */
  protected abstract validateCert(
    publicArmored: string,
  ): Promise<CertValidation>

  /**
   * Rotate the encryption subkey while keeping the primary key (and
   * therefore the fingerprint peers have pinned) stable. Returns the
   * updated bundle with the same primary fingerprint.
   */
  protected abstract rotateKeyMaterial(accountJid: string): Promise<KeyBundle>

  /**
   * Encrypt the TSK (transfer secret key) under `passphrase` and return
   * an armored OpenPGP message. The XEP-0373 boundary converts it to raw
   * OpenPGP bytes encoded as Base64 before publishing.
   */
  protected abstract backupEncrypt(accountJid: string, passphrase: string): Promise<string>

  /**
   * Decrypt an armored backup message with `passphrase`, persist the
   * recovered TSK, and return the public bundle for the restored key.
   */
  protected abstract backupImport(
    accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle>

  /**
   * Decrypt a backup message and return metadata for ALL TSKs found
   * inside. Does NOT persist anything — the caller picks one and
   * then calls {@link backupImportSelected} to install it.
   */
  protected abstract backupImportAll(
    accountJid: string,
    backupMessage: string,
    passphrase: string,
  ): Promise<KeyBundle[]>

  /**
   * Decrypt a backup, find the TSK matching `selectedFingerprint`,
   * persist it, and return the public bundle for the installed key.
   */
  protected abstract backupImportSelected(
    accountJid: string,
    backupMessage: string,
    passphrase: string,
    selectedFingerprint: string,
  ): Promise<KeyBundle>

  /**
   * Permanently delete all key material for `accountJid`. Called by
   * {@link deleteIdentity} after recording the intent in the base class.
   */
  protected abstract forgetAccount(accountJid: string): Promise<void>

  /**
   * Export the key to a user-chosen file. Platform-specific: Tauri uses a
   * native save dialog; web uses a browser download link.
   * Returns `true` when the file was written, `false` when the user
   * dismissed the dialog without choosing a path.
   */
  abstract exportKeyToFile(passphrase: string): Promise<boolean>

  /**
   * Export the account TSK as an ASCII-armored `PRIVATE KEY BLOCK`, the
   * standard OpenPGP format expected by external tools (gpg, OpenKeychain,
   * Kleopatra). Distinct from {@link exportKeyToFile} which produces a
   * XEP-0373 §5 encrypted MESSAGE only other XMPP clients understand.
   *
   * `passphrase` is optional: when provided, secret packets are wrapped
   * with the standard Iterated+Salted S2K (universally interoperable);
   * when `null`, secret packets are written in clear and the UI must have
   * acknowledged the risk. Returns `true` when the file was written,
   * `false` when the user cancelled the save dialog.
   */
  abstract exportPrivateKeyToFile(passphrase: string | null): Promise<boolean>

  /**
   * Open a file picker and return the armored content of the selected
   * file, or `null` when the user cancels the picker.
   */
  abstract pickKeyFile(): Promise<string | null>

  // ---------------------------------------------------------------------------
  // Plugin lifecycle
  // ---------------------------------------------------------------------------

  async init(ctx: PluginContext): Promise<void> {
    this.ctx = ctx
    if (!ctx.account.jid) {
      throw new Error(`${this.pluginName()}: requires a logged-in account JID`)
    }
    try {
      await this.ensureIdentity()
    } catch (err) {
      if (err instanceof E2EEPluginError && err.code === 'key-locked') {
        // Web plugin: key stored but passphrase not yet provided.
        // Plugin is registered in a locked state; call activateSubscriptions()
        // after the user unlocks via unlock().
        return
      }
      if (err instanceof E2EEPluginError && err.code === 'needs-identity-decision') {
        // Web plugin: no local key AND server already advertises an
        // OpenPGP identity for this account. Silent generation would
        // fork the identity, so the safety guard in `ensureKeyMaterial`
        // bailed out. The plugin stays registered in a "needs decision"
        // state — the host should detect this (via the unlock dialog or
        // the encryption-settings toggle flow) and route the user to a
        // resolution: import the matching private key, or explicitly
        // retire the published identity.
        return
      }
      throw err
    }
    this.activateSubscriptions()
  }

  /**
   * Set up PEP and store subscriptions after the key has been successfully
   * loaded. Called from {@link init} on normal startup, and from
   * {@link WebOpenPGPPlugin.unlock} after the user supplies a passphrase.
   * Guards against double-activation.
   */
  protected activateSubscriptions(): void {
    if (this._verificationStoreUnsub) return
    const ctx = this.requireCtx()
    void this.syncVerificationsFromServer()
    ctx.xmpp.subscribePEP(ctx.account.jid, VERIFICATIONS_NODE, () => {
      void this.syncVerificationsFromServer()
    })
    this._verificationStoreUnsub = useVerifiedPeerKeysStore.subscribe(
      (state, prev) => {
        if (
          state.verifiedFingerprintByJid !== prev.verifiedFingerprintByJid &&
          this._syncingFromRemoteCount === 0
        ) {
          this.scheduleVerificationsPublish(state.verifiedFingerprintByJid)
        }
      },
    )

    this._trustStoreUnsubs = [
      usePinnedPrimaryFingerprintsStore.subscribe(
        (state, prev) => {
          if (state.pinnedFingerprintByJid !== prev.pinnedFingerprintByJid) {
            this.scheduleTrustStateSeal()
          }
        },
      ),
      useVerifiedPeerKeysStore.subscribe(
        (state, prev) => {
          if (state.verifiedFingerprintByJid !== prev.verifiedFingerprintByJid) {
            this.scheduleTrustStateSeal()
          }
        },
      ),
      useKeyChangeAlertsStore.subscribe(
        (state, prev) => {
          if (state.alertsByJid !== prev.alertsByJid) {
            this.scheduleTrustStateSeal()
          }
        },
      ),
    ]

    void this.verifyTrustStateOnInit()
  }

  private scheduleTrustStateSeal(): void {
    if (!this.ctx) return
    if (this._trustStateSealTimeout !== null) clearTimeout(this._trustStateSealTimeout)
    this._trustStateSealTimeout = setTimeout(() => {
      this._trustStateSealTimeout = null
      if (!this.ctx) return
      void this.sealTrustStateNow()
    }, 500)
  }

  private async sealTrustStateNow(): Promise<void> {
    const ownPublicArmored = this.ownBundle?.publicArmored
    if (!ownPublicArmored || !this.ctx) return
    try {
      const jid = this.ctx.account.jid
      await sealTrustState(
        (plaintext, recipientKey) => this.encryptToRecipient(jid, recipientKey, plaintext),
        ownPublicArmored,
      )
      setTrustStateStatus('sealed')
    } catch {
      // Best-effort — key may be locked between scheduling and execution
    }
  }

  private async verifyTrustStateOnInit(): Promise<void> {
    const ownPublicArmored = this.ownBundle?.publicArmored
    const ownFingerprint = this.ownBundle?.fingerprint
    if (!ownPublicArmored || !ownFingerprint || !this.ctx) return
    const jid = this.ctx.account.jid
    const { status, details } = await verifyTrustStateSeal(
      (ciphertext, senderPub) => this.decryptWithOwnKey(jid, ciphertext, senderPub),
      ownPublicArmored,
      ownFingerprint,
    )
    if (status === 'pending-seal') {
      await this.sealTrustStateNow()
      return
    }
    setTrustStateStatus(status, details)
  }

  async resealTrustState(): Promise<void> {
    const ownPublicArmored = this.ownBundle?.publicArmored
    if (!ownPublicArmored || !this.ctx) return
    const jid = this.ctx.account.jid
    await clearCompromisedAndReseal(
      (plaintext, recipientKey) => this.encryptToRecipient(jid, recipientKey, plaintext),
      ownPublicArmored,
    )
  }

  async shutdown(): Promise<void> {
    if (this._publishVerificationTimeout !== null) {
      clearTimeout(this._publishVerificationTimeout)
      this._publishVerificationTimeout = null
    }
    if (this._trustStateSealTimeout !== null) {
      clearTimeout(this._trustStateSealTimeout)
      this._trustStateSealTimeout = null
    }
    this._verificationStoreUnsub?.()
    this._verificationStoreUnsub = null
    this._trustStoreUnsubs.forEach((u) => u())
    this._trustStoreUnsubs = []
    this.ownBundle = null
    this.peerKeys.clear()
    this.pendingVerifications.clear()
    this.ctx = null
  }

  /**
   * Permanently destroy the local key material for this account. Callers
   * must call {@link retractPublicKeys} FIRST while the session is live.
   */
  async deleteIdentity(): Promise<void> {
    const accountJid = this.ctx?.account.jid
    if (accountJid) {
      await this.forgetAccount(accountJid).catch(() => {})
      clearBackedUpFingerprint(accountJid)
    }
    this.ownBundle = null
    this.peerKeys.clear()
  }

  // ---------------------------------------------------------------------------
  // Identity & key management
  // ---------------------------------------------------------------------------

  async ensureIdentity(): Promise<IdentityInfo> {
    const ctx = this.requireCtx()
    let bundle: KeyBundle
    try {
      bundle = await this.ensureKeyMaterial(ctx.account.jid)
    } catch (err) {
      throw this.toPluginError('ensureIdentity', err)
    }
    this.ownBundle = bundle

    await this.probePepSupport()
    await this.checkOwnPublishedKeyConsistency(bundle)
    if (getOwnKeyConflict()) {
      ctx.logger.warn(
        `${this.pluginName()}: own key conflict detected (${getOwnKeyConflict()!.kind}); ` +
          `encryption blocked until resolved`,
      )
      return { fingerprint: bundle.fingerprint }
    }

    try {
      await this.publishOwnPublicKeyData(bundle)
      await this.publishOwnPublicKeyMetadata(bundle)
    } catch (err) {
      ctx.logger.warn(
        `${this.pluginName()}: public key publish failed: ${formatError(err)}`,
      )
    }

    return { fingerprint: bundle.fingerprint }
  }

  async rotateEncryptionKey(backupPassphrase?: string): Promise<IdentityInfo> {
    const ctx = this.requireCtx()
    if (!this.ownBundle) {
      throw new E2EEPluginError(
        'permanent',
        'no-identity',
        `${this.pluginName()}: cannot rotate before ensureIdentity has completed`,
      )
    }
    const previousFingerprint = this.ownBundle.fingerprint

    let bundle: KeyBundle
    try {
      bundle = await this.rotateKeyMaterial(ctx.account.jid)
    } catch (err) {
      throw this.toPluginError('rotateEncryptionKey', err)
    }

    if (!fingerprintsEqual(bundle.fingerprint, previousFingerprint)) {
      throw new Error(
        `${this.pluginName()}: rotation produced new fingerprint ${bundle.fingerprint} (expected stable ${previousFingerprint})`,
      )
    }
    this.ownBundle = bundle

    try {
      await this.publishOwnPublicKeyData(bundle)
      await this.publishOwnPublicKeyMetadata(bundle)
    } catch (err) {
      ctx.logger.warn(
        `${this.pluginName()}: rotated key publish failed: ${formatError(err)}`,
      )
    }

    if (backupPassphrase !== undefined) {
      try {
        await this.backupSecretKey(backupPassphrase)
      } catch (err) {
        ctx.logger.warn(
          `${this.pluginName()}: rotated backup publish failed: ${formatError(err)}`,
        )
      }
    }

    return { fingerprint: bundle.fingerprint }
  }

  /**
   * Explicit, user-driven invalidation + replacement of the published
   * OpenPGP identity. The third option of the IdentityChoiceDialog —
   * for users who cannot recover the matching private key (no backup,
   * no file) and accept that:
   *   - peers must re-pin (key change alert on their side);
   *   - past messages encrypted to the retired key are unrecoverable
   *     from this device.
   *
   * Distinct from {@link rotateEncryptionKey} (rotates the encryption
   * subkey within the same primary cert — keeps the published identity
   * stable) and from {@link restoreSecretKey} / {@link importKeyFromFile}
   * (imports a key whose fingerprint already matches the published one).
   *
   * Steps:
   *   1. Enumerate every published fingerprint via the lightweight PEP
   *      probe so we retract historical data nodes too, not just the
   *      one this device happens to know about.
   *   2. Retract metadata + each data node. Best-effort — a retract
   *      failure must not block step 4 because the new publication
   *      overwrites the metadata regardless.
   *   3. Clear local key material so the regenerate branch fires.
   *   4. Generate a fresh keypair. The {@link _allowSilentRegenerate}
   *      flag bypasses the web subclass's safety guard (which exists
   *      to catch ACCIDENTAL forks; this is an authorised replacement).
   *   5. Publish the new public key (data, then metadata, mirroring
   *      {@link ensureIdentity}'s ordering).
   *   6. Clear the own-key-conflict banner: server and local are now
   *      back in sync.
   */
  async retireAndGenerateIdentity(): Promise<IdentityInfo> {
    const ctx = this.requireCtx()

    let publishedFingerprints: string[] = []
    try {
      publishedFingerprints = await probeRemotePublishedFingerprints(
        this.makePepProbeAdapter(),
        ctx.account.jid,
      )
    } catch (err) {
      ctx.logger.debug(
        `${this.pluginName()}: enumerate published fingerprints during retire failed: ${formatError(err)}`,
      )
    }

    await ctx.xmpp
      .retractPEP(PUBLIC_KEYS_METADATA_NODE, CURRENT_ITEM_ID)
      .catch((err) => {
        ctx.logger.debug(
          `${this.pluginName()}: retract metadata during retire failed: ${formatError(err)}`,
        )
      })
    for (const fp of publishedFingerprints) {
      await ctx.xmpp
        .retractPEP(publicKeyDataNodeFor(fp), CURRENT_ITEM_ID)
        .catch((err) => {
          ctx.logger.debug(
            `${this.pluginName()}: retract data node ${fp} during retire failed: ${formatError(err)}`,
          )
        })
    }

    await this.forgetAccount(ctx.account.jid).catch(() => {})
    this.ownBundle = null

    this._allowSilentRegenerate = true
    let bundle: KeyBundle
    try {
      bundle = await this.ensureKeyMaterial(ctx.account.jid)
    } finally {
      this._allowSilentRegenerate = false
    }
    this.ownBundle = bundle

    try {
      await this.publishOwnPublicKeyData(bundle)
      await this.publishOwnPublicKeyMetadata(bundle)
    } catch (err) {
      ctx.logger.warn(
        `${this.pluginName()}: retire publish failed: ${formatError(err)}`,
      )
    }

    clearOwnKeyConflict()

    return { fingerprint: bundle.fingerprint }
  }

  /**
   * Shared "silent-fork" safety guard, called by both subclasses' key-
   * generation paths before they create new key material. Refuses
   * generation when the server already holds OpenPGP identity material
   * for this account — either a published public key OR a secret-key
   * backup. The bug this prevents: a fresh device that silently
   * generates a key, publishes its fingerprint to PEP, and overwrites
   * the metadata peers had pinned, leaving any sibling device that
   * still holds the matching private key (or any peer whose pinning
   * has not refreshed) unable to deliver / decrypt.
   *
   * Bypassable via the {@link _allowSilentRegenerate} flag, which
   * {@link retireAndGenerateIdentity} sets during its
   * user-authorised replacement (it retracted the published identity
   * itself; propagation timing would otherwise re-trip the guard).
   */
  protected async assertSilentGenerationAllowed(accountJid: string): Promise<void> {
    if (this._allowSilentRegenerate) return
    let identityState
    try {
      identityState = await probeRemoteIdentityState(
        this.makePepProbeAdapter(),
        accountJid,
      )
    } catch (err) {
      if (err instanceof SecretKeyBackupProbeError) {
        throw new E2EEPluginError(
          'transient',
          'identity-probe-failed',
          `${this.pluginName()}: could not probe server for existing identity before key generation: ${err.message}`,
          err,
        )
      }
      throw err
    }
    if (identityState.hasServerIdentity) {
      const reason =
        identityState.publishedFingerprints.length > 0
          ? `public key advertised (${identityState.publishedFingerprints[0]})`
          : 'backup present'
      throw new E2EEPluginError(
        'permanent',
        'needs-identity-decision',
        `${this.pluginName()}: server already holds an OpenPGP identity for ${accountJid} (${reason}). ` +
          `Silent generation would fork this identity. The user must import the matching private key ` +
          `(from the server backup or a file) or explicitly retire the published identity.`,
      )
    }
  }

  /**
   * Adapter that lets the standalone PEP probe helpers (which take an
   * XMPPClient) run against this plugin's `ctx.xmpp.queryPEP`. The
   * shape match is exact for the one call site they touch (`pubsub.query`).
   */
  protected makePepProbeAdapter(): XMPPClient {
    const ctx = this.requireCtx()
    return {
      pubsub: {
        query: (jid: string, node: string, max?: number) =>
          ctx.xmpp.queryPEP(jid, node, max),
      },
    } as unknown as XMPPClient
  }

  async retractPublicKeys(): Promise<void> {
    const ctx = this.requireCtx()
    const fingerprint = this.ownBundle?.fingerprint
    await ctx.xmpp
      .retractPEP(PUBLIC_KEYS_METADATA_NODE, CURRENT_ITEM_ID)
      .catch((err) => {
        ctx.logger.debug(
          `${this.pluginName()}: retract metadata failed: ${formatError(err)}`,
        )
      })
    if (fingerprint) {
      await ctx.xmpp
        .retractPEP(publicKeyDataNodeFor(fingerprint), CURRENT_ITEM_ID)
        .catch((err) => {
          ctx.logger.debug(
            `${this.pluginName()}: retract data node for ${fingerprint} failed: ${formatError(err)}`,
          )
        })
    }
  }

  async retractSecretKeyBackup(): Promise<void> {
    const ctx = this.requireCtx()
    await ctx.xmpp.retractPEP(SECRET_KEY_NODE, CURRENT_ITEM_ID).catch((err) => {
      ctx.logger.debug(
        `${this.pluginName()}: retract secret-key backup failed: ${formatError(err)}`,
      )
    })
    clearBackedUpFingerprint(ctx.account.jid)
  }

  // ---------------------------------------------------------------------------
  // XEP-0373 §5 Secret Key Synchronization
  // ---------------------------------------------------------------------------

  async backupSecretKey(passphrase: string): Promise<void> {
    const ctx = this.requireCtx()
    if (!this.ownBundle) {
      throw new E2EEPluginError(
        'permanent',
        'no-identity',
        `${this.pluginName()}: no identity to back up — call ensureIdentity first`,
      )
    }
    let armoredMessage: string
    try {
      armoredMessage = await this.backupEncrypt(ctx.account.jid, passphrase)
    } catch (err) {
      throw this.toPluginError('backupSecretKey', err)
    }
    const payload: XMLElementData = {
      name: 'secretkey',
      attrs: { xmlns: OX_NAMESPACE },
      children: [base64EncodeOpenPgpBlock(armoredMessage)],
    }
    await ctx.xmpp.publishPEP(
      SECRET_KEY_NODE,
      { id: CURRENT_ITEM_ID, payload },
      { accessModel: 'whitelist', maxItems: 1, persistItems: true },
    )
    writeBackedUpFingerprint(ctx.account.jid, this.ownBundle.fingerprint)
  }

  async fetchSecretKeyBackup(): Promise<string | null> {
    const ctx = this.requireCtx()
    try {
      const items = await ctx.xmpp.queryPEP(ctx.account.jid, SECRET_KEY_NODE, 1)
      for (const item of items) {
        const armored = parseSecretKeyBackupItem(item.payload)
        if (armored) return armored
      }
    } catch (err) {
      ctx.logger.debug(
        `${this.pluginName()}: fetchSecretKeyBackup: ${formatError(err)} (treated as no backup)`,
      )
    }
    return null
  }

  async hasSecretKeyBackup(): Promise<boolean> {
    return (await this.fetchSecretKeyBackup()) !== null
  }

  async restoreSecretKey(passphrase: string): Promise<RestoreResult> {
    const ctx = this.requireCtx()
    const armoredMessage = await this.fetchSecretKeyBackup()
    if (!armoredMessage) {
      throw new E2EEPluginError(
        'permanent',
        'no-backup',
        `${this.pluginName()}: no secret-key backup found on server`,
      )
    }

    let bundles: KeyBundle[]
    try {
      bundles = await this.backupImportAll(ctx.account.jid, armoredMessage, passphrase)
    } catch (err) {
      throw this.toPluginError('restoreSecretKey', err)
    }

    const selection = await this.selectKeyFromBackup(bundles)
    if (!selection) {
      throw new E2EEPluginError(
        'permanent',
        'no-backup',
        `${this.pluginName()}: backup contained no usable keys`,
      )
    }

    if (!selection.needsPicker) {
      return this.doInstallKey(armoredMessage, passphrase, selection.selected.fingerprint)
    }

    return {
      needsPicker: true,
      candidates: bundles,
      backupContext: { message: armoredMessage, passphrase },
    }
  }

  async importKeyFromFile(armoredMessage: string, passphrase: string): Promise<RestoreResult> {
    const ctx = this.requireCtx()

    let bundles: KeyBundle[]
    try {
      bundles = await this.backupImportAll(ctx.account.jid, armoredMessage, passphrase)
    } catch (err) {
      throw this.toPluginError('importKeyFromFile', err)
    }

    const selection = await this.selectKeyFromBackup(bundles)
    if (!selection) {
      throw new E2EEPluginError(
        'permanent',
        'malformed-data',
        `${this.pluginName()}: imported file contained no usable keys`,
      )
    }

    if (!selection.needsPicker) {
      return this.doInstallKey(armoredMessage, passphrase, selection.selected.fingerprint)
    }

    return {
      needsPicker: true,
      candidates: bundles,
      backupContext: { message: armoredMessage, passphrase },
    }
  }

  async installSelectedKey(
    backupMessage: string,
    passphrase: string,
    fingerprint: string,
  ): Promise<IdentityInfo> {
    return this.doInstallKey(backupMessage, passphrase, fingerprint)
  }

  protected async selectKeyFromBackup(
    bundles: KeyBundle[],
  ): Promise<{ selected: KeyBundle; needsPicker: boolean } | null> {
    if (bundles.length === 0) return null
    if (bundles.length === 1) return { selected: bundles[0], needsPicker: false }

    const ctx = this.requireCtx()
    try {
      const items = await ctx.xmpp.queryPEP(ctx.account.jid, PUBLIC_KEYS_METADATA_NODE, 1)
      const advertised = parseAdvertisedFingerprints(items)
      const match = bundles.find((b) =>
        advertised.some((fp) => fingerprintsEqual(fp, b.fingerprint)),
      )
      if (match) return { selected: match, needsPicker: false }
    } catch {
      // Metadata unavailable — fall through to date heuristic
    }

    const sorted = [...bundles].sort((a, b) => {
      const da = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const db = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return db - da
    })
    return { selected: sorted[0], needsPicker: true }
  }

  private async doInstallKey(
    backupMessage: string,
    passphrase: string,
    fingerprint: string,
  ): Promise<IdentityInfo> {
    const ctx = this.requireCtx()
    const previousFingerprint = this.ownBundle?.fingerprint
    let bundle: KeyBundle
    try {
      bundle = await this.backupImportSelected(
        ctx.account.jid,
        backupMessage,
        passphrase,
        fingerprint,
      )
    } catch (err) {
      throw this.toPluginError('installKey', err)
    }
    this.ownBundle = bundle
    writeBackedUpFingerprint(ctx.account.jid, bundle.fingerprint)

    try {
      await this.publishOwnPublicKeyData(bundle)
      await this.publishOwnPublicKeyMetadata(bundle)
      if (previousFingerprint) {
        await this.retractStalePublicKeyDataNode(previousFingerprint, bundle.fingerprint)
      }
    } catch (err) {
      ctx.logger.warn(
        `${this.pluginName()}: public key publish after install failed: ${formatError(err)}`,
      )
    }

    return { fingerprint: bundle.fingerprint }
  }

  async resolveOwnKeyConflict_overwriteServer(): Promise<void> {
    if (!this.ownBundle) {
      throw new E2EEPluginError(
        'permanent',
        'no-identity',
        `${this.pluginName()}: cannot overwrite server before ensureIdentity has completed`,
      )
    }
    await this.publishOwnPublicKeyData(this.ownBundle)
    await this.publishOwnPublicKeyMetadata(this.ownBundle)
    clearOwnKeyConflict()
  }

  async resolveOwnKeyConflict_importFromServer(passphrase: string): Promise<IdentityInfo> {
    const result = await this.restoreSecretKey(passphrase)
    if ('needsPicker' in result) {
      // Conflict resolution always picks the newest key — no picker UI.
      const sorted = [...result.candidates].sort((a, b) => {
        const da = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const db = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return db - da
      })
      const info = await this.doInstallKey(
        result.backupContext.message,
        result.backupContext.passphrase,
        sorted[0].fingerprint,
      )
      clearOwnKeyConflict()
      return info
    }
    clearOwnKeyConflict()
    return result
  }

  // ---------------------------------------------------------------------------
  // Cross-device verification sync
  // ---------------------------------------------------------------------------

  private async syncVerificationsFromServer(): Promise<void> {
    if (!this.ownBundle || !this.ctx) return
    this._syncingFromRemoteCount++
    const ctx = this.ctx
    const ownPublicArmored = this.ownBundle.publicArmored
    const ownFingerprint = this.ownBundle.fingerprint
    try {
      const remote = await fetchVerificationsFromServer(
        ctx,
        (ciphertext, senderKey) =>
          this.decryptWithOwnKey(ctx.account.jid, ciphertext, senderKey),
        ctx.account.jid,
        ownPublicArmored,
        ownFingerprint,
      )
      if (!remote) return
      const local = useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid
      const plan = planVerificationUpdate(remote, local, loadAppliedVerificationsVersion())
      if (!plan.apply) return
      for (const { jid, fingerprint } of plan.toSet) setPeerVerified(jid, fingerprint)
      for (const jid of plan.toClear) clearPeerVerified(jid)
      saveAppliedVerificationsVersion(plan.version)
      this.scheduleTrustStateSeal()
    } catch {
      // Non-blocking — local store is always the source of truth.
    } finally {
      this._syncingFromRemoteCount--
    }
  }

  private scheduleVerificationsPublish(verifications: Record<string, string>): void {
    if (this._publishVerificationTimeout !== null) {
      clearTimeout(this._publishVerificationTimeout)
    }
    this._publishVerificationTimeout = setTimeout(() => {
      this._publishVerificationTimeout = null
      if (!this.ownBundle || !this.ctx) return
      const ctx = this.ctx
      const ownPublicArmored = this.ownBundle.publicArmored
      // Reserve the next version above the highest we've applied/published.
      // Real versions start at 1; 0 is reserved for legacy (v1) snapshots.
      const nextVersion = Math.max(loadAppliedVerificationsVersion(), 0) + 1
      void publishVerificationsToServer(
        ctx,
        (plaintext, recipientKey) =>
          this.encryptToRecipient(ctx.account.jid, recipientKey, plaintext),
        ownPublicArmored,
        verifications,
        nextVersion,
      )
        .then(() => {
          saveAppliedVerificationsVersion(nextVersion)
          this.scheduleTrustStateSeal()
        })
        .catch(() => {})
    }, 500)
  }

  // ---------------------------------------------------------------------------
  // PEP probe, publication, and consistency check
  // ---------------------------------------------------------------------------

  private async probePepSupport(): Promise<void> {
    const ctx = this.requireCtx()
    let disco
    try {
      disco = await ctx.xmpp.queryDisco(ctx.account.jid)
    } catch (err) {
      throw this.toPluginError('pep-support-probe', err)
    }
    const hasPepIdentity = disco.identities.some(
      (id) => id.category === PEP_IDENTITY_CATEGORY && id.type === PEP_IDENTITY_TYPE,
    )
    const hasPubsubFeature = disco.features.some((f) => f.var === PUBSUB_NAMESPACE)
    if (!hasPepIdentity && !hasPubsubFeature) {
      throw new E2EEPluginError(
        'permanent',
        'pep-unsupported',
        `${this.pluginName()}: account JID ${ctx.account.jid} does not advertise PEP (XEP-0163)`,
      )
    }
    if (!disco.features.some((f) => f.var === PUBSUB_PUBLISH_OPTIONS_FEATURE)) {
      ctx.logger.warn(
        `${this.pluginName()}: PEP present but \`publish-options\` not advertised — proceeding`,
      )
    }
  }

  private async checkOwnPublishedKeyConsistency(bundle: KeyBundle): Promise<void> {
    const ctx = this.requireCtx()

    let metadataItems: PEPItem[]
    try {
      metadataItems = await ctx.xmpp.queryPEP(ctx.account.jid, PUBLIC_KEYS_METADATA_NODE, 1)
    } catch {
      clearOwnKeyConflict()
      return
    }

    if (metadataItems.length === 0) {
      clearOwnKeyConflict()
      return
    }

    const advertised = parseAdvertisedFingerprints(metadataItems)
    if (advertised.length === 0) {
      clearOwnKeyConflict()
      return
    }

    let publishedDate = ''
    outer: for (const item of metadataItems) {
      const list = item.payload
      if (list.name !== 'public-keys-list' || list.attrs?.xmlns !== OX_NAMESPACE) continue
      for (const child of list.children) {
        if (typeof child === 'string') continue
        if (child.name === 'pubkey-metadata') {
          publishedDate = firstAttr(child.attrs, ['date']) ?? ''
          break outer
        }
      }
    }

    const matchingFP = advertised.find((fp) => fingerprintsEqual(fp, bundle.fingerprint))
    if (!matchingFP) {
      recordOwnKeyConflict({
        kind: 'primary-mismatch',
        localFingerprint: bundle.fingerprint,
        publishedFingerprint: advertised[0] ?? '',
        publishedDate,
      })
      return
    }

    let dataItems: PEPItem[]
    try {
      dataItems = await ctx.xmpp.queryPEP(
        ctx.account.jid,
        publicKeyDataNodeFor(bundle.fingerprint),
        1,
      )
    } catch {
      clearOwnKeyConflict()
      return
    }

    if (dataItems.length === 0) {
      clearOwnKeyConflict()
      return
    }

    const publishedArmored = parsePublicKeyDataItem(dataItems[0].payload)
    if (publishedArmored !== null && !openPgpBlocksEqual(publishedArmored, bundle.publicArmored)) {
      recordOwnKeyConflict({
        kind: 'subkey-mismatch',
        localFingerprint: bundle.fingerprint,
        publishedFingerprint: bundle.fingerprint,
        publishedDate,
      })
      return
    }

    clearOwnKeyConflict()
  }

  private async publishOwnPublicKeyData(bundle: KeyBundle): Promise<void> {
    const payload: XMLElementData = {
      name: 'pubkey',
      attrs: { xmlns: OX_NAMESPACE },
      children: [
        {
          name: 'data',
          attrs: {},
          children: [base64EncodeOpenPgpBlock(bundle.publicArmored)],
        },
      ],
    }
    await this.publishWithPreconditionHeal(
      publicKeyDataNodeFor(bundle.fingerprint),
      { id: CURRENT_ITEM_ID, payload },
      { accessModel: 'open', persistItems: true, maxItems: 1 },
    )
  }

  private async publishOwnPublicKeyMetadata(bundle: KeyBundle): Promise<void> {
    const payload: XMLElementData = {
      name: 'public-keys-list',
      attrs: { xmlns: OX_NAMESPACE },
      children: [
        {
          name: 'pubkey-metadata',
          attrs: {
            'v4-fingerprint': bundle.fingerprint,
            'v6-fingerprint': bundle.fingerprint,
            date: new Date().toISOString(),
          },
          children: [],
        },
      ],
    }
    await this.publishWithPreconditionHeal(
      PUBLIC_KEYS_METADATA_NODE,
      { id: CURRENT_ITEM_ID, payload },
      { accessModel: 'open', persistItems: true, maxItems: 1 },
    )
  }

  private async publishWithPreconditionHeal(
    node: string,
    item: { id: string; payload: XMLElementData },
    options: {
      accessModel?: 'open' | 'whitelist' | 'presence' | 'roster' | 'authorize'
      maxItems?: number
      persistItems?: boolean
    },
  ): Promise<void> {
    const ctx = this.requireCtx()
    try {
      await ctx.xmpp.publishPEP(node, item, options)
    } catch (err) {
      if (!isPreconditionNotMet(err)) throw err
      ctx.logger.warn(
        `${this.pluginName()}: publish rejected on ${node} with precondition-not-met; deleting node and retrying`,
      )
      try {
        await ctx.xmpp.deletePEP(node)
      } catch (deleteErr) {
        ctx.logger.debug(
          `${this.pluginName()}: delete ${node} after precondition-not-met failed: ${formatError(deleteErr)}`,
        )
        throw err
      }
      await ctx.xmpp.publishPEP(node, item, options)
    }
  }

  private async retractStalePublicKeyDataNode(
    oldFingerprint: string,
    newFingerprint: string,
  ): Promise<void> {
    if (oldFingerprint === newFingerprint) return
    const ctx = this.requireCtx()
    const node = publicKeyDataNodeFor(oldFingerprint)
    try {
      await ctx.xmpp.deletePEP(node)
      ctx.logger.debug(
        `${this.pluginName()}: deleted stale public-key data node ${node}`,
      )
    } catch (err) {
      ctx.logger.debug(
        `${this.pluginName()}: stale data-node delete for ${oldFingerprint} failed (best-effort): ${formatError(err)}`,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Peer key probing and caching
  // ---------------------------------------------------------------------------

  async probePeer(peer: BareJID): Promise<PeerSupport> {
    const cached = this.peerKeys.get(peer)
    if (cached) {
      return {
        supported: true,
        ttl: PROBE_NEGATIVE_TTL_SECONDS,
        fingerprint: cached.fingerprint,
      }
    }
    return this.refetchAndCachePeerKey(peer)
  }

  private async refetchAndCachePeerKey(peer: BareJID): Promise<PeerSupport> {
    const ctx = this.requireCtx()
    try {
      const metadataItems = await ctx.xmpp.queryPEP(peer, PUBLIC_KEYS_METADATA_NODE, 1)
      const fingerprints = parseAdvertisedFingerprints(metadataItems)
      if (fingerprints.length === 0) {
        clearCertRejections(peer)
        return { supported: false, ttl: PROBE_NEGATIVE_TTL_SECONDS }
      }

      const rejections: CertRejection[] = []
      for (const fingerprint of fingerprints) {
        const bundle = await this.fetchAdvertisedKey(peer, fingerprint, rejections)
        if (bundle) {
          clearCertRejections(peer)
          this.cachePeerKey(peer, bundle)
          return {
            supported: true,
            ttl: PROBE_NEGATIVE_TTL_SECONDS,
            fingerprint: bundle.fingerprint,
          }
        }
      }
      if (rejections.length > 0) {
        recordCertRejections(peer, rejections)
      } else {
        clearCertRejections(peer)
      }
      return { supported: false, ttl: PROBE_NEGATIVE_TTL_SECONDS }
    } catch (err) {
      const { kind, code } = classifyBoundaryError(err)
      ctx.logger.debug(
        `${this.pluginName()}: probePeer(${peer}) failed (${kind}/${code}): ${formatError(err)}`,
      )
      return {
        supported: false,
        ttl: kind === 'transient' ? PROBE_TRANSIENT_TTL_SECONDS : PROBE_NEGATIVE_TTL_SECONDS,
      }
    }
  }

  private async fetchAdvertisedKey(
    peer: BareJID,
    fingerprint: string,
    rejections: CertRejection[],
  ): Promise<KeyBundle | null> {
    const ctx = this.requireCtx()
    const now = new Date().toISOString()
    try {
      const items = await ctx.xmpp.queryPEP(peer, publicKeyDataNodeFor(fingerprint), 1)
      for (const item of items) {
        const armored = parsePublicKeyDataItem(item.payload)
        if (!armored) continue
        let validation: CertValidation
        try {
          validation = await this.validateCert(armored)
        } catch (err) {
          const detail = formatError(err)
          ctx.logger.warn(
            `${this.pluginName()}: validateCert for ${peer}/${fingerprint} failed: ${detail}`,
          )
          rejections.push({ fingerprint, code: 'validation_failed', detail, observedAt: now })
          continue
        }
        if (!fingerprintsEqual(validation.fingerprint, fingerprint)) {
          const detail = `advertised ${fingerprint}, served ${validation.fingerprint}`
          ctx.logger.warn(
            `${this.pluginName()}: ${peer} ${detail}; discarding`,
          )
          rejections.push({ fingerprint, code: 'fingerprint_mismatch', detail, observedAt: now })
          continue
        }
        const expectedUid = `xmpp:${peer}`
        const uidMatch = validation.userIds.some(
          (uid) => uid.toLowerCase() === expectedUid.toLowerCase(),
        )
        if (!uidMatch) {
          const detail = `expected ${expectedUid}, got [${validation.userIds.join(', ')}]`
          ctx.logger.warn(
            `${this.pluginName()}: ${peer} key ${fingerprint} has no matching UID (${detail}); discarding`,
          )
          rejections.push({ fingerprint, code: 'uid_mismatch', detail, observedAt: now })
          continue
        }
        return {
          fingerprint: validation.fingerprint,
          publicArmored: armored,
          keychainBacked: false,
        }
      }
    } catch (err) {
      ctx.logger.debug(
        `${this.pluginName()}: fetch ${peer} key ${fingerprint} failed: ${formatError(err)}`,
      )
    }
    return null
  }

  private cachePeerKey(peer: BareJID, bundle: KeyBundle): void {
    const pinnedFp = getPinnedPrimaryFp(peer)
    if (!pinnedFp) {
      if (isTofuBlockedByCompromise(peer)) {
        recordKeyChangeAlert(peer, 'unknown-cleared', bundle.fingerprint)
        return
      }
      setPinnedPrimaryFp(peer, bundle.fingerprint)
      this.peerKeys.set(peer, bundle)
      return
    }
    if (pinnedFp === bundle.fingerprint) {
      this.peerKeys.set(peer, bundle)
      return
    }
    recordKeyChangeAlert(peer, pinnedFp, bundle.fingerprint)
  }

  async acceptPeerKeyChange(peer: BareJID, asVerified: boolean): Promise<void> {
    const alert = getKeyChangeAlert(peer)
    if (!alert) return
    const targetFp = alert.currentFingerprint
    const previousFp = alert.previousFingerprint

    clearPeerVerified(peer)
    setPinnedPrimaryFp(peer, targetFp)

    const result = await this.refetchAndCachePeerKey(peer)

    if (!result.supported) {
      setPinnedPrimaryFp(peer, previousFp)
      throw new Error(`acceptPeerKeyChange: failed to fetch new key for ${peer}; pin rolled back`)
    }

    const postFetchAlert = getKeyChangeAlert(peer)
    if (!postFetchAlert || postFetchAlert.previousFingerprint !== targetFp) {
      clearKeyChangeAlert(peer)
    }

    if (asVerified) {
      const cached = this.peerKeys.get(peer)
      if (cached && cached.fingerprint === targetFp) {
        setPeerVerified(peer, targetFp)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // E2EEPlugin interface — conversation & encrypt/decrypt
  // ---------------------------------------------------------------------------

  async openConversation(target: ConversationTarget): Promise<ConversationHandle> {
    if (target.kind !== 'direct') {
      throw new Error(`${this.pluginName()}: MUC encryption is not supported in this phase`)
    }
    return { protocolId: OPENPGP_DESCRIPTOR.id, state: { peer: target.peer } }
  }

  async closeConversation(_handle: ConversationHandle): Promise<void> {
    // Stateless — no per-conversation resources to release.
  }

  async encrypt(handle: ConversationHandle, plaintext: Uint8Array): Promise<EncryptedPayload> {
    const ctx = this.requireCtx()
    if (getOwnKeyConflict()) {
      throw new E2EEPluginError(
        'permanent',
        'own-key-conflict',
        `${this.pluginName()}: own key conflict (${getOwnKeyConflict()!.kind}) must be resolved before encrypting`,
      )
    }
    const peer = extractPeer(handle)
    const peerBundle = this.peerKeys.get(peer)
    if (!peerBundle) {
      throw new E2EEPluginError(
        'transient',
        'peer-key-missing',
        `${this.pluginName()}: no cached public key for ${peer} — probe first`,
      )
    }
    if (getKeyChangeAlert(peer)) {
      throw new E2EEPluginError(
        'permanent',
        'pin-mismatch',
        `${this.pluginName()}: ${peer}'s primary fingerprint has changed and the rotation hasn't been confirmed`,
      )
    }

    const payloadXml = new TextDecoder().decode(plaintext)
    const envelope = wrapForSigncrypt({
      payloadXml,
      peerJid: getBareJid(peer),
      timestamp: new Date(this.now()),
    })
    const ciphertext = await this.encryptToRecipient(
      ctx.account.jid,
      peerBundle.publicArmored,
      envelope,
    )

    const stanzaElement: XMLElementData = {
      name: 'openpgp',
      attrs: { xmlns: OX_NAMESPACE },
      children: [base64EncodeOpenPgpBlock(ciphertext)],
    }
    return {
      protocolId: OPENPGP_DESCRIPTOR.id,
      stanzaElement,
      fallbackBody: '[OpenPGP-encrypted message]',
    }
  }

  async decrypt(
    handle: ConversationHandle,
    payload: EncryptedPayload,
    context?: InboundDecryptContext,
  ): Promise<DecryptResult> {
    const ctx = this.requireCtx()
    if (payload.protocolId !== OPENPGP_DESCRIPTOR.id) {
      throw new Error(`${this.pluginName()} cannot decrypt protocol: ${payload.protocolId}`)
    }
    const encodedCiphertext = firstText(payload.stanzaElement)
    if (!encodedCiphertext) {
      throw new Error(`${this.pluginName()}: encrypted element has no payload`)
    }
    const ciphertext = base64DecodeOpenPgpBlock(encodedCiphertext, 'PGP MESSAGE')

    const peer = extractPeer(handle)
    const ownBareJid = getBareJid(ctx.account.jid)
    const isSelfOutgoing = context?.isSelfOutgoing === true

    // The signer is whoever produced this ciphertext: for a received
    // message it's the conversation peer; for a self-outgoing replay
    // (XEP-0280 sent carbon or XEP-0313 MAM self-entry) it was us.
    // Pick the public key that should be able to verify the signature.
    const senderPublicArmored = isSelfOutgoing
      ? this.ownBundle?.publicArmored ?? null
      : this.peerKeys.get(peer)?.publicArmored ?? null

    const output = await this.decryptWithOwnKey(ctx.account.jid, ciphertext, senderPublicArmored)

    const envelope = this.unwrapOrRethrow(output.plaintext)
    // XEP-0373 §3.1 reflection defence. Received messages: the envelope
    // `<to/>` MUST name us — otherwise an attacker has reflected someone
    // else's ciphertext back at us. Self-outgoing carbons / MAM-replays:
    // we sent the message TO the conversation peer, so `<to/>` names the
    // peer; checking for our own JID would always fail. Invert the check
    // — addressees must contain the peer we opened the conversation with.
    const expectedAddressee = isSelfOutgoing ? peer : ownBareJid
    if (!envelope.addressees.some((addr: string) => getBareJid(addr) === expectedAddressee)) {
      throw new E2EEPluginError(
        'permanent',
        'envelope-reflection',
        isSelfOutgoing
          ? `${this.pluginName()}: self-outgoing signcrypt <to/> does not address conversation peer ${peer}`
          : `${this.pluginName()}: signcrypt <to/> does not address ${ownBareJid}`,
      )
    }
    // Timestamp skew check — three modes:
    //
    // 1. Live messages: validate <time/> against now() ± 7 days.
    // 2. MAM archive (fromArchive + archiveTimestamp): validate <time/>
    //    against the <delay/> stamp ± 7 days. The message is old but
    //    the envelope timestamp should be consistent with when the
    //    server recorded it.
    // 3. Retry (fromRetry): skip — the timestamp was already validated
    //    on original live delivery; only the signature is pending.
    if (context?.fromRetry) {
      // Already validated on first delivery — skip.
    } else if (context?.fromArchive && context.archiveTimestamp) {
      const skew = Math.abs(envelope.timestamp.getTime() - context.archiveTimestamp.getTime())
      if (skew > SIGNCRYPT_CLOCK_SKEW_MS) {
        throw new E2EEPluginError(
          'permanent',
          'envelope-stale',
          `${this.pluginName()}: signcrypt <time/> is ${Math.round(skew / 1000)}s off the archive <delay/> (±7-day tolerance)`,
        )
      }
    } else if (!context?.fromArchive) {
      const skew = Math.abs(envelope.timestamp.getTime() - this.now())
      if (skew > SIGNCRYPT_CLOCK_SKEW_MS) {
        throw new E2EEPluginError(
          'permanent',
          'envelope-stale',
          `${this.pluginName()}: signcrypt <time/> is ${Math.round(skew / 1000)}s outside the ±7-day skew window`,
        )
      }
    }

    // XEP-0373 signcrypt mandate: signing AND encryption are required.
    // Case B: no signature at all — malformed signcrypt.
    if (!output.signaturePresent) {
      throw new E2EEPluginError(
        'permanent',
        'signature-missing',
        `${this.pluginName()}: signcrypt message contains no signature`,
      )
    }
    // Case A: sender key available but signature did not verify.
    if (senderPublicArmored && !output.signatureVerified) {
      throw new E2EEPluginError(
        'permanent',
        'signature-failed',
        `${this.pluginName()}: signcrypt signature did not verify against available sender key`,
      )
    }
    // Case C (signaturePresent + !senderPublicArmored + !signatureVerified)
    // falls through — the deferred-verification stash below handles it.

    const plaintextBytes = new TextEncoder().encode(envelope.payloadXml)
    const securityContext = isSelfOutgoing
      ? this.buildSelfOutgoingSecurityContext(output)
      : this.buildInboundSecurityContext(peer, output)

    // Deferred signature re-verification: only meaningful for received
    // messages where the sender's key may arrive after the message did.
    // For self-outgoing, our own key is by definition already cached on
    // this device — if the signature didn't verify here, it never will.
    if (
      !isSelfOutgoing &&
      context?.messageId &&
      !output.signatureVerified &&
      output.signaturePresent &&
      !senderPublicArmored
    ) {
      this.stashPendingVerification(peer, {
        messageId: context.messageId,
        ciphertext,
        plaintext: output.plaintext,
        expiresAt: this.now() + SIGNATURE_BUFFER_TTL_MS,
      })
    }

    // For self-outgoing replays, the originating device is one of our own
    // resources. The carbon doesn't reveal which one to the plugin layer,
    // so attribute the message to our bare JID; the signer fingerprint
    // (when present) still identifies the actual signing key.
    const senderJid = isSelfOutgoing ? ownBareJid : peer
    const fallbackFingerprint = isSelfOutgoing
      ? this.ownBundle?.fingerprint
      : this.peerKeys.get(peer)?.fingerprint
    return {
      plaintext: plaintextBytes,
      senderDevice: {
        jid: senderJid,
        deviceId: output.signerFingerprint ?? fallbackFingerprint ?? 'unknown',
      },
      securityContext,
      authoredAt: envelope.timestamp,
    }
  }

  tryClaimInbound(stanzaChild: XMLElementData): EncryptedPayload | null {
    if (stanzaChild.name !== 'openpgp') return null
    if (stanzaChild.attrs?.xmlns !== OX_NAMESPACE) return null
    return {
      protocolId: OPENPGP_DESCRIPTOR.id,
      stanzaElement: stanzaChild,
    }
  }

  onPeerKeysChanged(peer: BareJID): void {
    if (!this.pendingVerifications.get(peer)?.length) {
      void this.refetchAndCachePeerKey(peer).catch(() => {})
      return
    }
    void (async () => {
      try {
        await this.refetchAndCachePeerKey(peer)
      } catch (err) {
        this.ctx?.logger.debug(
          `${this.pluginName()}: refetchAndCache after key rotation failed for ${peer}: ${formatError(err)}`,
        )
      }
      await this.drainPendingVerifications(peer)
    })()
  }

  // ---------------------------------------------------------------------------
  // Trust evaluation
  // ---------------------------------------------------------------------------

  getVerificationMethods(): VerificationMethod[] {
    return [
      {
        id: 'fingerprint',
        displayName: 'Fingerprint comparison',
        description: "Compare the hex fingerprint with your contact's other client.",
      },
    ]
  }

  async startVerification(_peer: BareJID, _method: VerificationMethod): Promise<VerificationFlow> {
    throw new Error(`${this.pluginName()}: verification UI not wired yet`)
  }

  async getPeerTrust(peer: BareJID): Promise<TrustState> {
    return this.evaluatePeerTrust(peer)
  }

  async getDeviceTrust(peer: BareJID, _deviceId: string): Promise<TrustState> {
    return this.evaluatePeerTrust(peer)
  }

  private async evaluatePeerTrust(peer: BareJID): Promise<TrustState> {
    const cached = this.peerKeys.get(peer)
    if (!cached) return 'unknown'
    return isPeerVerified(peer, cached.fingerprint) ? 'verified' : 'tofu'
  }

  // ---------------------------------------------------------------------------
  // Accessors (called by UI layer)
  // ---------------------------------------------------------------------------

  getOwnFingerprint(): string | null {
    return this.ownBundle?.fingerprint ?? null
  }

  getBackedUpFingerprint(): string | null {
    const jid = this.ctx?.account.jid
    if (!jid) return null
    return readBackedUpFingerprint(jid)
  }

  getPeerFingerprint(peer: BareJID): string | null {
    return this.peerKeys.get(peer)?.fingerprint ?? null
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private stashPendingVerification(peer: BareJID, entry: PendingVerification): void {
    const existing = this.pendingVerifications.get(peer) ?? []
    const now = this.now()
    const alive = existing.filter((e) => e.expiresAt > now && e.messageId !== entry.messageId)
    alive.push(entry)
    while (alive.length > SIGNATURE_BUFFER_SIZE) {
      alive.shift()
    }
    this.pendingVerifications.set(peer, alive)
  }

  private async drainPendingVerifications(peer: BareJID): Promise<void> {
    const ctx = this.ctx
    const entries = this.pendingVerifications.get(peer)
    if (!ctx || !entries || entries.length === 0) return

    const peerBundle = this.peerKeys.get(peer)
    if (!peerBundle) {
      const now = this.now()
      const alive = entries.filter((e) => e.expiresAt > now)
      if (alive.length === 0) this.pendingVerifications.delete(peer)
      else this.pendingVerifications.set(peer, alive)
      return
    }

    const now = this.now()
    const remaining: PendingVerification[] = []
    for (const entry of entries) {
      if (entry.expiresAt <= now) continue
      try {
        const output = await this.decryptWithOwnKey(
          ctx.account.jid,
          entry.ciphertext,
          peerBundle.publicArmored,
        )
        if (output.plaintext !== entry.plaintext) continue
        if (output.signatureVerified) {
          const securityContext = this.buildInboundSecurityContext(peer, output)
          ctx.reportSecurityContextUpdate({
            peer,
            messageId: entry.messageId,
            securityContext,
          })
          continue
        }
        // Case D: key now available but signature still invalid — reject
        // and expunge the plaintext body that was delivered optimistically.
        ctx.reportSecurityContextUpdate({
          peer,
          messageId: entry.messageId,
          securityContext: {
            protocolId: OPENPGP_DESCRIPTOR.id,
            trust: 'rejected',
            notes: ['Signature did not verify against sender key'],
          },
          body: '[Message rejected: invalid signature]',
        })
        continue
      } catch (err) {
        ctx.logger.debug(
          `${this.pluginName()}: re-verify for ${peer}/${entry.messageId} failed: ${formatError(err)}`,
        )
        ctx.reportSecurityContextUpdate({
          peer,
          messageId: entry.messageId,
          securityContext: {
            protocolId: OPENPGP_DESCRIPTOR.id,
            trust: 'rejected',
            notes: ['Re-verification failed'],
          },
          body: '[Message rejected: invalid signature]',
        })
        continue
      }
    }
    if (remaining.length === 0) this.pendingVerifications.delete(peer)
    else this.pendingVerifications.set(peer, remaining)
  }

  private buildInboundSecurityContext(peer: BareJID, output: DecryptOutput): SecurityContext {
    const cached = this.peerKeys.get(peer)
    const fingerprintMatches =
      cached && output.signerFingerprint && fingerprintsEqual(cached.fingerprint, output.signerFingerprint)
    let trust: SecurityContext['trust']
    if (output.signatureVerified && fingerprintMatches) {
      trust = isPeerVerified(peer, cached.fingerprint) ? 'verified' : 'tofu'
    } else {
      trust = 'untrusted'
    }

    const notes: string[] = []
    if (!output.signatureVerified) {
      notes.push(cached ? 'Signature did not verify' : 'Sender key not cached — signature not checked')
    } else if (!fingerprintMatches) {
      notes.push('Signature verified but fingerprint does not match cached peer')
    }

    return {
      protocolId: OPENPGP_DESCRIPTOR.id,
      trust,
      ...(notes.length > 0 && { notes }),
    }
  }

  /**
   * Trust evaluation for a self-outgoing ciphertext (sent carbon or
   * MAM-replayed self-entry). The signer is us — we measure trust against
   * our own published key bundle, not a peer's. A verified signature that
   * matches our own fingerprint earns `verified`; anything else stays
   * `untrusted` (e.g. server-injected payload that won't verify, or a
   * fingerprint mismatch indicating identity rotation we haven't seen).
   */
  private buildSelfOutgoingSecurityContext(output: DecryptOutput): SecurityContext {
    const ownBundle = this.ownBundle
    const fingerprintMatches =
      ownBundle && output.signerFingerprint && fingerprintsEqual(ownBundle.fingerprint, output.signerFingerprint)
    const trust: SecurityContext['trust'] =
      output.signatureVerified && fingerprintMatches ? 'verified' : 'untrusted'

    const notes: string[] = []
    if (!output.signatureVerified) {
      notes.push(ownBundle ? 'Own signature did not verify' : 'Own key not loaded — signature not checked')
    } else if (!fingerprintMatches) {
      notes.push('Signature verified but signer fingerprint does not match own key')
    }

    return {
      protocolId: OPENPGP_DESCRIPTOR.id,
      trust,
      ...(notes.length > 0 && { notes }),
    }
  }

  private unwrapOrRethrow(plaintext: string) {
    try {
      return unwrapSigncrypt(plaintext)
    } catch (err) {
      if (err instanceof SigncryptEnvelopeError) {
        throw new E2EEPluginError(
          'permanent',
          `envelope-${err.code}`,
          `${this.pluginName()}: signcrypt envelope rejected: ${err.message}`,
          err,
        )
      }
      throw err
    }
  }

  protected toPluginError(op: string, err: unknown): E2EEPluginError {
    if (err instanceof E2EEPluginError) return err
    const { kind, code } = classifyBoundaryError(err)
    const detail = err instanceof Error ? err.message : String(err)
    return new E2EEPluginError(kind, code, `${this.pluginName()}: ${op}: ${detail}`, err)
  }

  protected pluginName(): string {
    return 'OpenPGPPluginBase'
  }

  protected requireCtx(): PluginContext {
    if (!this.ctx) throw new Error(`${this.pluginName()}: not initialized`)
    return this.ctx
  }

  /** Override the clock for TTL tests. @internal */
  _setClockForTesting(fn: () => number): void {
    this.now = fn
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

function extractPeer(handle: ConversationHandle): BareJID {
  const state = handle.state as { peer?: BareJID } | undefined
  const peer = state?.peer
  if (!peer) throw new Error('OpenPGPPluginBase: conversation handle is missing peer JID')
  return peer
}

function isPreconditionNotMet(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as {
    condition?: string
    application?: { name?: string } | null
    element?: {
      getChild?: (name: string, xmlns?: string) => unknown
    } | null
  }
  if (e.condition === 'precondition-not-met') return true
  if (e.application?.name === 'precondition-not-met') return true
  const errorEl = e.element
  if (errorEl?.getChild) {
    const hit = errorEl.getChild(
      'precondition-not-met',
      'http://jabber.org/protocol/pubsub#errors',
    )
    if (hit) return true
  }
  return false
}

function parseAdvertisedFingerprints(items: PEPItem[]): string[] {
  const fingerprints: string[] = []
  for (const item of items) {
    const list = item.payload
    if (list.name !== 'public-keys-list' || list.attrs?.xmlns !== OX_NAMESPACE) continue
    for (const child of list.children) {
      if (typeof child === 'string') continue
      if (child.name !== 'pubkey-metadata') continue
      const fp = firstAttr(child.attrs, ['v6-fingerprint', 'v4-fingerprint'])
      if (fp) fingerprints.push(fp)
    }
  }
  return fingerprints
}

function parsePublicKeyDataItem(payload: XMLElementData): string | null {
  if (payload.name !== 'pubkey' || payload.attrs?.xmlns !== OX_NAMESPACE) return null
  for (const child of payload.children) {
    if (typeof child === 'string') continue
    if (child.name !== 'data') continue
    const encoded = firstText(child)
    if (encoded) return base64DecodeOpenPgpBlock(encoded, 'PGP PUBLIC KEY BLOCK')
  }
  return null
}

function parseSecretKeyBackupItem(payload: XMLElementData): string | null {
  if (payload.name !== 'secretkey' || payload.attrs?.xmlns !== OX_NAMESPACE) return null
  const encoded = firstText(payload)
  return encoded ? base64DecodeOpenPgpBlock(encoded, 'PGP MESSAGE') : null
}

function fingerprintsEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function firstAttr(
  attrs: Record<string, unknown> | undefined,
  names: readonly string[],
): string | null {
  if (!attrs) return null
  for (const name of names) {
    const v = attrs[name]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return null
}

function firstText(el: XMLElementData): string | null {
  const child = el.children[0]
  return typeof child === 'string' ? child : null
}

/**
 * XEP-0373 carries raw OpenPGP packet bytes in XML as Base64, not ASCII armor.
 * Our crypto backends still exchange armored strings internally, so this is
 * the boundary adapter in both directions.
 */
function base64EncodeOpenPgpBlock(armored: string): string {
  const raw = dearmorOpenPgpBlock(armored)
  if (!raw) throw new Error('Expected an ASCII-armored OpenPGP block')
  return bytesToBase64(raw)
}

function base64DecodeOpenPgpBlock(encoded: string, blockType: string): string {
  const raw = base64ToBytes(encoded)
  return armorOpenPgpBlock(raw, blockType)
}

function openPgpBlocksEqual(a: string, b: string): boolean {
  const aRaw = dearmorOpenPgpBlock(a)
  const bRaw = dearmorOpenPgpBlock(b)
  if (aRaw && bRaw) return bytesEqual(aRaw, bRaw)
  return a.trim() === b.trim()
}

function dearmorOpenPgpBlock(armored: string): Uint8Array | null {
  const normalized = armored.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  const beginIndex = lines.findIndex((line) => /^-----BEGIN PGP [^-]+-----$/.test(line.trim()))
  if (beginIndex < 0) return null
  const endIndex = lines.findIndex(
    (line, index) => index > beginIndex && /^-----END PGP [^-]+-----$/.test(line.trim()),
  )
  if (endIndex < 0) return null

  const body: string[] = []
  let afterHeaders = false
  for (let i = beginIndex + 1; i < endIndex; i++) {
    const line = lines[i].trim()
    if (!afterHeaders) {
      if (line === '') afterHeaders = true
      continue
    }
    if (line === '') continue
    if (line.startsWith('=')) break
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(line)) return null
    body.push(line)
  }
  if (body.length === 0) return null
  return base64ToBytes(body.join(''))
}

function armorOpenPgpBlock(raw: Uint8Array, blockType: string): string {
  const body = wrapBase64(bytesToBase64(raw))
  return `-----BEGIN ${blockType}-----\n\n${body}\n=${crc24Base64(raw)}\n-----END ${blockType}-----`
}

function base64ToBytes(encoded: string): Uint8Array {
  const clean = encoded.replace(/\s+/g, '')
  if (clean.length === 0 || clean.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) {
    throw new Error('invalid base64 OpenPGP payload')
  }
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'))
  const binary = atob(clean)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64')
  return btoa(bytesToBinaryString(bytes))
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function bytesToBinaryString(bytes: Uint8Array): string {
  const chunks: string[] = []
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)))
  }
  return chunks.join('')
}

function wrapBase64(input: string): string {
  const lines: string[] = []
  for (let i = 0; i < input.length; i += 64) lines.push(input.slice(i, i + 64))
  return lines.join('\n')
}

function crc24Base64(bytes: Uint8Array): string {
  const crc = crc24(bytes)
  return bytesToBase64(
    new Uint8Array([(crc >> 16) & 0xff, (crc >> 8) & 0xff, crc & 0xff]),
  )
}

function crc24(bytes: Uint8Array): number {
  let crc = 0xb704ce
  for (const byte of bytes) {
    crc ^= byte << 16
    for (let i = 0; i < 8; i++) {
      crc <<= 1
      if ((crc & 0x1000000) !== 0) crc ^= 0x1864cfb
    }
  }
  return crc & 0xffffff
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
