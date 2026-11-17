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

/**
 * Build the `<pubkey-metadata>` fingerprint attribute(s) for an own-key
 * publish, choosing the attribute that matches the key version.
 *
 * An OpenPGP v4 fingerprint is 40 hex chars (SHA-1); a v6 fingerprint is 64
 * hex chars (SHA-256). Earlier code emitted BOTH `v4-fingerprint` and
 * `v6-fingerprint` set to the same value, which advertises a malformed
 * 40-hex `v6-fingerprint` for the v4 keys openpgp.js produces. Emit only the
 * version-appropriate attribute so peers never read a bogus v6 fingerprint
 * (parsers prefer `v6-fingerprint` over `v4-fingerprint`).
 */
export function pubkeyMetadataFingerprintAttrs(fingerprint: string): Record<string, string> {
  const fp = toXep0373Fingerprint(fingerprint)
  return fp.length === 64 ? { 'v6-fingerprint': fp } : { 'v4-fingerprint': fp }
}
