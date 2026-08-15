/**
 * FAST Token Storage (XEP-0484)
 *
 * Browser clients persist tokens in localStorage. Headless runtimes use a
 * process-local in-memory adapter unless the caller injects another one.
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

/**
 * Synchronous persistence seam for XEP-0484 FAST tokens.
 *
 * Deletion is synchronous because explicit logout must remove the local token
 * before any reconnect path can observe it.
 */
export interface FastTokenStorageAdapter {
  getToken(jid: string): FastToken | null
  setToken(jid: string, token: FastToken): void
  deleteToken(jid: string): void
}

function storageKey(jid: string): string {
  return `${STORAGE_PREFIX}${jid}`
}

/** Create isolated, process-local FAST token storage. */
export function createInMemoryFastTokenStorage(): FastTokenStorageAdapter {
  const tokens = new Map<string, FastToken>()

  return {
    getToken: (jid) => tokens.get(jid) ?? null,
    setToken: (jid, token) => { tokens.set(jid, token) },
    deleteToken: (jid) => { tokens.delete(jid) },
  }
}

const browserFastTokenStorage: FastTokenStorageAdapter = {
  getToken(jid) {
    const key = storageKey(jid)
    const raw = window.localStorage.getItem(key)
    if (!raw) return null

    try {
      return JSON.parse(raw) as FastToken
    } catch {
      window.localStorage.removeItem(key)
      return null
    }
  },
  setToken(jid, token) {
    window.localStorage.setItem(storageKey(jid), JSON.stringify(token))
  },
  deleteToken(jid) {
    window.localStorage.removeItem(storageKey(jid))
  },
}

const headlessFastTokenStorage = createInMemoryFastTokenStorage()

function getDefaultFastTokenStorage(): FastTokenStorageAdapter {
  return typeof window === 'undefined'
    ? headlessFastTokenStorage
    : browserFastTokenStorage
}

function removeInvalidToken(jid: string, storage: FastTokenStorageAdapter): void {
  try {
    storage.deleteToken(jid)
  } catch {
    // Storage is unavailable; there is nothing else to clean up.
  }
}

/**
 * Save a FAST token for the given JID.
 *
 * The expiry is capped at 14 days from now. If the server provides an earlier
 * expiry, that is preserved.
 */
export function saveFastToken(
  jid: string,
  tokenData: { mechanism: string; token: string; expiry?: string },
  storage: FastTokenStorageAdapter = getDefaultFastTokenStorage(),
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
    storage.setToken(jid, stored)
  } catch {
    // Storage is full or unavailable; authentication can continue without persistence.
  }
}

/**
 * Retrieve a FAST token for the given JID.
 *
 * Returns null if no token exists or the token has expired. Invalid and
 * expired tokens are removed lazily.
 */
export function fetchFastToken(
  jid: string,
  storage: FastTokenStorageAdapter = getDefaultFastTokenStorage(),
): FastToken | null {
  let stored: FastToken | null

  try {
    stored = storage.getToken(jid)
  } catch {
    return null
  }

  if (!stored) return null

  if (!stored.mechanism || !stored.token || !stored.expiry) {
    removeInvalidToken(jid, storage)
    return null
  }

  if (new Date(stored.expiry) <= new Date()) {
    removeInvalidToken(jid, storage)
    return null
  }

  return stored
}

/**
 * Delete the FAST token for the given JID.
 *
 * Returns false when the adapter throws, allowing logout callers to combine
 * local deletion with server-side invalidation without reporting false success.
 */
export function deleteFastToken(
  jid: string,
  storage: FastTokenStorageAdapter = getDefaultFastTokenStorage(),
): boolean {
  try {
    storage.deleteToken(jid)
    return true
  } catch {
    return false
  }
}

/** Check whether a non-expired FAST token exists for the given JID. */
export function hasFastToken(
  jid: string,
  storage: FastTokenStorageAdapter = getDefaultFastTokenStorage(),
): boolean {
  return fetchFastToken(jid, storage) !== null
}
