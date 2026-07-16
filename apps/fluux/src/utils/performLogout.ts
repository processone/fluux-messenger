import { connectionStore, getBareJid } from '@fluux/sdk'
import { clearSession } from '@/hooks/useSessionPersistence'
import { deleteCredentials } from '@/utils/keychain'
import { clearLocalData, clearAutoReconnectCredentials } from '@/utils/clearLocalData'
import { markLoggedOut } from '@/utils/reconnectIntent'
import { clearCachedPassphrase } from '@fluux/openpgp-plugin'

const LOGOUT_DISCONNECT_TIMEOUT_MS = 2500
const LOGOUT_KEYCHAIN_TIMEOUT_MS = 2500

export interface PerformLogoutDeps {
  /** Disconnect the live client. Resolves once the server round-trip settles. */
  disconnect: (options?: { invalidateFastToken?: boolean }) => Promise<void>
  /** Bare/full JID of the account being logged out (for FAST-token cleanup). */
  jid: string | null
  /** When true, wipe all local account data; otherwise keep messages/cache. */
  shouldCleanLocalData: boolean
}

/**
 * Single, idempotent logout operation.
 *
 * The first thing it does — synchronously, before any await, cleanup, or the
 * post-logout webview reload — is record the logout intent. The auto-reconnect
 * engines (`useSessionPersistence`, LoginScreen's keychain auto-connect) refuse
 * to reconnect while that intent is set, so logout sticks even if a credential
 * survives cleanup or a reload races the deletions. The credential deletions
 * below are now defense-in-depth rather than the load-bearing prevention.
 *
 * Every step is bounded by a timeout so a stalled keychain or socket can never
 * trap the user in ChatLayout: the reactive `disconnected` status (set by
 * `disconnect()`) routes to LoginScreen regardless of cleanup progress.
 */
export async function performLogout({ disconnect, jid, shouldCleanLocalData }: PerformLogoutDeps): Promise<void> {
  // 1. Record logout intent FIRST — see module docstring. Must precede any await.
  markLoggedOut()
  // Forget any 24h-cached web passphrase: a deliberate logout should not leave
  // the key unlockable without re-entry. Best-effort; never blocks logout. On
  // desktop there is no record, so this is a harmless no-op.
  if (jid) void clearCachedPassphrase(getBareJid(jid))

  // 2. Always attempt disconnect first. Request FAST token invalidation
  //    (XEP-0484 §6) so the server drops any stored token instead of leaving
  //    it usable until expiry.
  const disconnectSettled = await Promise.race([
    disconnect({ invalidateFastToken: true })
      .then(() => 'done' as const)
      .catch(() => 'error' as const),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), LOGOUT_DISCONNECT_TIMEOUT_MS)
    }),
  ])
  if (disconnectSettled === 'timeout') {
    console.warn(
      `[Fluux] Logout: disconnect timed out after ${LOGOUT_DISCONNECT_TIMEOUT_MS}ms, continuing cleanup`
    )
  }

  // 3. Clear persisted session immediately so the UI can leave ChatLayout even
  //    if OS keychain or storage cleanup stalls on this platform.
  clearSession()

  if (shouldCleanLocalData) {
    // clearLocalData() clears session at the end of cleanup.
    await clearLocalData().catch(() => {})
    return
  }

  // 4. Keep-data path: drop the FAST token synchronously (defense-in-depth
  //    alongside the intent flag) and reset connection store state so the next
  //    login starts fresh. (App's route to LoginScreen is driven by the
  //    'disconnected' status from disconnect() above, not by this reset.)
  clearAutoReconnectCredentials(jid)
  connectionStore.getState().reset()

  const keychainSettled = await Promise.race([
    deleteCredentials().then(() => 'done' as const).catch(() => 'error' as const),
    new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), LOGOUT_KEYCHAIN_TIMEOUT_MS)
    }),
  ])
  if (keychainSettled === 'timeout') {
    console.warn(
      `[Fluux] Logout: keychain cleanup timed out after ${LOGOUT_KEYCHAIN_TIMEOUT_MS}ms`
    )
  }
}
