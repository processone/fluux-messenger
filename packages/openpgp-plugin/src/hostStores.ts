/**
 * The host's trust and status state, as the OpenPGP plugin sees it.
 *
 * The plugin reads and writes seven pieces of per-app state (verified peers,
 * key-change alerts, certificate rejections, own-key conflict, pinned primary
 * fingerprints, the trust-state verdict and the peer-keyset revision). The host
 * owns the storage and supplies it through this interface, so the plugin
 * imports no app store.
 *
 * Contract for every `subscribe`: the listener runs synchronously inside the
 * write that changed the map, once per change, and only when the map actually
 * changed (a write of the same value does not call it). The verification
 * publish guard in the base class depends on synchronous delivery.
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

/** A peer once verified whose advertised fingerprint changed since. */
export interface KeyChangeAlert {
  /** Fingerprint the user had previously verified. */
  previousFingerprint: string
  /** Fingerprint now cached for the peer (their current key). */
  currentFingerprint: string
  /** ISO timestamp when the rotation was first observed. */
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

export type HostStoreUnsubscribe = () => void

/** Called with the new and previous map after each change of that map. */
export type HostMapListener<T> = (next: Readonly<Record<string, T>>, prev: Readonly<Record<string, T>>) => void

export interface OpenPGPHostStores {
  /** Peers whose fingerprint the user confirmed out of band. */
  verifiedPeers: {
    /** Fingerprint comparison ignores case and whitespace. */
    isVerified(jid: string, fingerprint: string): boolean
    set(jid: string, fingerprint: string): void
    clear(jid: string): void
    getAll(): Readonly<Record<string, string>>
    subscribe(listener: HostMapListener<string>): HostStoreUnsubscribe
  }
  /** Certificates of a peer that failed validation. */
  certRejections: {
    record(jid: string, rejections: CertRejection[]): void
    clear(jid: string): void
    /** `[]` when none. */
    get(jid: string): CertRejection[]
  }
  keyChangeAlerts: {
    get(jid: string): KeyChangeAlert | null
    clear(jid: string): void
    getAll(): Readonly<Record<string, KeyChangeAlert>>
    subscribe(listener: HostMapListener<KeyChangeAlert>): HostStoreUnsubscribe
  }
  ownKeyConflict: {
    record(conflict: OwnKeyConflict): void
    clear(): void
    get(): OwnKeyConflict | null
  }
  /** Primary fingerprint trusted per peer (TOFU pin). */
  pinnedPrimaryFingerprints: {
    set(jid: string, fingerprint: string): void
    getAll(): Readonly<Record<string, string>>
    subscribe(listener: HostMapListener<string>): HostStoreUnsubscribe
  }
  trustStateStatus: {
    set(status: TrustStateStatus, details?: string[]): void
    get(): TrustStateStatus
  }
  /** Tells the UI a peer's set of announced keys changed. */
  peerKeysets: {
    notifyChanged(jid: string): void
  }
}
