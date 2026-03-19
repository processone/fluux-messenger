/**
 * FAST Token Storage (XEP-0484)
 *
 * Provides localStorage-backed persistence for FAST authentication tokens.
 * Tokens allow password-less reconnection for up to 14 days on web.
 *
 * Storage key pattern: `fluux:fast-token:{bare-jid}`
 * Token format: { mechanism, token, expiry } as JSON
 *
 * @see https://xmpp.org/extensions/xep-0484.html
 */

const STORAGE_PREFIX = 'fluux:fast-token:'

/** Maximum client-side token lifetime: 14 days */
const MAX_TTL_MS = 14 * 24 * 60 * 60 * 1000

export interface FastToken {
  /** SASL mechanism the token is bound to (e.g., 'HT-SHA-256-NONE') */
  mechanism: string
  /** The opaque token string issued by the server */
  token: string
  /** ISO 8601 expiry timestamp */
  expiry: string
}

function storageKey(jid: string): string {
  return `${STORAGE_PREFIX}${jid}`
}

/**
 * Save a FAST token to localStorage for the given JID.
 *
 * The expiry is capped at 14 days from now. If the server provides
 * an earlier expiry, that is preserved.
 */
export function saveFastToken(
  jid: string,
  tokenData: { mechanism: string; token: string; expiry?: string }
): void {
  const maxExpiry = new Date(Date.now() + MAX_TTL_MS).toISOString()
  let expiry = maxExpiry

  if (tokenData.expiry) {
    const serverExpiry = new Date(tokenData.expiry)
    if (!isNaN(serverExpiry.getTime()) && serverExpiry.toISOString() < maxExpiry) {
      expiry = serverExpiry.toISOString()
    }
  }

  const stored: FastToken = {
    mechanism: tokenData.mechanism,
    token: tokenData.token,
    expiry,
  }

  try {
    localStorage.setItem(storageKey(jid), JSON.stringify(stored))
  } catch {
    // localStorage full or unavailable — token won't persist
  }
}

/**
 * Retrieve a FAST token from localStorage for the given JID.
 *
 * Returns null if no token exists or the token has expired.
 * Expired tokens are auto-deleted (lazy cleanup).
 */
export function fetchFastToken(jid: string): FastToken | null {
  try {
    const raw = localStorage.getItem(storageKey(jid))
    if (!raw) return null

    const stored: FastToken = JSON.parse(raw)

    // Validate required fields
    if (!stored.mechanism || !stored.token || !stored.expiry) {
      localStorage.removeItem(storageKey(jid))
      return null
    }

    // Check expiry
    if (new Date(stored.expiry) <= new Date()) {
      localStorage.removeItem(storageKey(jid))
      return null
    }

    return stored
  } catch {
    // Corrupted data — clean up
    localStorage.removeItem(storageKey(jid))
    return null
  }
}

/**
 * Delete the FAST token for the given JID from localStorage.
 */
export function deleteFastToken(jid: string): void {
  localStorage.removeItem(storageKey(jid))
}

/**
 * Check whether a non-expired FAST token exists for the given JID.
 *
 * This only checks client-side token existence and expiry.
 * Server-side FAST support is verified during SASL2 negotiation by xmpp.js.
 */
export function hasFastToken(jid: string): boolean {
  return fetchFastToken(jid) !== null
}
