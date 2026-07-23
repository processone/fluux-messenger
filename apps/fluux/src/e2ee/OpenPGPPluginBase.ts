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
import { discoSupportsPep, getBareJid } from '@fluux/sdk'
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
  fingerprintsEqual,
  normalizeFingerprint,
  toXep0373Fingerprint,
} from './fingerprintCompare'
import {
  deserializePeerCache,
  serializePeerCache,
  activePublics,
  activeFingerprints,
  eligibleVerifierPublics,
  upsertActive,
  markDepartedInactive,
  capUnverifiedInactive,
  type CachedPeerCert,
} from './peerCertCache'
import { accountUserId } from './openpgpUserId'
import { mergePublicKeysList, OX_NAMESPACE as OX_WIRE_NAMESPACE } from './oxPublicKeysList'
import { legacyNormalizeBackupPassphrase, prepareBackupPassphrase } from './backupPassphrase'
import {
  clearKeyChangeAlert,
  getKeyChangeAlert,
} from '@/stores/keyChangeAlertsStore'
import {
  clearOwnKeyConflict,
  getOwnKeyConflict,
  recordOwnKeyConflict,
} from '@/stores/ownKeyConflictStore'
import {
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
  clearCompromisedAndReseal,
} from './trustStateIntegrity'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { setTrustStateStatus } from '@/stores/trustStateStatusStore'
import { withPassphraseFormatHeader } from './passphraseFormatHeader'
import { isSecretKeyUnavailableError } from './keyUnavailable'

// ---------------------------------------------------------------------------
// XEP-0373 constants
// ---------------------------------------------------------------------------

// Single source: `oxPublicKeysList` owns the OX wire format constants.
const OX_NAMESPACE = OX_WIRE_NAMESPACE
const PUBSUB_PUBLISH_OPTIONS_FEATURE = 'http://jabber.org/protocol/pubsub#publish-options'
const PUBLIC_KEYS_METADATA_NODE = 'urn:xmpp:openpgp:0:public-keys'
const SECRET_KEY_NODE = 'urn:xmpp:openpgp:0:secret-key'
const CURRENT_ITEM_ID = 'current'

// Builds a public-key data node id for the fingerprint exactly as given. The
// PEP node id is case-sensitive, so callers must pass the fingerprint in the
// case it was advertised: for OUR OWN key, the XEP-0373 §4.1 upper-case wire
// form (via `toXep0373Fingerprint`); for a PEER's key, the verbatim string the
// peer published in its `v4`/`v6-fingerprint` metadata.
function publicKeyDataNodeFor(fingerprint: string): string {
  return `${PUBLIC_KEYS_METADATA_NODE}:${fingerprint}`
}

// ---------------------------------------------------------------------------
// Peer key localStorage cache
// ---------------------------------------------------------------------------

const PEER_KEY_CACHE_PREFIX = 'fluux:e2ee:peer-keys:'

function peerKeyCacheKey(accountJid: string): string {
  return `${PEER_KEY_CACHE_PREFIX}${accountJid}`
}

function loadPeerKeyCache(accountJid: string): Map<BareJID, CachedPeerCert[]> {
  try {
    const raw = localStorage.getItem(peerKeyCacheKey(accountJid))
    if (!raw) return new Map<BareJID, CachedPeerCert[]>()
    // deserializePeerCache treats localStorage as untrusted (fingerprint
    // canonicalization, fail-closed on tampered records) AND migrates the
    // pre-Stage-1 `[jid, KeyBundle]` shape to a one-element active set.
    return deserializePeerCache(raw)
  } catch {
    return new Map<BareJID, CachedPeerCert[]>()
  }
}

function savePeerKeyCache(accountJid: string, map: Map<BareJID, CachedPeerCert[]>): void {
  try {
    localStorage.setItem(peerKeyCacheKey(accountJid), serializePeerCache(map))
  } catch { /* storage full or unavailable */ }
}

function clearPeerKeyCache(accountJid: string): void {
  try { localStorage.removeItem(peerKeyCacheKey(accountJid)) } catch { /* */ }
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
  /**
   * Machine-readable outcome of signature verification, mirroring the Rust
   * `DecryptOutput::signature_status` (serde → `signatureStatus`):
   *
   * - `'none'`     — the message carried no signature at all.
   * - `'verified'` — a signature verified against one of the supplied sender
   *   keys; {@link signerFingerprint} names its primary certificate.
   * - `'bad'`      — a supplied sender key matched the signature's issuer but
   *   the signature itself did not verify (tamper / genuine failure).
   * - `'missing-key'` — the message was signed, but none of the supplied
   *   sender keys is the issuer, so verification could not be attempted. The
   *   caller may refetch the sender's announced keyset and retry.
   *
   * `signatureVerified === (signatureStatus === 'verified')` and
   * `signaturePresent === (signatureStatus !== 'none')`; the discrete field
   * lets callers distinguish a genuinely bad signature from a merely
   * unavailable signing key without re-deriving it from the booleans.
   */
  signatureStatus: 'none' | 'verified' | 'bad' | 'missing-key'
  /**
   * Set when signature verification failed specifically because the
   * signature's creation time is ahead of the verifier's clock (beyond the
   * skew tolerance) — i.e. a *transient* clock-skew failure that may verify
   * once clocks converge, NOT a genuine bad signature. Lets the decrypt path
   * mark the message retryable rather than permanently rejected.
   */
  signatureNotYetValid?: boolean
}

