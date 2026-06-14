/**
 * Canonical fingerprint comparison for trust decisions.
 *
 * OpenPGP backends format fingerprints differently: Sequoia/Rust (the native
 * Tauri client) emits UPPERCASE hex, openpgp.js (the web client) emits
 * lowercase, and some sources add whitespace separators. A fingerprint
 * verified on one backend and synced cross-device (verificationSync.ts) is
 * stored verbatim, so a trust check that uses raw `===` would read a
 * verification made on desktop as unverified on the web client.
 *
 * Every trust-decision site — the chip's `verified` derivation
 * (useConversationEncryptionState) and `isPeerVerified` (which drives the
 * inbound message SecurityContext) — must compare through this helper, the
 * same normalization the sync layer already applies.
 */

/** Strip whitespace and lower-case so backend formatting can't affect equality. */
export function normalizeFingerprint(fingerprint: string): string {
  return fingerprint.replace(/\s+/g, '').toLowerCase()
}

/** Case- and whitespace-insensitive fingerprint equality. */
export function fingerprintsEqual(a: string, b: string): boolean {
  return normalizeFingerprint(a) === normalizeFingerprint(b)
}

/**
 * Canonical XEP-0373 wire form: strip whitespace and UPPER-case the hex.
 *
 * XEP-0373 §4.1 mandates that the OpenPGP v4 fingerprint string — used both as
 * the `urn:xmpp:openpgp:0:public-keys:<FINGERPRINT>` data node id and as the
 * `v4-fingerprint` metadata attribute — is "encoded as a hexadecimal string
 * using upper case characters". openpgp.js (the web backend) emits lower-case,
 * so own-key PEP publishing must canonicalise through this helper. Idempotent
 * for the native Sequoia backend, which already emits upper-case.
 */
export function toXep0373Fingerprint(fingerprint: string): string {
  return fingerprint.replace(/\s+/g, '').toUpperCase()
}
