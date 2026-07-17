/**
 * Backup-passphrase handling for the XEP-0373 §5 secret-key flow.
 *
 * The backup passphrase is opaque key material: whatever is displayed to
 * the user is what every XEP-0373 client must feed the SKESK S2K,
 * byte for byte. Fluux ≤0.17.1 normalized it (NFKD → lowercase →
 * whitespace collapse) before encrypting, so the passphrase shown to the
 * user failed in Gajim and other spec-compliant clients (#1021).
 *
 * The canonical rule is now "use it as-is": {@link prepareBackupPassphrase}
 * only trims surrounding whitespace (paste artifacts). The old transform
 * survives as {@link legacyNormalizeBackupPassphrase}, used exclusively to
 * open already-published legacy backups so they can be healed.
 */

/**
 * Canonical form of a backup passphrase: verbatim, minus surrounding
 * whitespace. Mirrors the Rust side's `prepare_passphrase` in
 * `openpgp_backup.rs` — the two must stay byte-identical.
 */
export function prepareBackupPassphrase(raw: string): string {
  return raw.trim()
}

/**
 * The pre-0.17.2 normalization: NFKD → lowercase → collapse any Unicode
 * whitespace run to a single ASCII space. Kept ONLY as a decrypt fallback
 * for backups published by older Fluux versions; never used to encrypt.
 */
export function legacyNormalizeBackupPassphrase(raw: string): string {
  return raw.normalize('NFKD').toLowerCase().split(/\s+/).filter(Boolean).join(' ')
}
