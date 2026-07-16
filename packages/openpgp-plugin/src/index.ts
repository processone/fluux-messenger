// Public surface of `@fluux/openpgp-plugin`. Populated per task.

// Fingerprint utilities (single source of truth, imported by the app UI).
export { fingerprintsEqual, toXep0373Fingerprint, pubkeyMetadataFingerprintAttrs } from './fingerprintCompare'

// Backup passphrase format + generation.
export { parseArmorPassphraseFormat } from './passphraseFormatHeader'
export { generateBackupPassphrase, generateBackupCode, USE_V6_KEYS } from './passphraseGenerator'

// Web session-passphrase lock state + cache.
export { isKeyLocked, subscribeKeyLockState, setSessionPassphrase } from './webPassphraseStore'
export {
  sweepExpiredPassphrases,
  clearCachedPassphrase,
  clearAllCachedPassphrases,
  cachePassphrase,
  loadCachedPassphrase,
  getRememberPassphrasePreference,
  setRememberPassphrasePreference,
} from './webPassphraseCache'

// Host-store seam (interfaces + contract types; app implements the adapter).
export type {
  OpenPGPHostStores,
  OpenPGPFileIO,
  CertRejection,
  CertRejectionCode,
  KeyChangeAlert,
  OwnKeyConflict,
  TrustStateStatus,
} from './hostStores'
