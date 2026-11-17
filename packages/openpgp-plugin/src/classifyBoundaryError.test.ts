/**
 * Table test for classifyBoundaryError: every branch, with error text taken
 * from the Rust backend (src-tauri/src/openpgp*.rs), openpgp.js and the XMPP
 * stanza error conditions. Branch order matters (the first match wins), so
 * the table also pins the cases where a message could match two branches.
 */
import { describe, expect, it } from 'vitest'
import { classifyBoundaryError } from './classifyBoundaryError'

type Row = { name: string; input: unknown; kind: 'permanent' | 'transient'; code: string }

const rows: Row[] = [
  // Rust: openpgp_storage.rs
  { name: 'storage unavailable', input: new Error('openpgp-storage-unavailable: keychain locked'), kind: 'permanent', code: 'key-storage-unavailable' },
  { name: 'keychain refused again', input: 'openpgp-keychain-refused: access to the protected items was refused again', kind: 'permanent', code: 'keychain-refused' },
  { name: 'keychain retry unavailable', input: 'openpgp-keychain-retry-unavailable: no refused keychain access to retry for a@b.c', kind: 'permanent', code: 'keychain-retry-unavailable' },
  // Rust: openpgp_backup.rs, openpgp.js
  { name: 'no SKESK matched', input: new Error('no SKESK matched the supplied passphrase'), kind: 'permanent', code: 'wrong-passphrase' },
  { name: 'openpgp.js session key failure', input: new Error('Session key decryption failed.'), kind: 'permanent', code: 'wrong-passphrase' },
  { name: 'openpgp.js incorrect key passphrase', input: new Error('Incorrect key passphrase: Modification detected.'), kind: 'permanent', code: 'wrong-passphrase' },
  { name: 'empty backup passphrase', input: new Error('backup passphrase is empty'), kind: 'permanent', code: 'empty-passphrase' },
  // Rust: openpgp_storage.rs
  { name: 'passphrase missing from keychain', input: "passphrase for account 'a@b.c' is not in the keychain or on disk — key material cannot be decrypted", kind: 'permanent', code: 'key-unrecoverable' },
  { name: 'persisted TSK does not decrypt', input: 'decrypt persisted TSK with stored passphrase: bad', kind: 'permanent', code: 'key-unrecoverable' },
  { name: 'primary secret key does not decrypt', input: 'decrypt primary secret key: bad', kind: 'permanent', code: 'key-unrecoverable' },
  { name: 'secret subkey does not decrypt', input: 'decrypt secret subkey: bad', kind: 'permanent', code: 'key-unrecoverable' },
  { name: 'unexpected EOF on CFB secret', input: 'unexpected EOF', kind: 'permanent', code: 'key-unrecoverable' },
  // Rust: openpgp.rs, SequoiaPgpPlugin
  { name: 'no key for account', input: 'no key for account account: a@b.c', kind: 'permanent', code: 'key-missing' },
  { name: 'no identity to export', input: new Error('SequoiaPgpPlugin: no identity to export — call ensureIdentity first'), kind: 'permanent', code: 'key-missing' },
  { name: 'not a recognizable public key', input: 'not a recognizable OpenPGP public key: eof', kind: 'permanent', code: 'malformed-key' },
  { name: 'unknown PEM type', input: new Error('Unknown PEM type'), kind: 'permanent', code: 'malformed-key' },
  { name: 'could not convert stream', input: new Error('Could not convert stream'), kind: 'permanent', code: 'malformed-key' },
  // Rust: openpgp_backup.rs
  { name: 'backup is a public key', input: 'backup input is a public key, not a TSK — refusing to publish', kind: 'permanent', code: 'malformed-backup' },
  { name: 'parse failure', input: 'parse TSK: bad packet', kind: 'permanent', code: 'malformed-data' },
  { name: 'not valid', input: 'armor is not valid', kind: 'permanent', code: 'malformed-data' },
  { name: 'openpgp.js during parsing', input: new Error('Error during parsing. This message / key probably does not conform to a valid OpenPGP format.'), kind: 'permanent', code: 'malformed-data' },
  { name: 'Sequoia malformed packet', input: 'Malformed packet: Malformed CTB: MSB of ptag not set', kind: 'permanent', code: 'malformed-data' },
  // XMPP stanza errors
  { name: 'item-not-found', input: 'item-not-found', kind: 'permanent', code: 'not-found' },
  { name: 'feature-not-implemented', input: 'feature-not-implemented', kind: 'permanent', code: 'pep-unsupported' },
  { name: 'server does not advertise PEP', input: 'server does not advertise PEP', kind: 'permanent', code: 'pep-unsupported' },
  { name: 'key-locked', input: new Error('key-locked'), kind: 'transient', code: 'key-locked' },
  // Rust: join errors
  { name: 'task panicked', input: 'backup import task panicked: oops', kind: 'transient', code: 'ipc-panic' },
  { name: 'timeout', input: new Error('request timeout'), kind: 'transient', code: 'timeout' },
  { name: 'timed out', input: 'keychain read timed out', kind: 'transient', code: 'timeout' },
  { name: 'remote-server-timeout', input: 'remote-server-timeout', kind: 'transient', code: 'timeout' },
  { name: 'remote-server-not-found', input: 'remote-server-not-found', kind: 'transient', code: 'server-unreachable' },
  { name: 'service-unavailable', input: 'service-unavailable', kind: 'transient', code: 'server-unreachable' },
  { name: 'internal-server-error', input: 'internal-server-error', kind: 'transient', code: 'server-error' },
  { name: 'resource-constraint', input: 'resource-constraint', kind: 'transient', code: 'server-error' },
  { name: 'unrecognised text', input: new Error('something else entirely'), kind: 'transient', code: 'unknown' },
  { name: 'non-Error input', input: { weird: true }, kind: 'transient', code: 'unknown' },
  // First match wins where a message could match two branches.
  { name: 'wrong passphrase beats parse', input: 'parse error: no SKESK matched', kind: 'permanent', code: 'wrong-passphrase' },
  { name: 'unavailable storage beats timeout', input: 'openpgp-storage-unavailable: timed out', kind: 'permanent', code: 'key-storage-unavailable' },
  { name: 'matching is case-insensitive', input: 'KEY-LOCKED', kind: 'transient', code: 'key-locked' },
]

describe('classifyBoundaryError', () => {
  it.each(rows)('$name -> $code', ({ input, kind, code }) => {
    expect(classifyBoundaryError(input)).toEqual({ kind, code })
  })
})
