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
} from '@fluux/sdk'
import { clearSession, getSession } from '@/hooks/useSessionPersistence'
import { deleteCredentials } from '@/utils/keychain'

/** localStorage keys containing user data (not app preferences) */
const USER_DATA_KEYS = [
  'xmpp-last-jid',
  'xmpp-last-server',
  'xmpp-remember-me',
  'xmpp-has-saved-credentials',
]

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
    console.log('[Fluux] clearLocalData: stores reset')

    // 3. Clear app-specific localStorage user data keys
    USER_DATA_KEYS.forEach((key) => localStorage.removeItem(key))

    // 4. Delete OS keychain credentials (desktop only, no-op on web)
    // Force deletion even if localStorage flags were already cleared above.
    await deleteCredentials({ force: true })
    console.log('[Fluux] clearLocalData: keychain done')

    // 5. Clear avatar cache only for explicit full wipe.
    //    Avatar cache is currently global; account-scoped deletion is not supported yet.
    //    Note: chatStore.reset() already handles clearing the message cache.
    if (allAccounts) {
      await clearAllAvatarData()
    }
    console.log('[Fluux] clearLocalData: complete')
  } finally {
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
