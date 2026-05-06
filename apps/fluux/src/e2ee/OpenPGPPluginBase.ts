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
import {
  clearBackedUpFingerprint,
  readBackedUpFingerprint,
  writeBackedUpFingerprint,
} from './backupMarker'
import {
  clearPeerVerified,
  isPeerVerified,
  setPeerVerified,
  useVerifiedPeerKeysStore,
} from '@/stores/verifiedPeerKeysStore'
import {
  VERIFICATIONS_NODE,
  fetchVerificationsFromServer,
  mergeVerifications,
  publishVerificationsToServer,
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
}

/** Decryption result returned by the crypto backend. */
export interface DecryptOutput {
  plaintext: string
  signatureVerified: boolean
  signerFingerprint: string | null
  signaturePresent: boolean
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
  private _syncingFromRemoteCount = 0
  private _publishVerificationTimeout: ReturnType<typeof setTimeout> | null = null

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
  ): Promise<{ fingerprint: string; encryptionSubkeyCount: number }>

  /**
   * Rotate the encryption subkey while keeping the primary key (and
   * therefore the fingerprint peers have pinned) stable. Returns the
   * updated bundle with the same primary fingerprint.
   */
  protected abstract rotateKeyMaterial(accountJid: string): Promise<KeyBundle>

  /**
   * Encrypt the TSK (transfer secret key) under `passphrase` and return
   * an armored OpenPGP message suitable for the XEP-0373 §5 backup node.
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
  }

  async shutdown(): Promise<void> {
    if (this._publishVerificationTimeout !== null) {
      clearTimeout(this._publishVerificationTimeout)
      this._publishVerificationTimeout = null
    }
    this._verificationStoreUnsub?.()
    this._verificationStoreUnsub = null
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
      children: [
        {
          name: 'data',
          attrs: {},
          children: [base64Encode(armoredMessage)],
        },
      ],
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
      const items = await ctx.xmpp.queryPEP(ctx.account.jid, SECRET_KEY_NODE)
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

  async restoreSecretKey(passphrase: string): Promise<IdentityInfo> {
    const ctx = this.requireCtx()
    const armoredMessage = await this.fetchSecretKeyBackup()
    if (!armoredMessage) {
      throw new E2EEPluginError(
        'permanent',
        'no-backup',
        `${this.pluginName()}: no secret-key backup found on server`,
      )
    }
    const previousFingerprint = this.ownBundle?.fingerprint
    let bundle: KeyBundle
    try {
      bundle = await this.backupImport(ctx.account.jid, armoredMessage, passphrase)
    } catch (err) {
      throw this.toPluginError('restoreSecretKey', err)
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
        `${this.pluginName()}: public key publish after restore failed: ${formatError(err)}`,
      )
    }

    return { fingerprint: bundle.fingerprint }
  }

  async importKeyFromFile(armoredMessage: string, passphrase: string): Promise<IdentityInfo> {
    const ctx = this.requireCtx()
    const previousFingerprint = this.ownBundle?.fingerprint
    let bundle: KeyBundle
    try {
      bundle = await this.backupImport(ctx.account.jid, armoredMessage, passphrase)
    } catch (err) {
      throw this.toPluginError('importKeyFromFile', err)
    }
    this.ownBundle = bundle
    try {
      await this.publishOwnPublicKeyData(bundle)
      await this.publishOwnPublicKeyMetadata(bundle)
      if (previousFingerprint) {
        await this.retractStalePublicKeyDataNode(previousFingerprint, bundle.fingerprint)
      }
    } catch (err) {
      ctx.logger.warn(
        `${this.pluginName()}: public key publish after file import failed: ${formatError(err)}`,
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
    const info = await this.restoreSecretKey(passphrase)
    clearOwnKeyConflict()
    return info
  }

  // ---------------------------------------------------------------------------
  // Cross-device verification sync
  // ---------------------------------------------------------------------------

  private async syncVerificationsFromServer(): Promise<void> {
    if (!this.ownBundle || !this.ctx) return
    this._syncingFromRemoteCount++
    const ctx = this.ctx
    const ownPublicArmored = this.ownBundle.publicArmored
    try {
      const remote = await fetchVerificationsFromServer(
        ctx,
        (ciphertext, senderKey) =>
          this.decryptWithOwnKey(ctx.account.jid, ciphertext, senderKey),
        ctx.account.jid,
        ownPublicArmored,
      )
      if (!remote) return
      const local = useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid
      const { hasNewEntries, merged } = mergeVerifications(remote, local)
      if (!hasNewEntries) return
      for (const [jid, fp] of Object.entries(merged)) {
        if (!local[jid]) setPeerVerified(jid, fp)
      }
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
      void publishVerificationsToServer(
        ctx,
        (plaintext, recipientKey) =>
          this.encryptToRecipient(ctx.account.jid, recipientKey, plaintext),
        ownPublicArmored,
        verifications,
      ).catch(() => {})
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
      metadataItems = await ctx.xmpp.queryPEP(ctx.account.jid, PUBLIC_KEYS_METADATA_NODE)
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
    if (publishedArmored !== null && publishedArmored.trim() !== bundle.publicArmored.trim()) {
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
          children: [base64Encode(bundle.publicArmored)],
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
    if (this.peerKeys.has(peer)) {
      return { supported: true, ttl: PROBE_NEGATIVE_TTL_SECONDS }
    }
    return this.refetchAndCachePeerKey(peer)
  }

  private async refetchAndCachePeerKey(peer: BareJID): Promise<PeerSupport> {
    const ctx = this.requireCtx()
    try {
      const metadataItems = await ctx.xmpp.queryPEP(peer, PUBLIC_KEYS_METADATA_NODE)
      const fingerprints = parseAdvertisedFingerprints(metadataItems)
      if (fingerprints.length === 0) {
        return { supported: false, ttl: PROBE_NEGATIVE_TTL_SECONDS }
      }

      for (const fingerprint of fingerprints) {
        const bundle = await this.fetchAdvertisedKey(peer, fingerprint)
        if (bundle) {
          this.cachePeerKey(peer, bundle)
          return { supported: true, ttl: PROBE_NEGATIVE_TTL_SECONDS }
        }
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
  ): Promise<KeyBundle | null> {
    const ctx = this.requireCtx()
    try {
      const items = await ctx.xmpp.queryPEP(peer, publicKeyDataNodeFor(fingerprint))
      for (const item of items) {
        const armored = parsePublicKeyDataItem(item.payload)
        if (!armored) continue
        let validation: { fingerprint: string; encryptionSubkeyCount: number }
        try {
          validation = await this.validateCert(armored)
        } catch (err) {
          ctx.logger.warn(
            `${this.pluginName()}: validateCert for ${peer}/${fingerprint} failed: ${formatError(err)}`,
          )
          continue
        }
        if (!fingerprintsEqual(validation.fingerprint, fingerprint)) {
          ctx.logger.warn(
            `${this.pluginName()}: ${peer} advertised ${fingerprint} but served key with ${validation.fingerprint}; discarding`,
          )
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
      throw new Error(`${this.pluginName()}: no cached public key for ${peer} — probe first`)
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
      children: [base64Encode(ciphertext)],
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
    const ciphertext = base64Decode(encodedCiphertext)

    const peer = extractPeer(handle)
    const senderPublicArmored = this.peerKeys.get(peer)?.publicArmored ?? null

    const output = await this.decryptWithOwnKey(ctx.account.jid, ciphertext, senderPublicArmored)

    const envelope = this.unwrapOrRethrow(output.plaintext)
    const ownBareJid = getBareJid(ctx.account.jid)
    if (!envelope.addressees.some((addr: string) => getBareJid(addr) === ownBareJid)) {
      throw new E2EEPluginError(
        'permanent',
        'envelope-reflection',
        `${this.pluginName()}: signcrypt <to/> does not address ${ownBareJid}`,
      )
    }
    const skew = Math.abs(envelope.timestamp.getTime() - this.now())
    if (skew > SIGNCRYPT_CLOCK_SKEW_MS) {
      throw new E2EEPluginError(
        'permanent',
        'envelope-stale',
        `${this.pluginName()}: signcrypt <time/> is ${Math.round(skew / 1000)}s outside the ±7-day skew window`,
      )
    }

    const plaintextBytes = new TextEncoder().encode(envelope.payloadXml)
    const securityContext = this.buildInboundSecurityContext(peer, output)

    if (
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

    return {
      plaintext: plaintextBytes,
      senderDevice: {
        jid: peer,
        deviceId: output.signerFingerprint ?? this.peerKeys.get(peer)?.fingerprint ?? 'unknown',
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
        remaining.push(entry)
      } catch (err) {
        ctx.logger.debug(
          `${this.pluginName()}: re-verify for ${peer}/${entry.messageId} failed: ${formatError(err)}`,
        )
        remaining.push(entry)
      }
    }
    if (remaining.length === 0) this.pendingVerifications.delete(peer)
    else this.pendingVerifications.set(peer, remaining)
  }

  private buildInboundSecurityContext(peer: BareJID, output: DecryptOutput): SecurityContext {
    const cached = this.peerKeys.get(peer)
    const fingerprintMatches =
      cached && output.signerFingerprint && cached.fingerprint === output.signerFingerprint
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
    if (encoded) return base64Decode(encoded)
  }
  return null
}

function parseSecretKeyBackupItem(payload: XMLElementData): string | null {
  if (payload.name !== 'secretkey' || payload.attrs?.xmlns !== OX_NAMESPACE) return null
  for (const child of payload.children) {
    if (typeof child === 'string') continue
    if (child.name !== 'data') continue
    const encoded = firstText(child)
    if (encoded) return base64Decode(encoded)
  }
  return null
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

function base64Encode(input: string): string {
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(input)))
  return Buffer.from(input, 'utf-8').toString('base64')
}

function base64Decode(encoded: string): string {
  if (typeof atob === 'function') return decodeURIComponent(escape(atob(encoded)))
  return Buffer.from(encoded, 'base64').toString('utf-8')
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
