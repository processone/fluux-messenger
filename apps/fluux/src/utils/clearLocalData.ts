import {
  chatStore,
  roomStore,
  connectionStore,
  rosterStore,
  eventsStore,
  consoleStore,
  adminStore,
  blockingStore,
  clearAllAvatarData,
  getBareJid,
  deleteFastToken,
  clearSearchIndex,
  clearUserAgentIdentity,
} from '@fluux/sdk'
import { clearSession, getSession } from '@/hooks/useSessionPersistence'
import { deleteCredentials } from '@/utils/keychain'
import { clearMediaCache } from '@/utils/mediaCache'
import { clearCachedPassphrase, clearAllCachedPassphrases } from '@/e2ee/webPassphraseCache'

/** localStorage keys containing user data (not app preferences) */
const USER_DATA_KEYS = [
  'xmpp-last-jid',
  'xmpp-last-server',
  'xmpp-remember-me',
  'xmpp-has-saved-credentials',
]

/**
 * Drop the credential that enables silent auto-reconnection for one account
 * (the XEP-0484 FAST token).
 *
 * Synchronous and reload-safe by design: the logout flow must run this BEFORE
 * the Tauri webview reload triggered by LoginScreen (the WRY event-delivery
 * workaround). That reload resets `useSessionPersistence`'s once-per-startup
 * guard, so without dropping the token first the post-reload auto-connect path
 * would silently re-authenticate the user we just logged out.
 *
 * Unlike `clearLocalData`, this preserves messages, cache, roster, and the
 * `xmpp-last-jid` / `xmpp-last-server` login-form prefill.
 */
export function clearAutoReconnectCredentials(jid: string | null): void {
  if (!jid) return
  deleteFastToken(getBareJid(jid))
}

interface ClearLocalDataOptions {
  /**
   * When true, clears all local account data.
   * Use for CLI --clear-storage and explicit full wipes only.
   */
  allAccounts?: boolean
}

/**
 * Clear all local user data (localStorage, sessionStorage, IndexedDB).
 * Preserves app preferences (theme, language, time format).
 *
 * Call on disconnect when the user opts to clean local data.
 */
export async function clearLocalData(options: ClearLocalDataOptions = {}): Promise<void> {
  const allAccounts = options.allAccounts ?? false
  const session = getSession()
  const scopedJid = session?.jid ? getBareJid(session.jid) : null

  console.log(`[Fluux] clearLocalData: starting (${allAccounts ? 'all accounts' : (scopedJid ?? 'current account')})`)

  try {
    // 1. Clear SDK sessionStorage keys
    // - account-scoped on regular logout
    // - all accounts for CLI --clear-storage
    if (allAccounts) {
      clearAllFluuxSessionStorageKeys()
    } else {
      clearScopedFluuxSessionStorageKeys(scopedJid)
    }

    // 2. Reset Zustand stores (clears in-memory state + their localStorage)
    //    chatStore.reset() clears 'xmpp-chat-storage' localStorage + IndexedDB messages
    //    roomStore.reset() clears 'fluux-room-drafts' localStorage
    chatStore.getState().reset()
    roomStore.getState().reset()
    connectionStore.getState().reset()
    rosterStore.getState().reset()
    eventsStore.getState().reset()
    consoleStore.getState().reset()
    adminStore.getState().reset()
    blockingStore.getState().reset()
    // Clear search index (IndexedDB)
    await clearSearchIndex()
    console.log('[Fluux] clearLocalData: stores reset')

    // 3. Clear FAST tokens (XEP-0484) from localStorage
    if (allAccounts) {
      const fastTokenKeys: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key?.startsWith('fluux:fast-token:')) {
          fastTokenKeys.push(key)
        }
      }
      fastTokenKeys.forEach((key) => localStorage.removeItem(key))
      // Full wipe: also reset the SASL2 user-agent identity so the next
      // login presents a fresh device to the server. On per-account logout
      // we keep the id (same device, tokens are already scoped by JID).
      clearUserAgentIdentity()
    } else if (scopedJid) {
      deleteFastToken(scopedJid)
    }

    // 4. Clear app-specific localStorage user data keys
    USER_DATA_KEYS.forEach((key) => localStorage.removeItem(key))

    // 5. Delete OS keychain credentials (desktop only, no-op on web)
    // Force deletion even if localStorage flags were already cleared above.
    await deleteCredentials({ force: true })
    console.log('[Fluux] clearLocalData: keychain done')

    // 6. Clear avatar cache only for explicit full wipe.
    //    Avatar cache is currently global; account-scoped deletion is not supported yet.
    //    Note: chatStore.reset() already handles clearing the message cache.
    if (allAccounts) {
      await clearAllAvatarData()
      await clearMediaCache()
      await clearAllCachedPassphrases()
    } else if (scopedJid) {
      await clearCachedPassphrase(scopedJid)
    }
    console.log('[Fluux] clearLocalData: complete')
  } finally {
    // 7. Reset URL to clear any stale conversation/room JID from the hash.
    // After clearing all data, the URL may still contain a JID (e.g., #/messages/user@example.com)
    // that no longer exists in the empty stores, causing a blank screen on re-login.
    if (window.location.hash && window.location.hash !== '#/' && window.location.hash !== '#/messages') {
      window.location.hash = '#/messages'
    }

    // Clear app-level session keys last so the logout transition happens
    // after cleanup has run.
    clearSession(allAccounts ? { allAccounts: true } : undefined)
  }
}

/**
 * Clear scoped SDK sessionStorage keys for one account.
 */
function clearScopedFluuxSessionStorageKeys(jid: string | null): void {
  if (!jid) return

  const keys = [
    `fluux:session:${jid}`,
    `fluux:roster:${jid}`,
    `fluux:rooms:${jid}`,
    `fluux:server-info:${jid}`,
    `fluux:profile:${jid}`,
  ]

  keys.forEach((key) => sessionStorage.removeItem(key))
}

/**
 * Clear all fluux: prefixed keys from sessionStorage (all accounts).
 */
function clearAllFluuxSessionStorageKeys(): void {
  const keysToRemove: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i)
    if (key?.startsWith('fluux:')) {
      keysToRemove.push(key)
    }
  }
  keysToRemove.forEach((key) => sessionStorage.removeItem(key))
}
