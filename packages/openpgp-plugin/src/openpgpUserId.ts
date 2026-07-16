/**
 * Canonical XEP-0373 §8.5 trust-anchor User ID for an account or peer JID.
 *
 * The spec requires the bare `xmpp:user@domain` form with NO real-name
 * component — "the XMPP address is the only trust anchor here" — so both the
 * Sequoia (desktop) and openpgp.js (web) key generators emit exactly this
 * string, and peer-key verification matches against it.
 *
 * This is the single source of truth: key generation and verification both
 * route through it so they can never drift. A divergence here would silently
 * break cross-client verification (a web-generated key failing on desktop, or
 * vice-versa).
 *
 * NOTE: the Rust prewarm path (`src-tauri/src/main.rs`, `format!("xmpp:{jid}")`)
 * mirrors this in another language and must be kept in sync by hand.
 */
export function accountUserId(jid: string): string {
  return `xmpp:${jid}`
}
