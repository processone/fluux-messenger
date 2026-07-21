import { useCallback } from 'react'
import { adminStore } from '../stores/adminStore'
import { useAdminStore } from '../react/storeHooks'
import { USER_COMMANDS } from './adminCommands'

/**
 * Focused subscription for admin permission checks.
 *
 * Returns the three values needed to gate admin UI in normal product code:
 * `isAdmin`, `hasUserCommands`, and `canManageUser(jid)`. Subscribes only to
 * the admin store fields these depend on — not to the full admin state that
 * `useAdmin()` exposes (sessions, command queues, user/room lists, vhosts,
 * pagination, etc.).
 *
 * Use this in list items (e.g. `ContactItem`) where each row would otherwise
 * subscribe to the whole admin store via `useAdmin()`.
 *
 * @category Hooks
 */
export function useAdminPermissions() {
  const isAdmin = useAdminStore((s) => s.isAdmin)
  // Boolean reduction — Zustand only re-renders when the value flips, even
  // though the selector re-runs on every commands change.
  const hasUserCommands = useAdminStore((s) =>
    s.commands.some((cmd) => USER_COMMANDS.has(cmd.node))
  )
  const canManageUser = useCallback((userJid: string): boolean => {
    const store = adminStore.getState()
    const domain = userJid.split('@')[1]?.split('/')[0]
    if (!domain) return false
    const adminVhosts = store.vhosts
    if (adminVhosts.length === 0) return store.isAdmin
    return adminVhosts.includes(domain)
  }, [])

  return { isAdmin, hasUserCommands, canManageUser }
}
