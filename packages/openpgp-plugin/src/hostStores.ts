/**
 * Host-store seam for the OpenPGP plugin.
 *
 * `OpenPGPPluginBase` reads and writes five pieces of app-owned trust state
 * (cert rejections, key-change alerts, own-key conflict, pinned primary
 * fingerprints, trust-state integrity status). Rather than importing the
 * app's Zustand stores directly (which would pin the package to
 * `apps/fluux/src`), the base reaches them through an injected
 * `OpenPGPHostStores` adapter. The app implements it at plugin registration,
 * delegating to the real stores; the store DATA stays app-side, so every UI
 * subscription and localStorage key is untouched.
 *
 * Verified-peer trust state used to be a sixth group here (`verifiedPeers`),
 * dual-written alongside the plugin-owned `VerifiedKeysCache`. Phase B2
 * Task 8 deleted that mirror — and the app-side `verifiedPeerKeysStore` it
 * wrapped — entirely; the cache is now the sole source of truth, seeded
 * once from the legacy localStorage key on upgrade (see
 * `legacyVerifiedPeersSeed.ts`).
 */

// ---- Contract types (structurally identical to the app store definitions) ----

export type CertRejectionCode =
  | 'validation_failed'
  | 'fingerprint_mismatch'
  | 'uid_mismatch'

export interface CertRejection {
  fingerprint: string
  code: CertRejectionCode
  detail: string
  observedAt: string
}

export interface KeyChangeAlert {
  previousFingerprint: string
  currentFingerprint: string
  observedAt: string
}

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

// ---- The adapter interface ----

export interface OpenPGPHostStores {
  certRejections: {
    record(jid: string, rejections: CertRejection[]): void
    clear(jid: string): void
  }
  keyChangeAlerts: {
    record(jid: string, previousFingerprint: string, currentFingerprint: string): void
    clear(jid: string): void
    get(jid: string): KeyChangeAlert | null
    getAll(): Record<string, KeyChangeAlert>
    /** Fires whenever the alerts map changes (used to reseal trust state). */
    subscribe(listener: () => void): () => void
  }
  ownKeyConflict: {
    record(conflict: OwnKeyConflict): void
    clear(): void
    get(): OwnKeyConflict | null
  }
  pinnedPrimaryFingerprints: {
    get(jid: string): string | null
    set(jid: string, fingerprint: string): void
    getAll(): Record<string, string>
    /** Fires whenever the pin map changes (used to reseal trust state). */
    subscribe(listener: () => void): () => void
  }
  trustStateStatus: {
    set(status: TrustStateStatus, details?: string[]): void
    get(): TrustStateStatus
  }
}

// ---- Injected Tauri file I/O (desktop only) ----

export interface OpenPGPFileIO {
  /**
   * Present a save dialog defaulting to `defaultName`, and if the user picks a
   * path, write `armored` to it. Resolves `true` when written, `false` when the
   * user cancelled. (Matches the current `SequoiaPgpPlugin.exportKeyToFile` tail.)
   */
  saveFile(defaultName: string, armored: string): Promise<boolean>
  /**
   * Present an open dialog and return the CONTENTS of the chosen file, or
   * `null` if the user cancelled. (Matches the current
   * `SequoiaPgpPlugin.pickKeyFile`, which returns file text, not a path.)
   */
  pickFile(): Promise<string | null>
}
