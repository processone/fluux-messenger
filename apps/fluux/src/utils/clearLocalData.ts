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
} from '@fluux/sdk'
import { clearSession } from '@/hooks/useSessionPersistence'
import { deleteCredentials } from '@/utils/keychain'

/** localStorage keys containing user data (not app preferences) */
const USER_DATA_KEYS = [
  'xmpp-last-jid',
  'xmpp-last-server',
  'xmpp-remember-me',
  'xmpp-has-saved-credentials',
]

/**
 * Clear all local user data (localStorage, sessionStorage, IndexedDB).
 * Preserves app preferences (theme, language, time format).
 *
 * Call on disconnect when the user opts to clean local data.
 */
export async function clearLocalData(): Promise<void> {
  console.log('[Fluux] clearLocalData: starting')

  try {
    // 1. Clear SDK sessionStorage keys (fluux:session:{jid}, fluux:presence-machine, etc.)
    clearFluuxSessionStorageKeys()

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

    // 5. Clear IndexedDB avatar cache (blobs, hash mappings, no-avatar entries)
    //    Note: chatStore.reset() already handles clearing the message cache
    await clearAllAvatarData()
    console.log('[Fluux] clearLocalData: complete')
  } finally {
    // Clear app-level session keys last so the logout transition happens
    // after cleanup has run.
    clearSession()
  }
}

/**
 * Clear all fluux: prefixed keys from sessionStorage.
 * These are created by the SDK's sessionStorageAdapter and presence machine.
 */
function clearFluuxSessionStorageKeys(): void {
  const keysToRemove: string[] = []
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i)
    if (key?.startsWith('fluux:')) {
      keysToRemove.push(key)
    }
  }
  keysToRemove.forEach((key) => sessionStorage.removeItem(key))
}
