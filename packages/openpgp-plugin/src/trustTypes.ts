/**
 * Trust and status types the OpenPGP plugin reports to the app.
 *
 * The plugin owns all of this state: per-key trust decisions and certificate
 * rejections persist in its own storage (see `trustRecords.ts`), and the
 * own-key conflict and the trust-state verdict live in memory for the session.
 */

export type CertRejectionCode =
  | 'validation_failed'
  | 'fingerprint_mismatch'
  | 'uid_mismatch'
  | 'no_encryption_subkey'

export interface CertRejection {
  fingerprint: string
  code: CertRejectionCode
  detail: string
  observedAt: string
}

/** The key published on the server does not match the local key material. */
export interface OwnKeyConflict {
  kind: 'primary-mismatch' | 'subkey-mismatch'
  localFingerprint: string
  publishedFingerprint: string
  publishedDate: string
}

export type TrustStateStatus =
  | 'uninitialized'
  | 'sealed'
  | 'pending-seal'
  | 'awaiting-key'
  | 'compromised'

/** The trust-state verdict, with what differed when it is `compromised`. */
export interface TrustStateVerdict {
  status: TrustStateStatus
  details?: string[]
}

/**
 * A decision the user made about one key of a contact.
 *
 * - `verified`: the user confirmed this key out of band.
 * - `tofu`: the user approved this key without verifying it, or removed its
 *   verification. It is used for encryption.
 * - `untrusted`: the user refused this key. It is never used for encryption.
 */
export type KeyDecision = 'verified' | 'tofu' | 'untrusted'
