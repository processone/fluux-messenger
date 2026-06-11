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
