import { getBareJid } from '../core/jid'

let currentStorageScopeJid: string | null = null

function normalizeScopeJid(jid: string | null | undefined): string | null {
  if (!jid) return null
  const bare = getBareJid(jid).trim()
  return bare.length > 0 ? bare : null
}

/**
 * Get the current account storage scope (bare JID), if any.
 */
export function getStorageScopeJid(): string | null {
  return currentStorageScopeJid
}

/**
 * Set the active account storage scope.
 * Returns the normalized bare JID that was stored.
 */
export function setStorageScopeJid(jid: string | null | undefined): string | null {
  currentStorageScopeJid = normalizeScopeJid(jid)
  return currentStorageScopeJid
}

/**
 * Build a storage key scoped to a JID.
 * If no scope is available, returns the base key unchanged for backwards compatibility.
 */
export function buildScopedStorageKey(baseKey: string, jid?: string | null): string {
  const scope = normalizeScopeJid(jid ?? currentStorageScopeJid)
  return scope ? `${baseKey}:${scope}` : baseKey
}

/**
 * Testing helper: clear the in-memory storage scope.
 * @internal
 */
export function _resetStorageScopeForTesting(): void {
  currentStorageScopeJid = null
}
