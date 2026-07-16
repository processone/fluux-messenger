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

// PEP secret-key / identity probes.
export {
  probeRemoteIdentityState,
  probeRemotePublishedFingerprints,
  SecretKeyBackupProbeError,
} from './secretKeyProbe'
export type { RemoteIdentityState } from './secretKeyProbe'

// XEP-0373 base plugin: descriptor, error classifier, shared value/output types,
// and the abstract base class subclasses extend.
export { OpenPGPPluginBase, OPENPGP_DESCRIPTOR, classifyBoundaryError } from './OpenPGPPluginBase'
export type { KeyBundle, RestoreResult, DecryptOutput, CertValidation } from './OpenPGPPluginBase'

// App-layer recovery signals raised by the web unlock auto-recovery path.
export { KeyPickerRequiredError, NoRecoveryAvailableError } from './recoveryErrors'
