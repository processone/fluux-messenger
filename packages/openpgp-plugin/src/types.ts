/** Shared OpenPGP plugin types, used by the base class, both plugins and the screens. */

import type { IdentityInfo } from '@fluux/sdk'

/**
 * Public key material for an identity (own or peer). Does NOT carry secret
 * key material — crypto backends keep that internally.
 */
export interface KeyBundle {
  fingerprint: string
  publicArmored: string
  /** True when the private key is protected by the OS keychain (Tauri only). */
  keychainBacked: boolean
  /** ISO 8601 primary-key creation time. */
  createdAt?: string
  /**
   * Primary and every subkey fingerprint of the full certificate, retired ones
   * included. `publicArmored` may omit retired subkeys (native), so the backup
   * identity record reads this when the backend reports it.
   */
  componentFingerprints?: string[]
}

/** Explicit consent to recover only this account; never inferred from an error. */
export interface BackupRecoveryMode {
  accountJid: string
}

/** Selected-key installs carry the typed code independently of its working form.
 * Supplying accountJid explicitly opts into account-bound recovery. */
export interface KeyInstallOptions {
  accountJid?: string
  typedPassphrase?: string
}

export interface BackupContext {
  message: string
  /** Code form that decrypted this source, possibly the legacy encoding. */
  passphrase: string
  typedPassphrase?: string
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
      recommendedFingerprint?: string
      candidates: KeyBundle[]
      backupContext: BackupContext
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
  createdAt: string
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

export type BackupProbeResult = 'present' | 'absent' | 'unknown'

/**
 * What the native store's cached answers say about the keychain items that
 * unlock our key: `held` while it keeps the user's refusal of them, `pending`
 * while a keychain read is under way, such as an earlier retry still waiting
 * on the user's answer, and `unlocked` once the native store has the key
 * unlocked, for example by such a retry the user allowed after it timed out.
 */
export type KeychainRetryAvailability = 'held' | 'not-held' | 'pending' | 'unlocked'

/**
 * What the keychain retry panel offers (FLM-304). `offered`: asking the
 * keychain again. `ready`: using the key the native store already unlocked,
 * which reads nothing (FLM-408 R5). `unconfirmed` while no answer holds yet:
 * a keychain read is under way, such as a retry whose prompt outlived its
 * time limit, or a probe failed. Only `none` confirms that nothing is left.
 */
export type KeychainRetryState = 'offered' | 'ready' | 'unconfirmed' | 'none'
