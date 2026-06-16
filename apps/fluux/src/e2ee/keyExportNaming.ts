/**
 * Descriptive, cross-platform-safe filenames for exported OpenPGP key files.
 *
 * Embedding the account JID makes the file self-describing once it lands in an
 * external tool (gpg, OpenKeychain, Kleopatra) and stops exports for different
 * accounts from colliding on a generic `openpgp-private-key.asc`. The key's
 * own User ID is the bare `xmpp:user@domain` (XEP-0373 §8.5, no real name), so
 * the receiving tool has nothing human-friendly to name the file from — the
 * filename is the only place we can surface which account a key belongs to.
 */

/** Filename stem per export flavour. */
export type KeyExportKind = 'openpgp-private-key' | 'openpgp-backup'

/**
 * Build the suggested filename for an exported key.
 *
 * @param kind  the export flavour (used as the filename stem)
 * @param jid   the account bare JID the key belongs to
 * @returns e.g. `openpgp-private-key-alice@example.org.asc`; falls back to
 *          `<kind>.asc` when the JID sanitizes to nothing
 */
export function keyExportFilename(kind: KeyExportKind, jid: string): string {
  const safeJid = sanitizeForFilename(jid)
  return safeJid ? `${kind}-${safeJid}.asc` : `${kind}.asc`
}

/**
 * Reduce a JID to characters every major filesystem accepts. Letters, digits
 * and the readable JID punctuation (`. _ @ + -`) are kept; anything else
 * (notably `/`, `\`, `:` and resource separators) becomes `_`. Runs are
 * collapsed and leading/trailing separators trimmed so we never emit a hidden
 * file (`.foo`) or a `..` path segment.
 */
function sanitizeForFilename(jid: string): string {
  return jid
    .trim()
    .replace(/[^A-Za-z0-9._@+-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '')
}