export interface CertValidation {
  fingerprint: string
  encryptionSubkeyCount: number
  /**
   * `true` iff {@link encryptionSubkeyCount} > 0. Mirrors the Rust
   * `CertValidation::has_encryption_subkey` (serde → `hasEncryptionSubkey`).
   * A parsed cert with `false` is a *definitively invalid* recipient (no usable
   * encryption subkey), which the peer-cache classifier treats as excluded —
   * distinct from a transient fetch failure.
   */
  hasEncryptionSubkey: boolean
  userIds: string[]
  /**
   * Upper-case hex fingerprints of every subkey in the certificate,
   * independent of usage flags or expiry. These identify the key material
   * itself: stripping an expiration or re-signing a self-signature leaves
   * them unchanged, while a genuine key rotation adds a new one. Used to
   * tell "same key, different bytes" apart from "a different key was
   * published" without a brittle raw-byte comparison.
   */
  subkeyFingerprints: string[]
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

// Per-peer LRU cap on UNVERIFIED inactive (retired) certs — a hostile peer can
// rotate keys indefinitely, so retained-but-unverified certs are bounded.
// Verified inactive certs are kept indefinitely (few, meaningful).
const UNVERIFIED_INACTIVE_CAP = 5

// Clock tolerance when deciding whether an archived/deferred message predates a
// cert's retirement (`inactiveAt`) — so a retired key can still verify eligible
// archived traffic but never a fresh live message (see spec §Retained certs).
const INACTIVE_ARCHIVE_TOLERANCE_MS = 5 * 60 * 1000

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
  // The stored passphrase no longer decrypts the on-disk TSK (keychain/key
  // desync, or a corrupted secret-key packet). Sequoia surfaces this as
  // "decrypt persisted TSK ..." / "decrypt primary secret key" and, for a
  // wrong passphrase against a v4/CFB secret, "unexpected EOF". It is a
  // permanent condition the user can only resolve by restoring or replacing
  // the key — never a retryable transient — so the host can route to recovery
  // instead of showing an opaque `(unknown)`.
  if (
    msg.includes('decrypt persisted tsk') ||
    msg.includes('decrypt primary secret key') ||
    msg.includes('decrypt secret subkey') ||
    msg.includes('unexpected eof')
  ) {
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
  if (
    msg.includes('parse ') ||
    msg.includes('not valid') ||
    // openpgp.js readMessage/readKey on bytes that are not valid OpenPGP:
    // "Error during parsing. This message / key probably does not conform to
    // a valid OpenPGP format." Structurally malformed → never decrypts.
    msg.includes('during parsing') ||
    msg.includes('conform to a valid openpgp') ||
    // Sequoia stream decryptor fed bytes that are not parseable OpenPGP at
    // all: "Malformed packet: Malformed CTB: MSB of ptag … not set (ptag is
    // a dash, perhaps this is an ASCII-armor encoded message)". Like the
    // openpgp.js cases above, no key change can ever open structurally
    // invalid bytes, so this is terminal — without it the failure falls
    // through to `transient/unknown` and stanzaDecrypt re-stashes the
    // message, making retryPendingDecrypts re-attempt (and re-log) it on
    // every launch forever.
    msg.includes('malformed packet')
  ) {
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

/**
 * Three-state result of probing the server for a secret-key backup.
 * `unknown` means the probe could not reach a definitive answer — see
 * {@link OpenPGPPluginBase.probeSecretKeyBackup}.
 */
export type BackupProbeResult = 'present' | 'absent' | 'unknown'

// ---------------------------------------------------------------------------
// Abstract base class
// ---------------------------------------------------------------------------

export abstract class OpenPGPPluginBase implements E2EEPlugin {
  readonly descriptor = OPENPGP_DESCRIPTOR

  protected ctx: PluginContext | null = null
  protected ownBundle: KeyBundle | null = null

  // A peer JID owns a SET of announced OX certs (XEP-0373 / #1059), partitioned
  // by an `active` flag inside each CachedPeerCert (active = still announced,
  // an encryption recipient; inactive = retired, verification-only).
  private readonly peerKeys = new Map<BareJID, CachedPeerCert[]>()
  private readonly pendingVerifications = new Map<BareJID, PendingVerification[]>()

  // ---- Session-scoped keyset-freshness/health state (NOT persisted) ----
  // A persisted `active` flag is only tentative after startup/reconnect, so the
  // first send to a peer this session must trigger a definitive metadata
  // refresh. These four collections drive that and are cleared alongside
  // `peerKeys` on shutdown/reset.
  //
  // A JID here has had a definitive, complete metadata refresh this session.
  private readonly freshThisSession = new Set<BareJID>()
  // A JID whose last refresh could not resolve every announced key (a transient
  // metadata OR data-node failure with no prior cert). Fail-closed: blocks send.
  private readonly keysetIncomplete = new Set<BareJID>()
  // A JID we have EVER seen support OX (a validated cert now/previously, or a
  // prior successful probe). Lets a transient failure keep `supported:true`.
  private readonly everSupported = new Set<BareJID>()
  // Backoff timestamp (ms, `this.now()` clock): before it, an incomplete keyset
  // stays blocked without re-probing; after it, `ensureFreshKeyset` re-probes so
  // a service that recovers mid-session heals without a restart.
  private readonly keysetRetryAfter = new Map<BareJID, number>()

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

  /**
   * Set by {@link init} when {@link ensureIdentity} fails with a
   * `key-unrecoverable` error — a local key exists but cannot be unlocked
   * (keychain/key desync, a corrupted secret-key packet, or a passphrase
   * that has gone missing). The plugin stays REGISTERED (init swallows the
   * error) so the host can read this flag and route the user to recovery
   * via the IdentityChoiceDialog (restore from server backup / import file /
   * replace identity), instead of dead-ending on an opaque registration
   * failure. Cleared the moment a usable identity is established.
   */
  protected _keyRecoveryNeeded = false

  /**
   * True when a local key exists but could not be unlocked, so the host
   * should route the user through recovery. @see {@link _keyRecoveryNeeded}.
   */
  isKeyRecoveryNeeded(): boolean {
    return this._keyRecoveryNeeded
  }

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
   * Sign and encrypt `plaintext` to EVERY key in `recipientPublics`
   * (XEP-0373 OX may advertise several public keys per JID — #1059),
   * returning armored ciphertext. `accountJid` identifies the signing
   * identity. A malformed recipient key is a hard error — the message must
   * not be sent to a subset of the intended keys.
   */
  protected abstract encryptToRecipients(
    accountJid: string,
    recipientPublics: string[],
    plaintext: string,
  ): Promise<string>

  /**
   * Decrypt `ciphertext` encrypted to our own key. `senderPublics` carries
   * every candidate signer certificate available for signature verification
   * (the sender may advertise several keys); it may be empty when no key is
   * known yet, in which case the signature — if present — is reported as
   * `'missing-key'`.
   */
  protected abstract decryptWithOwnKey(
    accountJid: string,
    ciphertext: string,
    senderPublics: string[],
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
   * Build the armored backup MESSAGE for a file export: the XEP-0373 §5 SKESK
   * wrap plus a `Passphrase-Format` armor header describing the passphrase
   * family. Shared by both platforms' {@link exportKeyToFile}. NOT used for the
   * PEP/server backup, which must stay header-free.
   */
  protected async buildExportArmor(passphrase: string): Promise<string> {
    const ctx = this.requireCtx()
    const armored = await this.backupEncrypt(ctx.account.jid, passphrase)
    return withPassphraseFormatHeader(armored)
  }

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
    // Rehydrate peer key cache so keys are available before MAM arrives. The
    // rehydrated `active` flags are only TENTATIVE — the first send this
    // session forces a definitive metadata refresh (see `ensureFreshKeyset`).
    const cached = loadPeerKeyCache(ctx.account.jid)
    for (const [jid, certs] of cached) {
      this.peerKeys.set(jid, certs)
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
      if (err instanceof E2EEPluginError && err.code === 'key-unrecoverable') {
        // A local key exists but cannot be unlocked (keychain/key desync,
        // corrupted secret packet, or a missing passphrase). Keep the
        // plugin registered and flag the condition so the host can route
        // the user to recovery (restore / import / replace) via the
        // IdentityChoiceDialog, instead of failing registration with an
        // opaque error the UI can only render as "(unknown)".
        this._keyRecoveryNeeded = true
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
        (plaintext, recipientKey) => this.encryptToRecipients(jid, [recipientKey], plaintext),
        ownPublicArmored,
      )
      setTrustStateStatus('sealed')
    } catch {
      // Best-effort — key may be locked between scheduling and execution
    }
  }

  protected async verifyTrustStateOnInit(): Promise<void> {
    const ownPublicArmored = this.ownBundle?.publicArmored
    const ownFingerprint = this.ownBundle?.fingerprint
    if (!ownPublicArmored || !ownFingerprint || !this.ctx) return
    const jid = this.ctx.account.jid
    const { status, details } = await verifyTrustStateSeal(
      (ciphertext, senderPub) => this.decryptWithOwnKey(jid, ciphertext, senderPub ? [senderPub] : []),
      ownPublicArmored,
      ownFingerprint,
      isSecretKeyUnavailableError,
    )
    const reason = details && details.length ? ` (${details.join('; ')})` : ''
    this.ctx.logger.info(`Trust-state verdict: ${status}${reason}`)
    if (status === 'pending-seal') {
      await this.sealTrustStateNow()
      return
    }
    setTrustStateStatus(status, details)
  }

  /**
   * Re-verify the trust-state seal after the secret key becomes usable again
   * (recovery / unlock). `activateSubscriptions()` is idempotent (guarded) and
   * runs the seal check on first activation; the explicit `verifyTrustStateOnInit()`
   * covers the case where subscriptions were already active (so the guard skips
   * the internal check). Resolves a deferred `awaiting-key` verdict to `sealed`
   * for an unchanged cert. Fire-and-forget: the verify catches internally.
   */
  protected reverifyTrustStateAfterKeyChange(): void {
    this.activateSubscriptions()
    void this.verifyTrustStateOnInit()
  }

  async resealTrustState(): Promise<void> {
    const ownPublicArmored = this.ownBundle?.publicArmored
    if (!ownPublicArmored || !this.ctx) return
    const jid = this.ctx.account.jid
    await clearCompromisedAndReseal(
      (plaintext, recipientKey) => this.encryptToRecipients(jid, [recipientKey], plaintext),
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
    this.clearKeysetSessionState()
    this.pendingVerifications.clear()
    this.ctx = null
  }

  /** Drop all session-scoped keyset freshness/health state. */
  private clearKeysetSessionState(): void {
    this.freshThisSession.clear()
    this.keysetIncomplete.clear()
    this.everSupported.clear()
    this.keysetRetryAfter.clear()
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
      clearPeerKeyCache(accountJid)
    }
    this.ownBundle = null
    this.peerKeys.clear()
    this.clearKeysetSessionState()
  }

  // ---------------------------------------------------------------------------
  // Identity & key management
  // ---------------------------------------------------------------------------

  async ensureIdentity(): Promise<IdentityInfo> {
    const ctx = this.requireCtx()

    // Probe PEP BEFORE touching key material: a server without PEP
    // (XEP-0163) can never host the published key, and generating first
    // would leave an orphan private key parked in the OS keychain /
    // IndexedDB (issue #414).
    await this.probePepSupport()

    let bundle: KeyBundle
    try {
      bundle = await this.ensureKeyMaterial(ctx.account.jid)
    } catch (err) {
      throw this.toPluginError('ensureIdentity', err)
    }
    this.ownBundle = bundle
    // A usable identity is established — clear any prior recovery flag so a
    // successful restore/import/replace lifts the host's recovery routing.
    this._keyRecoveryNeeded = false

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

  /**
   * Rotate the encryption subkey, keeping the primary cert (and therefore
   * the fingerprint peers verified) stable.
   *
   * Pass `backupPassphrase` to re-wrap the XEP-0373 §5 secret-key backup
   * with it in the same operation, so the server copy does not stay pinned
   * to the pre-rotation material. That step is NOT best-effort: if it fails
   * this throws an `E2EEPluginError` with code `backup-publish-failed`,
   * after the rotation itself has already committed. Callers must surface
   * that to the user, whose freshly generated passphrase now protects
   * nothing on the server.
   */
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

    // The two publishes above and the one below look alike but are not.
    // `ensureIdentity` re-publishes the public key on every connection, so a
    // failure there self-heals and a warning is the honest response.
    //
    // Nothing ever retries the backup. The caller only supplies a passphrase
    // when re-publishing the backup IS the operation — the user has just been
    // shown that passphrase and told to write it down — and the passphrase
    // stops existing the moment the dialog closes. Reporting success here
    // sends the user away guarding a backup that was never published.
    if (backupPassphrase !== undefined) {
      try {
        await this.backupSecretKey(backupPassphrase)
      } catch (err) {
        ctx.logger.error(
          `${this.pluginName()}: rotated backup publish failed: ${formatError(err)}`,
        )
        // Reuse the boundary classification so a network blip stays
        // transient and the app's retry semantics are unchanged, but pin the
        // code: the rotation above is committed, and the app has to be able
        // to say so instead of reporting a rotation that never happened.
        const classified = this.toPluginError('rotateEncryptionKey', err)
        throw new E2EEPluginError(
          classified.kind,
          'backup-publish-failed',
          `${this.pluginName()}: key rotated, but publishing the new backup failed: ${formatError(err)}`,
          err,
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
      // The retired identity's fingerprints must leave the list — we just
      // retracted their data nodes and forgot their secret material.
      await this.publishOwnPublicKeyMetadata(bundle, publishedFingerprints)
    } catch (err) {
      ctx.logger.warn(
        `${this.pluginName()}: retire publish failed: ${formatError(err)}`,
      )
    }

    clearOwnKeyConflict()

    // The replacement identity is usable now; the retired [E] subkey is kept
    // locally so history stays decryptable. Re-run deferred decrypts so any
    // still-stashed messages are recovered immediately.
    ctx.notifyKeyUnlocked?.()
    this.reverifyTrustStateAfterKeyChange()

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

  /**
   * Query our own XEP-0373 §5 secret-key node.
   *
   * Returns the armored backup when one exists. Returns `null` ONLY when the
   * server has confirmed there is none: an `item-not-found` IQ error, or a
   * node that resolved but carried no `<secretkey>` item.
   *
   * Every other failure THROWS — timeout, transport down, permission, or an
   * item we found but could not decode. Collapsing those to "no backup" is
   * what let callers overwrite a real backup and told restoring users their
   * backup did not exist. Callers that want a non-throwing answer should use
   * {@link probeSecretKeyBackup}.
   */
  async fetchSecretKeyBackup(): Promise<string | null> {
    const ctx = this.requireCtx()
    let items: Awaited<ReturnType<typeof ctx.xmpp.queryPEP>>
    try {
      items = await ctx.xmpp.queryPEP(ctx.account.jid, SECRET_KEY_NODE, 1)
    } catch (err) {
      if (isItemNotFoundError(err)) return null
      throw this.toPluginError('fetchSecretKeyBackup', err)
    }
    for (const item of items) {
      let armored: string | null
      try {
        armored = parseSecretKeyBackupItem(item.payload)
      } catch (err) {
        // We DID find a `<secretkey>` item — there is something on the
        // server, we just cannot decode it. Reporting absence here would
        // let a caller overwrite that something with a fresh key.
        throw this.toPluginError('fetchSecretKeyBackup', err)
      }
      if (armored) return armored
    }
    return null
  }

  /**
   * Non-throwing three-state answer to "is there a backup on the server?".
   *
   * `unknown` is not a failure to be retried silently — it is information the
   * UI must act on. Every consumer treats it as "a backup might exist",
   * because in each case the dangerous action is the one that assumes
   * absence: overwriting the node, rotating without re-publishing, hiding
   * the delete-the-backup option, or offering to generate a fresh key.
   */
  async probeSecretKeyBackup(): Promise<BackupProbeResult> {
    try {
      return (await this.fetchSecretKeyBackup()) === null ? 'absent' : 'present'
    } catch (err) {
      this.ctx?.logger.debug(
        `${this.pluginName()}: secret-key backup probe inconclusive: ${formatError(err)}`,
      )
      return 'unknown'
    }
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

    const { bundles, workingPassphrase, usedLegacyPassphrase } =
      await this.backupImportAllWithLegacyFallback(
        ctx.account.jid,
        armoredMessage,
        passphrase,
        'restoreSecretKey',
      )

    const selection = await this.selectKeyFromBackup(bundles)
    if (!selection) {
      throw new E2EEPluginError(
        'permanent',
        'no-backup',
        `${this.pluginName()}: backup contained no usable keys`,
      )
    }

    if (!selection.needsPicker) {
      const info = await this.doInstallKey(
        armoredMessage,
        workingPassphrase,
        selection.selected.fingerprint,
      )
      if (usedLegacyPassphrase) {
        await this.healLegacyBackupEncoding(passphrase)
      }
      return info
    }

    return {
      needsPicker: true,
      candidates: bundles,
      backupContext: { message: armoredMessage, passphrase: workingPassphrase },
    }
  }

  /**
   * Decrypt-probe a backup with the passphrase exactly as the user
   * entered it, falling back to the pre-0.17.2 normalized form (#1021).
   *
   * Fluux ≤0.17.1 encrypted backups with `legacyNormalizeBackupPassphrase`
   * applied, so the code the user wrote down does not open them verbatim.
   * The fallback keeps those backups restorable; the caller learns which
   * form worked via `usedLegacyPassphrase` so it can heal the server copy.
   * When both forms fail, the ORIGINAL (verbatim-attempt) error surfaces —
   * that is the failure the user can act on.
   */
  private async backupImportAllWithLegacyFallback(
    accountJid: string,
    armoredMessage: string,
    passphrase: string,
    op: string,
  ): Promise<{ bundles: KeyBundle[]; workingPassphrase: string; usedLegacyPassphrase: boolean }> {
    try {
      const bundles = await this.backupImportAll(accountJid, armoredMessage, passphrase)
      return { bundles, workingPassphrase: passphrase, usedLegacyPassphrase: false }
    } catch (originalErr) {
      const legacy = legacyNormalizeBackupPassphrase(passphrase)
      if (legacy === prepareBackupPassphrase(passphrase)) {
        // Normalization wouldn't change the bytes — nothing to retry.
        throw this.toPluginError(op, originalErr)
      }
      try {
        const bundles = await this.backupImportAll(accountJid, armoredMessage, legacy)
        this.requireCtx().logger.info(
          `${this.pluginName()}: backup opened with the legacy-normalized passphrase — pre-0.17.2 encoding detected`,
        )
        return { bundles, workingPassphrase: legacy, usedLegacyPassphrase: true }
      } catch {
        throw this.toPluginError(op, originalErr)
      }
    }
  }

  /**
   * Re-publish the secret-key backup encrypted to the passphrase exactly
   * as the user knows it. Called once, right after a legacy-encoded backup
   * (pre-0.17.2 normalization, #1021) was successfully restored — from then
   * on the displayed code opens the server copy in every XEP-0373 client.
   *
   * Best-effort by design: the restore already succeeded, so a failed
   * re-publish only means the server copy keeps the legacy encoding until
   * the next explicit backup.
   *
   * Note (web): the freshly installed local key is wrapped with the legacy
   * form for this session. The next unlock with the displayed code recovers
   * from the healed backup and re-wraps it verbatim — self-converging.
   */
  private async healLegacyBackupEncoding(passphrase: string): Promise<void> {
    const ctx = this.requireCtx()
    try {
      await this.backupSecretKey(passphrase)
      ctx.logger.info(
        `${this.pluginName()}: re-published the secret-key backup under the verbatim passphrase (#1021 heal)`,
      )
    } catch (err) {
      ctx.logger.warn(
        `${this.pluginName()}: could not re-publish the healed backup: ${formatError(err)}`,
      )
    }
  }

  async importKeyFromFile(armoredMessage: string, passphrase: string): Promise<RestoreResult> {
    const ctx = this.requireCtx()

    // Files exported by Fluux ≤0.17.1 are encrypted with the legacy
    // normalized passphrase (#1021) — same fallback as the server restore.
    // No heal here: there is no server copy to fix, and the file on disk
    // is the user's artifact.
    const { bundles, workingPassphrase } = await this.backupImportAllWithLegacyFallback(
      ctx.account.jid,
      armoredMessage,
      passphrase,
      'importKeyFromFile',
    )

    const selection = await this.selectKeyFromBackup(bundles)
    if (!selection) {
      throw new E2EEPluginError(
        'permanent',
        'malformed-data',
        `${this.pluginName()}: imported file contained no usable keys`,
      )
    }

    if (!selection.needsPicker) {
      return this.doInstallKey(armoredMessage, workingPassphrase, selection.selected.fingerprint)
    }

    return {
      needsPicker: true,
      candidates: bundles,
      backupContext: { message: armoredMessage, passphrase: workingPassphrase },
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
      // The key we just replaced is no longer ours to decrypt with, so it must
      // not stay advertised — but any SIBLING device's entry has to survive.
      await this.publishOwnPublicKeyMetadata(
        bundle,
        previousFingerprint ? [previousFingerprint] : [],
      )
      if (previousFingerprint) {
        await this.retractStalePublicKeyDataNode(previousFingerprint, bundle.fingerprint)
      }
    } catch (err) {
      ctx.logger.warn(
        `${this.pluginName()}: public key publish after install failed: ${formatError(err)}`,
      )
    }

    // The key just became usable (restore / file import / picker). Tell the
    // host so it re-runs deferred decrypts immediately — otherwise messages
    // stashed while the key was absent stay "could not be decrypted" until an
    // unrelated trigger (reconnect, app restart) re-registers the plugin.
    ctx.notifyKeyUnlocked?.()
    this.reverifyTrustStateAfterKeyChange()

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
          this.decryptWithOwnKey(ctx.account.jid, ciphertext, senderKey ? [senderKey] : []),
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
          this.encryptToRecipients(ctx.account.jid, [recipientKey], plaintext),
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
    if (!discoSupportsPep(disco)) {
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
      // We publish the upper-case node (XEP-0373 §4.1); query that first, but
      // stay case-tolerant for a pre-#528 lower-case node not yet re-published.
      dataItems = await this.queryPublicKeyDataNodeTolerant(
        ctx.account.jid,
        toXep0373Fingerprint(bundle.fingerprint),
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
    if (
      publishedArmored !== null &&
      !openPgpBlocksEqual(publishedArmored, bundle.publicArmored) &&
      !(await this.certsShareSameKeyMaterial(publishedArmored, bundle.publicArmored))
    ) {
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

  /**
   * Decide whether the server-published cert and the local cert carry the
   * same key material, regardless of raw-byte differences.
   *
   * A byte comparison of two exports of the *same* certificate reports a
   * difference for entirely benign reasons: PR #1087's expiry heal re-signs
   * the primary (and subkey bindings) to drop the validity period, and
   * re-exporting through another OpenPGP client reorders or minimizes packets.
   * None of that changes a single component fingerprint — only a genuine
   * rotation introduces a new subkey. Comparing the set of component
   * fingerprints (primary + subkeys) is therefore the honest test for "did
   * someone publish a different key?", and it stops a harmless re-publish from
   * locking encryption behind a phantom `subkey-mismatch`.
   *
   * Falls back to `true` (treat as the same key) when either cert cannot be
   * validated: an unparseable published cert is a distinct failure that the
   * reconcile banner cannot resolve, and encryption must not be blocked on it.
   */
  private async certsShareSameKeyMaterial(
    publishedArmored: string,
    localArmored: string,
  ): Promise<boolean> {
    let published: CertValidation
    let local: CertValidation
    try {
      published = await this.validateCert(publishedArmored)
      local = await this.validateCert(localArmored)
    } catch (err) {
      this.requireCtx().logger.warn(
        `${this.pluginName()}: could not compare published key material against ` +
          `local; treating as unchanged: ${formatError(err)}`,
      )
      return true
    }
    return sameComponentFingerprints(published, local)
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
      publicKeyDataNodeFor(toXep0373Fingerprint(bundle.fingerprint)),
      { id: CURRENT_ITEM_ID, payload },
      { accessModel: 'open', persistItems: true, maxItems: 1 },
    )
  }

  /**
   * Advertise our key on `urn:xmpp:openpgp:0:public-keys`, MERGING into
   * whatever is already there.
   *
   * XEP-0373 §4.2 makes this one item the account's whole key list, shared by
   * every client. PubSub only offers a whole-item write, so we read first and
   * carry foreign entries over — replacing the item would delete our sibling
   * devices' keys, and peers that track the list (Gajim) would then stop
   * encrypting to them (issue #1059).
   *
   * @param drop fingerprints to retire instead of carrying over — the identity
   *             this publish replaces (restore / import / retire).
   */
  private async publishOwnPublicKeyMetadata(
    bundle: KeyBundle,
    drop: readonly string[] = [],
  ): Promise<void> {
    const ctx = this.requireCtx()
    let existing: PEPItem[] = []
    try {
      existing = await ctx.xmpp.queryPEP(ctx.account.jid, PUBLIC_KEYS_METADATA_NODE, 1)
    } catch (err) {
      // Read failed (node absent on first publish, or a transient error).
      // Publishing our own entry alone is still strictly better than not
      // advertising at all — a sibling's next publish re-adds its entry.
      ctx.logger.debug(
        `${this.pluginName()}: could not read the published key list before merge: ${formatError(err)}`,
      )
    }
    const payload = mergePublicKeysList({
      existing,
      // XEP-0373 §4.1: fingerprint string is upper-case hex, emitted under the
      // version-appropriate attribute (v4 = 40 hex, v6 = 64 hex).
      own: { fingerprint: bundle.fingerprint, date: new Date().toISOString() },
      drop,
    })
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
    // Retract the node we actually published — the XEP-0373 §4.1 upper-case form.
    const node = publicKeyDataNodeFor(toXep0373Fingerprint(oldFingerprint))
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
    // A definitively-fresh keyset short-circuits without a network round-trip.
    // A rehydrated-but-not-yet-refreshed cache is TENTATIVE, so we re-probe.
    if (this.freshThisSession.has(peer)) {
      const fps = this.getPeerFingerprints(peer)
      return fps.length > 0
        ? { supported: true, ttl: PROBE_NEGATIVE_TTL_SECONDS, fingerprint: fps[0] }
        : { supported: false, ttl: PROBE_NEGATIVE_TTL_SECONDS }
    }
    return this.refetchAndCachePeerKey(peer)
  }

  /**
   * Atomic multi-key refresh (XEP-0374 §2.3.1 / #1059). Classifies every
   * announced fingerprint as valid / definitively-invalid / transient and
   * commits a replacement validated set ONLY on a definitive refresh — a
   * transient blip never drops or deactivates a key we already hold. A key that
   * LEFT the announced set is marked inactive (retained for verification), not
   * deleted. See spec §"Atomic refresh".
   */
  private async refetchAndCachePeerKey(peer: BareJID): Promise<PeerSupport> {
    const ctx = this.requireCtx()
    const existing = this.peerKeys.get(peer) ?? []
    // ANY prior validated cert (active OR inactive) for a still-announced fp
    // lets us ride out a transient data-node failure — an inactive cert that is
    // authoritatively re-announced is reactivated and reused.
    const hasPriorCert = (fp: string) =>
      existing.some((c) => fingerprintsEqual(c.fingerprint, fp))
    // "Prior evidence" the peer supports OX: any cached cert or a prior success.
    const priorEvidence = existing.length > 0 || this.everSupported.has(peer)

    let announced: string[]
    try {
      const meta = await ctx.xmpp.queryPEP(peer, PUBLIC_KEYS_METADATA_NODE, 1)
      announced = parseAdvertisedFingerprints(meta)
    } catch (err) {
      // Metadata snapshot unavailable → keyset NOT fresh. With prior evidence
      // OX is supported, keep supported:true so encrypt() runs and throws
      // peer-keyset-incomplete (a transient the send path retries) — never a
      // silent plaintext downgrade. Only with no evidence report unsupported.
      const { kind, code } = classifyBoundaryError(err)
      ctx.logger.debug(
        `${this.pluginName()}: metadata refresh for ${peer} failed (${kind}/${code}): ${formatError(err)}`,
      )
      this.markKeysetIncomplete(peer)
      return {
        supported: priorEvidence,
        ttl: kind === 'transient' ? PROBE_TRANSIENT_TTL_SECONDS : PROBE_NEGATIVE_TTL_SECONDS,
      }
    }

    const nowIso = new Date().toISOString()

    if (announced.length === 0) {
      // Definitive: the account announces no keys. Retire every cert, clear
      // stale health/rejections, mark the snapshot fresh (not incomplete).
      this.setPeerCerts(peer, markDepartedInactive(existing, new Set(), nowIso))
      this.recordKeysetHealth(peer, { incomplete: false, rejections: [] })
      this.markKeysetFresh(peer)
      return { supported: false, ttl: PROBE_NEGATIVE_TTL_SECONDS }
    }

    const rejections: CertRejection[] = []
    const validated: KeyBundle[] = []
    const retainedReannounced: string[] = [] // canonical fps kept across a blip
    let unresolvedTransient = false
    for (const fp of announced) {
      const result = await this.fetchAdvertisedKeyClassified(peer, fp, rejections)
      if (result.kind === 'valid') validated.push(result.bundle)
      else if (result.kind === 'transient') {
        // A transient blip on an fp we already hold is fine — reuse it. Only a
        // transient on a re-announced fp with NO prior cert is truly incomplete.
        if (hasPriorCert(fp)) retainedReannounced.push(toXep0373Fingerprint(fp))
        else unresolvedTransient = true
      }
      // 'definitively-invalid' → recorded in `rejections`, excluded (not a recipient).
    }

    if (unresolvedTransient) {
      // Retain prior certs across the blip; do not commit a pruned set.
      this.markKeysetIncomplete(peer)
      return { supported: true, ttl: PROBE_TRANSIENT_TTL_SECONDS }
    }

    // Definitive refresh: commit. Upsert validated (active); reactivate any
    // re-announced fp retained across a blip; mark departed inactive; cap.
    let next = existing
    for (const b of validated) next = upsertActive(next, b)
    next = next.map((c) =>
      retainedReannounced.some((fp) => fingerprintsEqual(fp, c.fingerprint))
        ? { ...c, active: true, inactiveAt: undefined }
        : c,
    )
    // Build the still-announced set in CANONICAL form so markDepartedInactive's
    // `Set.has()` matches the canonical stored fingerprints.
    const stillAnnounced = new Set<string>([
      ...validated.map((b) => toXep0373Fingerprint(b.fingerprint)),
      ...retainedReannounced,
    ])
    next = markDepartedInactive(next, stillAnnounced, nowIso)
    next = capUnverifiedInactive(next, (fp) => isPeerVerified(peer, fp), UNVERIFIED_INACTIVE_CAP)
    this.setPeerCerts(peer, next)
    this.recordKeysetHealth(peer, { incomplete: false, rejections })
    this.markKeysetFresh(peer)
    const activeFps = activeFingerprints(next)
    if (activeFps.length > 0) this.everSupported.add(peer)
    return {
      supported: activeFps.length > 0,
      ttl: PROBE_NEGATIVE_TTL_SECONDS,
      ...(activeFps.length > 0 && { fingerprint: activeFps[0] }),
    }
  }

  /**
   * Query a public-key data node tolerantly across fingerprint case.
   *
   * XEP-0373 §4.1 mandates upper-case, but a peer (or our own pre-#528 nodes)
   * may have published a data node under a different case than it advertises.
   * Per Postel's law we accept either: try the fingerprint verbatim first
   * (the spec-compliant peer hits immediately, no extra round-trip), then the
   * canonical upper- and lower-case variants. Returns the first non-empty
   * result, or `[]` if none of the variants resolve.
   */
  private async queryPublicKeyDataNodeTolerant(
    jid: BareJID,
    fingerprint: string,
  ): Promise<PEPItem[]> {
    const ctx = this.requireCtx()
    const canonical = toXep0373Fingerprint(fingerprint)
    const variants = [fingerprint, canonical, canonical.toLowerCase()]
    const tried = new Set<string>()
    for (const variant of variants) {
      const node = publicKeyDataNodeFor(variant)
      if (tried.has(node)) continue
      tried.add(node)
      try {
        const items = await ctx.xmpp.queryPEP(jid, node, 1)
        if (items.length > 0) return items
      } catch (err) {
        // Servers disagree on how to answer a query for a node that does not
        // exist: some return an empty result, others an item-not-found IQ
        // error. A missing node means "try the next casing variant", not "give
        // up" — so swallow not-found and continue. Re-throw anything else
        // (timeout, server error) so the caller treats it as a real failure
        // rather than silently masking it as "peer has no key".
        if (classifyBoundaryError(err).code !== 'not-found') throw err
      }
    }
    return []
  }

  /**
   * Fetch + validate one announced key's data node and CLASSIFY the outcome:
   *
   * - `valid` — data node fetched; cert fp matches the advertised fp; a
   *   `xmpp:<bare jid>` UID is present; AND a usable encryption subkey exists.
   * - `definitively-invalid` — data node fetched but the cert is provably not a
   *   usable recipient (fp mismatch, UID mismatch, no usable encryption subkey,
   *   or unparseable/permanently-bad material). Recorded in `rejections`.
   * - `transient` — the data node could not be fetched at all (timeout, server
   *   error, or an absent/empty node — half-published / replication lag). The
   *   key may be legitimate and merely unavailable, so the caller fails closed.
   */
  private async fetchAdvertisedKeyClassified(
    peer: BareJID,
    fingerprint: string,
    rejections: CertRejection[],
  ): Promise<
    | { kind: 'valid'; bundle: KeyBundle }
    | { kind: 'definitively-invalid' }
    | { kind: 'transient' }
  > {
    const ctx = this.requireCtx()
    const now = new Date().toISOString()
    let items: PEPItem[]
    try {
      items = await this.queryPublicKeyDataNodeTolerant(peer, fingerprint)
    } catch (err) {
      ctx.logger.debug(
        `${this.pluginName()}: fetch ${peer} key ${fingerprint} failed: ${formatError(err)}`,
      )
      return { kind: 'transient' }
    }
    // Absent/empty data node for a still-announced fp: half-published or
    // replication lag. Fail closed — transient, not "definitely no key".
    if (items.length === 0) return { kind: 'transient' }

    for (const item of items) {
      const armored = parsePublicKeyDataItem(item.payload)
      if (!armored) continue
      let validation: CertValidation
      try {
        validation = await this.validateCert(armored)
      } catch (err) {
        // A transient IPC fault (panic/timeout) is NOT a verdict on the cert.
        if (classifyBoundaryError(err).kind === 'transient') return { kind: 'transient' }
        const detail = formatError(err)
        ctx.logger.warn(
          `${this.pluginName()}: validateCert for ${peer}/${fingerprint} failed: ${detail}`,
        )
        rejections.push({ fingerprint, code: 'validation_failed', detail, observedAt: now })
        return { kind: 'definitively-invalid' }
      }
      if (!fingerprintsEqual(validation.fingerprint, fingerprint)) {
        const detail = `advertised ${fingerprint}, served ${validation.fingerprint}`
        ctx.logger.warn(`${this.pluginName()}: ${peer} ${detail}; discarding`)
        rejections.push({ fingerprint, code: 'fingerprint_mismatch', detail, observedAt: now })
        return { kind: 'definitively-invalid' }
      }
      const expectedUid = accountUserId(peer)
      const uidMatch = validation.userIds.some(
        (uid) => uid.toLowerCase() === expectedUid.toLowerCase(),
      )
      if (!uidMatch) {
        const detail = `expected ${expectedUid}, got [${validation.userIds.join(', ')}]`
        ctx.logger.warn(
          `${this.pluginName()}: ${peer} key ${fingerprint} has no matching UID (${detail}); discarding`,
        )
        rejections.push({ fingerprint, code: 'uid_mismatch', detail, observedAt: now })
        return { kind: 'definitively-invalid' }
      }
      if (!validation.hasEncryptionSubkey) {
        const detail = `cert ${fingerprint} has no usable encryption subkey`
        ctx.logger.warn(`${this.pluginName()}: ${peer} ${detail}; discarding`)
        rejections.push({ fingerprint, code: 'no_encryption_subkey', detail, observedAt: now })
        return { kind: 'definitively-invalid' }
      }
      return {
        kind: 'valid',
        bundle: {
          fingerprint: validation.fingerprint,
          publicArmored: armored,
          keychainBacked: false,
        },
      }
    }
    // Items present but none parsed to usable armored material (legacy Fluux
    // Base64-of-armor shape, or junk). Fetched-but-unusable → definitive.
    return { kind: 'definitively-invalid' }
  }

  /** Commit a peer's cert set to the map + persist. (Stage 2 adds reactive notify.) */
  private setPeerCerts(peer: BareJID, certs: CachedPeerCert[]): void {
    this.peerKeys.set(peer, certs)
    this.persistPeerKeyCache()
  }

  /**
   * Mark a peer's keyset incomplete (a transient couldn't be resolved). Clears
   * `freshThisSession` (so a mid-session incompleteness re-blocks the send path
   * rather than riding on a now-stale fresh flag) but does NOT set it — the JID
   * stays retry-able, so a service that recovers mid-session heals without a
   * restart (`ensureFreshKeyset` re-probes once the backoff elapses). Leaves any
   * prior rejections untouched (retain across the blip).
   */
  private markKeysetIncomplete(peer: BareJID): void {
    this.keysetIncomplete.add(peer)
    this.freshThisSession.delete(peer)
    this.keysetRetryAfter.set(peer, this.now() + PROBE_TRANSIENT_TTL_SECONDS * 1000)
  }

  /** Mark a peer's keyset definitively fresh + complete for this session. */
  private markKeysetFresh(peer: BareJID): void {
    this.freshThisSession.add(peer)
    this.keysetIncomplete.delete(peer)
    this.keysetRetryAfter.delete(peer)
  }

  /**
   * Record a peer's definitive keyset health from a definitive refresh:
   * `incomplete` reconciles the `keysetIncomplete` set; `rejections` are mirrored
   * to the persisted cert-rejection store the app shield reads (`incomplete` and
   * `rejections` are independent and can coexist). The in-memory `getKeysetHealth`
   * accessor for the reactive shield lands with Stage 2.
   */
  private recordKeysetHealth(
    peer: BareJID,
    health: { incomplete: boolean; rejections: CertRejection[] },
  ): void {
    if (health.incomplete) this.keysetIncomplete.add(peer)
    else this.keysetIncomplete.delete(peer)
    if (health.rejections.length > 0) recordCertRejections(peer, health.rejections)
    else clearCertRejections(peer)
  }

  private persistPeerKeyCache(): void {
    if (this.ctx?.account.jid) {
      savePeerKeyCache(this.ctx.account.jid, this.peerKeys)
    }
  }

  // ---------------------------------------------------------------------------
  // Keyset read helpers (consumed by encrypt/decrypt — Tasks 6-7)
  // ---------------------------------------------------------------------------

  /** Active (still-announced) validated public certs — the encryption recipients. */
  private getActivePeerPublics(peer: BareJID): string[] {
    return activePublics(this.peerKeys.get(peer) ?? [])
  }

  /**
   * Our OWN account's active announced public certs — the sibling devices we
   * fan an outgoing message out to so every one of our clients can read it
   * (XEP-0373 §4 shares one key list per account). It is just the active peer
   * set keyed by our own bare JID; a definitive refresh via
   * {@link ensureFreshKeyset} populates it before the first send.
   */
  private getOwnAnnouncedPublics(): string[] {
    return this.getActivePeerPublics(getBareJid(this.requireCtx().account.jid))
  }

  /** Active (still-announced) validated fingerprints for a peer. */
  getPeerFingerprints(peer: BareJID): string[] {
    return activeFingerprints(this.peerKeys.get(peer) ?? [])
  }

  /**
   * The verifier public set for a message: active certs always, plus any
   * inactive cert eligible under the archive-time policy (`messageTime` predates
   * `inactiveAt` ± tolerance) — so a retired key verifies eligible archived
   * traffic but never a fresh live message. See spec §Retained certs.
   */
  private getEligibleVerifierPublics(peer: BareJID, messageTime?: Date): string[] {
    return eligibleVerifierPublics(
      this.peerKeys.get(peer) ?? [],
      { messageTime },
      INACTIVE_ARCHIVE_TOLERANCE_MS,
    )
  }

  /**
   * Ensure a fresh, complete keyset before the first send. A definitively-fresh
   * JID short-circuits. An INCOMPLETE keyset is NOT marked fresh — it stays
   * retry-able: we re-probe once the transient backoff (`keysetRetryAfter`)
   * elapses, so a service that recovers mid-session heals without a restart.
   */
  private async ensureFreshKeyset(jid: BareJID): Promise<'ok' | 'incomplete'> {
    if (this.freshThisSession.has(jid)) return 'ok'
    const retryAfter = this.keysetRetryAfter.get(jid)
    if (retryAfter !== undefined && this.now() < retryAfter) return 'incomplete' // backoff
    await this.refetchAndCachePeerKey(jid)
    return this.keysetIncomplete.has(jid) ? 'incomplete' : 'ok'
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
      if (this.getPeerFingerprints(peer).some((fp) => fp === targetFp)) {
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
    const ownBareJid = getBareJid(ctx.account.jid)
    const isSelfChat = peer === ownBareJid

    // Metadata freshness: the first send to a peer this session forces a
    // definitive metadata refresh. A transient failure fails closed with a
    // retryable `peer-keyset-incomplete` — never a silent plaintext downgrade.
    // Self-chat (peer === own JID) is covered here for free: an incomplete own
    // keyset defers (this same throw) rather than sending degraded.
    if ((await this.ensureFreshKeyset(peer)) === 'incomplete') {
      throw new E2EEPluginError(
        'transient',
        'peer-keyset-incomplete',
        `${this.pluginName()}: ${peer}'s announced keyset is not fresh/complete — will retry`,
      )
    }
    // Fan out to EVERY active (still-announced) validated peer cert (#1059).
    const peerPublics = this.getActivePeerPublics(peer)
    if (peerPublics.length === 0) {
      throw new E2EEPluginError(
        'transient',
        'peer-key-missing',
        `${this.pluginName()}: no cached public key for ${peer} — probe first`,
      )
    }

    // Also fan out to our OWN announced siblings so every one of our devices can
    // read this outgoing message. Self-chat needs no extra set — the peer IS our
    // own keyset (the dedup below collapses the union).
    let recipients = [...peerPublics]
    if (!isSelfChat) {
      const ownFresh = await this.ensureFreshKeyset(ownBareJid)
      recipients.push(...this.getOwnAnnouncedPublics())
      if (ownFresh === 'incomplete') {
        // Degraded send: the local cert is always a recipient (appended in Rust),
        // so the author + this device always decrypt; a sibling omitted here can
        // never decrypt THIS archived message (future messages recover once the
        // own keyset refreshes). Stage 1 emits a log-only diagnostic; the
        // persistent account-level warning is an explicit Stage 2 trust-surface
        // item, deliberately NOT built here.
        ctx.logger.warn(
          `${this.pluginName()}: own keyset incomplete — message sent degraded; some sibling clients may not decrypt it`,
        )
      }
    }
    recipients = [...new Set(recipients)] // dedup (matters when peer JID == own JID)

    const payloadXml = new TextDecoder().decode(plaintext)
    const envelope = wrapForSigncrypt({
      payloadXml,
      peerJid: getBareJid(peer),
      timestamp: new Date(this.now()),
    })
    const ciphertext = await this.encryptToRecipients(
      ctx.account.jid,
      recipients,
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
    // Pass EVERY candidate signer cert so a signature from any announced key
    // verifies (#1059). Task 7 widens the peer set to the archive-eligible
    // verifier set (active + eligible inactive); Stage 1 uses active certs.
    const senderPublics = isSelfOutgoing
      ? this.ownBundle?.publicArmored
        ? [this.ownBundle.publicArmored]
        : []
      : this.getEligibleVerifierPublics(peer, context?.archiveTimestamp)
    const hasSenderKey = senderPublics.length > 0

    let output: DecryptOutput
    try {
      output = await this.decryptWithOwnKey(
        ctx.account.jid,
        ciphertext,
        senderPublics,
      )
    } catch (err) {
      // Classify raw backend errors (e.g. openpgp.js "Error during parsing …"
      // on a structurally malformed payload) into a typed E2EEPluginError so
      // the SDK can tell a terminal 'malformed-data' failure from a retryable
      // one. Already-typed errors (key-locked, …) pass through unchanged.
      throw this.toPluginError('decrypt', err)
    }

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
    if (hasSenderKey && !output.signatureVerified) {
      // A clock-skew "not yet valid" failure is transient — the signature may
      // verify once clocks converge. Throw a distinct transient code so the
      // decrypt pipeline stashes it for retry (retryPendingDecrypts) instead
      // of issuing a permanent, sticky rejection. Any other failure is genuine.
      if (output.signatureNotYetValid) {
        throw new E2EEPluginError(
          'transient',
          'signature-not-yet-valid',
          `${this.pluginName()}: signcrypt signature creation time is ahead of our clock beyond tolerance — will retry`,
        )
      }
      throw new E2EEPluginError(
        'permanent',
        'signature-failed',
        `${this.pluginName()}: signcrypt signature did not verify against available sender key`,
      )
    }
    // Case C (signaturePresent + !hasSenderKey + !signatureVerified)
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
      !hasSenderKey
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
      : this.getPeerFingerprints(peer)[0]
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
    const activeFps = this.getPeerFingerprints(peer)
    if (activeFps.length === 0) return 'unknown'
    // Stage 1 trust is per-fingerprint: verified iff any active cert is
    // verified (Stage 2 introduces the full announced-set derivation).
    return activeFps.some((fp) => isPeerVerified(peer, fp)) ? 'verified' : 'tofu'
  }

  // ---------------------------------------------------------------------------
  // Accessors (called by UI layer)
  // ---------------------------------------------------------------------------

  getOwnFingerprint(): string | null {
    return this.ownBundle?.fingerprint ?? null
  }

  /**
   * Whether the active key's passphrase is protected by the OS keychain.
   * `false` means it falls back to a cleartext file on disk (desktop on a
   * platform with no secret service) — the UI warns the user it is not
   * protected at rest. `null` when no identity is established yet. (Web
   * always reports `false`; callers gate the warning on desktop.)
   */
  isKeychainBacked(): boolean | null {
    return this.ownBundle?.keychainBacked ?? null
  }

  getBackedUpFingerprint(): string | null {
    const jid = this.ctx?.account.jid
    if (!jid) return null
    return readBackedUpFingerprint(jid)
  }

  getPeerFingerprint(peer: BareJID): string | null {
    // Back-compat single-fp accessor: the first active announced fingerprint.
    // Multi-key callers use `getPeerFingerprints`.
    return this.getPeerFingerprints(peer)[0] ?? null
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

    // Verify against every active peer cert (Task 7 widens to the eligible
    // verifier set keyed on each entry's receive time).
    const peerPublics = this.getActivePeerPublics(peer)
    if (peerPublics.length === 0) {
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
          peerPublics,
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
        // A transient fault (e.g. IPC timeout, backend panic) tells us nothing
        // about the signature — rejecting here would clobber an optimistically
        // delivered, possibly-valid message permanently. Keep the entry so the
        // next drain (triggered by a future key change) can retry. Only a
        // permanent error means the ciphertext itself is unrecoverable.
        const { kind } = classifyBoundaryError(err)
        if (kind === 'transient') {
          remaining.push(entry)
          continue
        }
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
    // The signer is placed against the peer's ACTIVE announced keyset: a
    // signature from ANY announced key is a legitimate peer signature (#1059).
    // Task 7 replaces this with `resolvePeerTrust` over the eligible verifier
    // set (so a retired key can't authenticate live traffic).
    const activeFps = this.getPeerFingerprints(peer)
    const hasCert = activeFps.length > 0
    const signerMatches = output.signerFingerprint
      ? activeFps.some((fp) => fingerprintsEqual(fp, output.signerFingerprint!))
      : false
    let trust: SecurityContext['trust']
    if (output.signatureVerified && signerMatches) {
      trust = isPeerVerified(peer, output.signerFingerprint!) ? 'verified' : 'tofu'
    } else {
      trust = 'untrusted'
    }

    const notes: string[] = []
    if (!output.signatureVerified) {
      notes.push(hasCert ? 'Signature did not verify' : 'Sender key not cached — signature not checked')
    } else if (!signerMatches) {
      notes.push('Signature verified but fingerprint does not match cached peer')
    }

    return {
      protocolId: OPENPGP_DESCRIPTOR.id,
      trust,
      ...(notes.length > 0 && { notes }),
      ...(output.signerFingerprint && { fingerprint: output.signerFingerprint }),
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
      ...(output.signerFingerprint && { fingerprint: output.signerFingerprint }),
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

/**
 * `item-not-found` is the only IQ error condition that means "this node was
 * never created", i.e. the user has genuinely never published a backup.
 * ejabberd and Prosody both return it for an absent node. Every other
 * failure (timeout, transport down, permission, internal error) leaves the
 * question open and must NOT collapse to "no backup".
 *
 * The IQ caller surfaces XMPP conditions inside the Error message; the
 * codebase convention is to substring-match the condition name. Mirrors
 * `secretKeyProbe.ts`, which established these semantics for the
 * plugin-less toggle-on path.
 */
function isItemNotFoundError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('item-not-found')
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

/**
 * Two certs share the same key material when their component fingerprints —
 * the primary plus every subkey — match. Fingerprints are immutable identifiers
 * of key packets, so re-signing (expiry stripped, packets reordered) leaves
 * them untouched while a rotation adds a new subkey fingerprint. Order- and
 * case-insensitive so the two OpenPGP backends' differing hex casing can't
 * fabricate a difference.
 */
function sameComponentFingerprints(a: CertValidation, b: CertValidation): boolean {
  const componentKey = (v: CertValidation): string =>
    [v.fingerprint, ...v.subkeyFingerprints].map(normalizeFingerprint).sort().join('|')
  return componentKey(a) === componentKey(b)
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
