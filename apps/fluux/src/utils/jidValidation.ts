/**
 * Local, network-free validation of the login JID field (UX_REVIEW §1.4).
 *
 * Catches a typo'd JID before a connection round-trip. Deliberately permissive
 * on the domain (XMPP allows a single-label host such as `localhost`) and on an
 * optional resource, but strict on the `local@domain` skeleton and on the
 * characters RFC 7622 forbids in the localpart.
 *
 * `reason: 'empty'` lets the UI gate the Connect button without nagging the user
 * about a field they simply haven't filled yet; `reason: 'malformed'` is the
 * case worth surfacing inline help for.
 */
export type JidValidation = { valid: true } | { valid: false; reason: 'empty' | 'malformed' }

// RFC 7622 §3.3.1 — characters disallowed in a localpart (resource separator
// '/' and the '@' delimiter are checked structurally below).
const FORBIDDEN_LOCALPART_CHARS = /["&'<>:]/

export function validateBareJid(input: string): JidValidation {
  const jid = input.trim()
  if (jid.length === 0) return { valid: false, reason: 'empty' }

  if (/\s/.test(jid)) return { valid: false, reason: 'malformed' }

  const atParts = jid.split('@')
  if (atParts.length !== 2) return { valid: false, reason: 'malformed' }

  const [localpart, domainAndResource] = atParts
  if (localpart.length === 0) return { valid: false, reason: 'malformed' }
  if (FORBIDDEN_LOCALPART_CHARS.test(localpart)) return { valid: false, reason: 'malformed' }

  // Domain is everything up to an optional '/resource'; it must be non-empty.
  const domain = domainAndResource.split('/')[0]
  if (domain.length === 0) return { valid: false, reason: 'malformed' }

  return { valid: true }
}
