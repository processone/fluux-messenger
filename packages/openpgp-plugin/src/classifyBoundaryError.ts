import type { E2EEErrorKind } from '@fluux/sdk'

/**
 * Classify a raw error into transient/permanent + machine-readable code.
 * Handles XMPP-level IQ errors (same on all platforms) and common
 * Rust/openpgp.js failure messages.
 */
export function classifyBoundaryError(err: unknown): { kind: E2EEErrorKind; code: string } {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()

  if (msg.includes('openpgp-storage-unavailable:')) {
    return { kind: 'permanent', code: 'key-storage-unavailable' }
  }
  // FLM-304: answers of the explicit keychain retry. A new refusal keeps
  // the earlier recovery state; "unavailable" means there is nothing to retry.
  if (msg.includes('openpgp-keychain-refused:')) {
    return { kind: 'permanent', code: 'keychain-refused' }
  }
  if (msg.includes('openpgp-keychain-retry-unavailable:')) {
    return { kind: 'permanent', code: 'keychain-retry-unavailable' }
  }

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
