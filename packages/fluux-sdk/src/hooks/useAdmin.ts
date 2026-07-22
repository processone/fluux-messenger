import { useCallback, useMemo, useRef } from 'react'
import { adminStore } from '../stores/adminStore'
import { LastActivityQueue } from '../core/admin/lastActivityQueue'
import { useAdminStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { AdminCommand, AdminCommandCategory, AdminCategory, RSMRequest } from '../core/types'
import { USER_COMMANDS } from './adminCommands'

/**
 * Hook for server administration via XEP-0050 Ad-Hoc Commands.
 *
 * Provides access to server admin commands discovered via Service Discovery.
 * Only available to users with admin privileges on the XMPP server.
 * Commands are executed as multi-step forms following the XEP-0050 protocol.
 *
 * @returns An object containing admin state, commands, and actions
 *
 * @example Checking admin status
 * ```tsx
 * function AdminPanel() {
 *   const { isAdmin, hasCommands } = useAdmin()
 *
 *   if (!isAdmin || !hasCommands) {
 *     return <p>Admin access not available</p>
 *   }
 *
 *   return <AdminDashboard />
 * }
 * ```
 *
 * @example Listing available commands by category
 * ```tsx
 * function CommandList() {
 *   const { commandsByCategory, executeCommand } = useAdmin()
 *
 *   return (
 *     <div>
 *       <h3>User Commands</h3>
 *       <ul>
 *         {commandsByCategory.user.map(cmd => (
 *           <li key={cmd.node}>
 *             <button onClick={() => executeCommand(cmd.node)}>
 *               {cmd.name}
 *             </button>
 *           </li>
 *         ))}
 *       </ul>
 *     </div>
 *   )
 * }
 * ```
 *
 * @example Executing a command for a specific user
 * ```tsx
 * function UserActions({ userJid }: { userJid: string }) {
 *   const { userCommands, executeCommandForUser } = useAdmin()
 *
 *   const handleDelete = async () => {
 *     await executeCommandForUser(
 *       'http://jabber.org/protocol/admin#delete-user',
 *       userJid
 *     )
 *   }
 *
 *   return <button onClick={handleDelete}>Delete User</button>
 * }
 * ```
 *
 * @example Handling multi-step command forms
 * ```tsx
 * function CommandForm() {
 *   const { currentSession, submitForm, cancelCommand, canGoBack, previousStep } = useAdmin()
 *
 *   if (!currentSession?.form) return null
 *
 *   const handleSubmit = async (formData: Record<string, string>) => {
 *     await submitForm(formData)
 *   }
 *
 *   return (
 *     <form onSubmit={...}>
 *       {currentSession.form.fields.map(field => (
 *         <FormField key={field.var} field={field} />
 *       ))}
 *       {canGoBack && <button type="button" onClick={previousStep}>Back</button>}
 *       <button type="submit">Submit</button>
 *       <button type="button" onClick={cancelCommand}>Cancel</button>
 *     </form>
 *   )
 * }
 * ```
 *
 * @example Browsing users and rooms
 * ```tsx
 * function EntityBrowser() {
 *   const { userList, roomList, fetchUsers, fetchRooms, loadMoreUsers } = useAdmin()
 *
 *   useEffect(() => {
 *     fetchUsers()
 *     fetchRooms()
 *   }, [])
 *
 *   return (
 *     <div>
 *       <h3>Users ({userList.pagination.count})</h3>
 *       <ul>
 *         {userList.items.map(user => (
 *           <li key={user.jid}>{user.jid}</li>
 *         ))}
 *       </ul>
 *       {userList.pagination.last && (
 *         <button onClick={loadMoreUsers}>Load More</button>
 *       )}
 *     </div>
 *   )
 * }
 * ```
 *
 * @category Hooks
 */
export function useAdmin() {
  const { client } = useXMPPContext()

  const isAdmin = useAdminStore((s) => s.isAdmin)
  const commands = useAdminStore((s) => s.commands)
  const currentSession = useAdminStore((s) => s.currentSession)
  const isDiscovering = useAdminStore((s) => s.isDiscovering)
  const isExecuting = useAdminStore((s) => s.isExecuting)
  const targetJid = useAdminStore((s) => s.targetJid)
  const pendingSelectedUserJid = useAdminStore((s) => s.pendingSelectedUserJid)
  const stats = useAdminStore((s) => s.stats)
  const users = useAdminStore((s) => s.users)
  const vhosts = useAdminStore((s) => s.vhosts)
  const selectedVhost = useAdminStore((s) => s.selectedVhost)

  // Entity list state
  const activeCategory = useAdminStore((s) => s.activeCategory)
  const userList = useAdminStore((s) => s.userList)
  const roomList = useAdminStore((s) => s.roomList)
  const mucServiceJid = useAdminStore((s) => s.mucServiceJid)
  const serverStats = useAdminStore((s) => s.serverStats)
  const isLoadingStats = useAdminStore((s) => s.isLoadingStats)

  // Group commands by category
  const commandsByCategory = useMemo(() => {
    const grouped: Record<AdminCommandCategory, AdminCommand[]> = {
      user: [],
      stats: [],
      announcement: [],
      other: [],
    }

    for (const cmd of commands) {
      grouped[cmd.category].push(cmd)
    }

    return grouped
  }, [commands])

  // Commands that can be executed on a specific user (shown in contact profile)
  const userCommands = useMemo(() => {
    return commands.filter(cmd => USER_COMMANDS.has(cmd.node))
  }, [commands])

  // Execute a command
  const executeCommand = useCallback(
    async (node: string) => {
      return client.admin.executeAdminCommand(node, 'execute')
    },
    [client]
  )

  // Submit form data for current session
  const submitForm = useCallback(
    async (formData: Record<string, string | string[]>) => {
      const session = adminStore.getState().currentSession
      if (!session) {
        throw new Error('No active session')
      }

      // Determine action based on session state and available actions
      let action: 'complete' | 'next' = 'complete'
      if (session.actions?.includes('next')) {
        action = 'next'
      }

      return client.admin.executeAdminCommand(session.node, action, session.sessionId, formData)
    },
    [client]
  )

  // Go to previous step in multi-step command
  const previousStep = useCallback(async () => {
    const session = adminStore.getState().currentSession
    if (!session || !session.actions?.includes('prev')) {
      throw new Error('Cannot go to previous step')
    }

    return client.admin.executeAdminCommand(session.node, 'prev', session.sessionId)
  }, [client])

  // Cancel current command
  const cancelCommand = useCallback(async () => {
    await client.admin.cancelAdminCommand()
  }, [client])

  // Clear current session (for closing result views)
  const clearSession = useCallback(() => {
    adminStore.getState().setCurrentSession(null)
    adminStore.getState().setTargetJid(null)
  }, [])

  // Execute a command for a specific user (pre-fills accountjid)
  const executeCommandForUser = useCallback(
    async (node: string, jid: string) => {
      // Store the target JID for form pre-fill
      adminStore.getState().setTargetJid(jid)
      return client.admin.executeAdminCommand(node, 'execute')
    },
    [client]
  )

  // Add a new user
  const addUser = useCallback(
    async (username: string, password: string) => {
      const vhost = adminStore.getState().selectedVhost
      if (!vhost) {
        throw new Error('No virtual host selected')
      }
      const jid = `${username}@${vhost}`
      // Execute add-user command with form data directly
      return client.admin.executeAdminCommand(
        'http://jabber.org/protocol/admin#add-user',
        'execute',
        undefined,
        {
          accountjid: jid,
          password: password,
          'password-verify': password,
        }
      )
    },
    [client]
  )

  // Clear target JID
  const clearTargetJid = useCallback(() => {
    adminStore.getState().setTargetJid(null)
  }, [])

  // Clear pending selected user JID
  const clearPendingSelectedUserJid = useCallback(() => {
    adminStore.getState().setPendingSelectedUserJid(null)
  }, [])

  // Navigate to admin user management for a specific user
  // Returns the vhost if admin has rights, null otherwise
  const navigateToUserAdmin = useCallback((userJid: string): string | null => {
    const store = adminStore.getState()
    // Extract domain from JID
    const domain = userJid.split('@')[1]?.split('/')[0]
    if (!domain) return null

    // Check if admin has rights on this domain
    const adminVhosts = store.vhosts
    if (adminVhosts.length > 0 && !adminVhosts.includes(domain)) {
      // Admin doesn't have rights on this user's domain
      return null
    }

    // Set up navigation: select vhost, set pending user, switch to users category
    store.setSelectedVhost(domain)
    store.setPendingSelectedUserJid(userJid)
    store.setActiveCategory('users')

    return domain
  }, [])

  // Check if admin can manage a specific user (based on vhost rights)
  const canManageUser = useCallback((userJid: string): boolean => {
    const store = adminStore.getState()
    const domain = userJid.split('@')[1]?.split('/')[0]
    if (!domain) return false

    // If no vhosts discovered yet, or empty list, assume can manage (will be checked later)
    const adminVhosts = store.vhosts
    if (adminVhosts.length === 0) return store.isAdmin

    return adminVhosts.includes(domain)
  }, [])

  // Set selected virtual host
  const setSelectedVhost = useCallback((vhost: string | null) => {
    adminStore.getState().setSelectedVhost(vhost)
  }, [])

  // Set active category for entity list display
  const setActiveCategory = useCallback((category: AdminCategory | null) => {
    adminStore.getState().setActiveCategory(category)
  }, [])

  // Fetch structured server vital-signs for the overview dashboard.
  const fetchServerStats = useCallback(async () => {
    const store = adminStore.getState()
    store.setIsLoadingStats(true)
    try {
      return await client.admin.fetchServerStats(store.selectedVhost || undefined)
    } finally {
      adminStore.getState().setIsLoadingStats(false)
    }
  }, [client])

  // Fetch available virtual hosts
  const fetchVhosts = useCallback(async () => {
    return client.admin.fetchVhosts()
  }, [client])

  // Fetch user list with pagination
  const fetchUsers = useCallback(
    async (rsm?: RSMRequest) => {
      const store = adminStore.getState()
      store.setUserList({ isLoading: true, error: null })

      try {
        // Use selected vhost or fall back to default
        const vhost = store.selectedVhost || undefined
        const result = await client.admin.fetchUserList(vhost, rsm)
        if (rsm?.after) {
          // Appending to existing list
          store.appendUserList(result.users, result.pagination)
        } else {
          // Fresh fetch
          store.setUserList({
            items: result.users,
            pagination: result.pagination,
            isLoading: false,
            hasFetched: true,
          })
        }
        return result
      } catch (error) {
        store.setUserList({
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to fetch users',
          hasFetched: true,
        })
        throw error
      }
    },
    [client]
  )

  // Load more users (pagination helper)
  const loadMoreUsers = useCallback(async () => {
    const { pagination, isLoading } = adminStore.getState().userList
    if (isLoading || !pagination.last) return

    return fetchUsers({ after: pagination.last })
  }, [fetchUsers])

  // Search is fully client-side over the cached full set (see AdminView filter).
  const searchUsers = useCallback((query: string) => {
    adminStore.getState().setUserList({ searchQuery: query })
  }, [])

  // Reset user list
  const resetUserList = useCallback(() => {
    adminStore.getState().resetUserList()
  }, [])

  // Discover MUC service
  const discoverMucService = useCallback(async () => {
    return client.admin.discoverMucService()
  }, [client])

  // Fetch room list with pagination
  const fetchRooms = useCallback(
    async (rsm?: RSMRequest) => {
      const store = adminStore.getState()
      store.setRoomList({ isLoading: true, error: null })

      try {
        const result = await client.admin.fetchRoomList(undefined, rsm)
        if (rsm?.after) {
          // Appending to existing list
          store.appendRoomList(result.rooms, result.pagination)
        } else {
          // Fresh fetch
          store.setRoomList({
            items: result.rooms,
            pagination: result.pagination,
            isLoading: false,
            hasFetched: true,
          })
        }
        return result
      } catch (error) {
        store.setRoomList({
          isLoading: false,
          error: error instanceof Error ? error.message : 'Failed to fetch rooms',
          hasFetched: true,
        })
        throw error
      }
    },
    [client]
  )

  // Load more rooms (pagination helper)
  const loadMoreRooms = useCallback(async () => {
    const { pagination, isLoading } = adminStore.getState().roomList
    if (isLoading || !pagination.last) return

    return fetchRooms({ after: pagination.last })
  }, [fetchRooms])

  // Reset room list
  const resetRoomList = useCallback(() => {
    adminStore.getState().resetRoomList()
  }, [])

  // Get room options/configuration
  const getRoomOptions = useCallback(async (roomJid: string) => {
    return client.admin.fetchRoomOptions(roomJid)
  }, [client])

  // Fetch a user's last-login value (XEP-0133 get-user-lastlogin). The
  // result is a free-form, server-localized string — displayed as-is.
  const fetchUserLastLogin = useCallback(async (jid: string, lang?: string) => {
    return client.admin.fetchUserLastLogin(jid, lang)
  }, [client])

  // Check if a specific admin command is available
  const hasCommand = useCallback((commandName: string) => {
    return commands.some(cmd =>
      cmd.node === `api-commands/${commandName}` ||
      cmd.node.endsWith(`#${commandName}`)
    )
  }, [commands])

  // Queue ref for lazy last-activity fetches (constructed once, survives re-renders).
  const lastActivityQueueRef = useRef<LastActivityQueue | null>(null)

  // Fetch the entire user directory, then stamp a point-in-time online snapshot.
  const fetchAllUsers = useCallback(async () => {
    const store = adminStore.getState()
    store.setUserList({ isLoading: true, error: null })
    try {
      const vhost = store.selectedVhost || undefined
      const { users, truncated } = await client.admin.fetchAllUsers(vhost)

      // Online snapshot (only when the command is advertised). When unavailable,
      // leave isOnline undefined so the row hides the dot rather than showing gray.
      let stamped = users
      if (hasCommand('get-online-users-list')) {
        const online = await client.admin.fetchOnlineUserJids(vhost)
        adminStore.getState().setOnlineJids(online)
        stamped = users.map((u) => ({ ...u, isOnline: online.has(u.jid) }))
      } else {
        adminStore.getState().setOnlineJids(new Set())
      }

      adminStore.getState().setUserList({
        items: stamped,
        pagination: {},
        isLoading: false,
        hasFetched: true,
      })
      adminStore.getState().setUsersTruncated(truncated)
    } catch (error) {
      adminStore.getState().setUserList({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch users',
        hasFetched: true,
      })
      throw error
    }
  }, [client, hasCommand])

  // Lazily fetch a single user's last activity, behind a bounded queue.
  // Prefers the admin-authenticated get-user-lastlogin command (not subject
  // to the target's presence-subscription privacy gating) when the server
  // advertises it; falls back to the peer-to-peer XEP-0012 query otherwise.
  // The fetcher (and requested `lang`) is captured once, at first call — it
  // won't pick up a `hasCommand`/language change made after the queue is
  // constructed, matching this ref's existing lazy-init pattern.
  const requestLastActivity = useCallback((jid: string, lang?: string) => {
    const store = adminStore.getState()
    if (!store.lastActivitySupported) return
    if (store.onlineJids.has(jid)) return        // online overrides last-login
    if (store.lastActivity.has(jid)) return       // already loading/loaded

    if (!lastActivityQueueRef.current) {
      const useAdminCommand = hasCommand('get-user-lastlogin')
      lastActivityQueueRef.current = new LastActivityQueue({
        fetch: (j) => useAdminCommand
          ? client.admin.fetchUserLastLoginActivity(j, lang)
          : client.admin.fetchLastActivity(j),
        onResult: (j, seconds, raw) =>
          adminStore.getState().setLastActivity(j, { state: 'loaded', seconds, raw }),
        onUnsupported: () => adminStore.getState().setLastActivitySupported(false),
      })
    }

    store.setLastActivity(jid, { state: 'loading', seconds: null })
    lastActivityQueueRef.current.enqueue(jid)
  }, [client, hasCommand])

  // Memoize actions object to prevent re-renders when only state changes
  const actions = useMemo(
    () => ({
      executeCommand,
      executeCommandForUser,
      addUser,
      submitForm,
      previousStep,
      cancelCommand,
      clearSession,
      clearTargetJid,
      clearPendingSelectedUserJid,
      navigateToUserAdmin,
      canManageUser,
      setSelectedVhost,
      setActiveCategory,
      fetchServerStats,
      fetchVhosts,
      fetchUsers,
      fetchAllUsers,
      loadMoreUsers,
      searchUsers,
      requestLastActivity,
      resetUserList,
      discoverMucService,
      fetchRooms,
      loadMoreRooms,
      resetRoomList,
      getRoomOptions,
      fetchUserLastLogin,
      hasCommand,
    }),
    [
      executeCommand,
      executeCommandForUser,
      addUser,
      submitForm,
      previousStep,
      cancelCommand,
      clearSession,
      clearTargetJid,
      clearPendingSelectedUserJid,
      navigateToUserAdmin,
      canManageUser,
      setSelectedVhost,
      setActiveCategory,
      fetchServerStats,
      fetchVhosts,
      fetchUsers,
      fetchAllUsers,
      loadMoreUsers,
      searchUsers,
      requestLastActivity,
      resetUserList,
      discoverMucService,
      fetchRooms,
      loadMoreRooms,
      resetRoomList,
      getRoomOptions,
      fetchUserLastLogin,
      hasCommand,
    ]
  )

  // Memoize the entire return value to prevent render loops
  return useMemo(
    () => ({
      // State
      isAdmin,
      commands,
      commandsByCategory,
      userCommands,
      currentSession,
      isDiscovering,
      isExecuting,
      targetJid,
      pendingSelectedUserJid,
      stats,
      users,
      vhosts,
      selectedVhost,

      // Entity list state
      activeCategory,
      userList,
      roomList,
      mucServiceJid,
      serverStats,
      isLoadingStats,

      // Computed
      hasCommands: commands.length > 0,
      hasUserCommands: userCommands.length > 0,
      isSessionActive: currentSession !== null && currentSession.status === 'executing',
      canGoBack: currentSession?.actions?.includes('prev') ?? false,
      canGoNext: currentSession?.actions?.includes('next') ?? false,
      hasMoreUsers: Boolean(userList.pagination.last),
      hasMoreRooms: Boolean(roomList.pagination.last),

      // Actions (spread memoized actions)
      ...actions,
    }),
    [
      isAdmin,
      commands,
      commandsByCategory,
      userCommands,
      currentSession,
      isDiscovering,
      isExecuting,
      targetJid,
      pendingSelectedUserJid,
      stats,
      users,
      vhosts,
      selectedVhost,
      activeCategory,
      userList,
      roomList,
      mucServiceJid,
      serverStats,
      isLoadingStats,
      actions,
    ]
  )
}
