import { adminStore } from '../stores'
import { useAdminStore } from '../react/storeHooks'
import { useXMPPContext } from '../provider'
import type { AdminCommand, AdminCommandCategory, AdminCategory, RSMRequest } from '../core/types'

// Commands that operate on a specific user JID
const USER_COMMANDS = new Set([
  'http://jabber.org/protocol/admin#delete-user',
  'http://jabber.org/protocol/admin#disable-user',
  'http://jabber.org/protocol/admin#reenable-user',
  'http://jabber.org/protocol/admin#end-user-session',
  'http://jabber.org/protocol/admin#change-user-password',
  'http://jabber.org/protocol/admin#get-user-roster',
  'http://jabber.org/protocol/admin#get-user-lastlogin',
  'http://jabber.org/protocol/admin#user-stats',
])

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
 *       {canGoBack && <button onClick={previousStep}>Back</button>}
 *       <button type="submit">Submit</button>
 *       <button onClick={cancelCommand}>Cancel</button>
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
  const entityCounts = useAdminStore((s) => s.entityCounts)
  const userList = useAdminStore((s) => s.userList)
  const roomList = useAdminStore((s) => s.roomList)
  const mucServiceJid = useAdminStore((s) => s.mucServiceJid)

  // Group commands by category
  const grouped: Record<AdminCommandCategory, AdminCommand[]> = {
    user: [],
    stats: [],
    announcement: [],
    other: [],
  }

  for (const cmd of commands) {
    grouped[cmd.category].push(cmd)
  }

  const commandsByCategory = grouped

  // Commands that can be executed on a specific user (shown in contact profile)
  const userCommands = commands.filter(cmd => USER_COMMANDS.has(cmd.node))

  // Execute a command
  const executeCommand = async (node: string) => {
    return client.admin.executeAdminCommand(node, 'execute')
  }

  // Submit form data for current session
  const submitForm = async (formData: Record<string, string | string[]>) => {
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
  }

  // Go to previous step in multi-step command
  const previousStep = async () => {
    const session = adminStore.getState().currentSession
    if (!session || !session.actions?.includes('prev')) {
      throw new Error('Cannot go to previous step')
    }

    return client.admin.executeAdminCommand(session.node, 'prev', session.sessionId)
  }

  // Cancel current command
  const cancelCommand = async () => {
    await client.admin.cancelAdminCommand()
  }

  // Clear current session (for closing result views)
  const clearSession = () => {
    adminStore.getState().setCurrentSession(null)
    adminStore.getState().setTargetJid(null)
  }

  // Execute a command for a specific user (pre-fills accountjid)
  const executeCommandForUser = async (node: string, jid: string) => {
    // Store the target JID for form pre-fill
    adminStore.getState().setTargetJid(jid)
    return client.admin.executeAdminCommand(node, 'execute')
  }

  // Add a new user
  const addUser = async (username: string, password: string) => {
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
  }

  // Clear target JID
  const clearTargetJid = () => {
    adminStore.getState().setTargetJid(null)
  }

  // Clear pending selected user JID
  const clearPendingSelectedUserJid = () => {
    adminStore.getState().setPendingSelectedUserJid(null)
  }

  // Navigate to admin user management for a specific user
  // Returns the vhost if admin has rights, null otherwise
  const navigateToUserAdmin = (userJid: string): string | null => {
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
  }

  // Check if admin can manage a specific user (based on vhost rights)
  const canManageUser = (userJid: string): boolean => {
    const store = adminStore.getState()
    const domain = userJid.split('@')[1]?.split('/')[0]
    if (!domain) return false

    // If no vhosts discovered yet, or empty list, assume can manage (will be checked later)
    const adminVhosts = store.vhosts
    if (adminVhosts.length === 0) return store.isAdmin

    return adminVhosts.includes(domain)
  }

  // Set selected virtual host
  const setSelectedVhost = (vhost: string | null) => {
    adminStore.getState().setSelectedVhost(vhost)
  }

  // Set active category for entity list display
  const setActiveCategory = (category: AdminCategory | null) => {
    adminStore.getState().setActiveCategory(category)
  }

  // Fetch entity counts for sidebar badges
  const fetchEntityCounts = async () => {
    return client.admin.fetchEntityCounts()
  }

  // Fetch available virtual hosts
  const fetchVhosts = async () => {
    return client.admin.fetchVhosts()
  }

  // Fetch user list with pagination
  const fetchUsers = async (rsm?: RSMRequest) => {
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
  }

  // Load more users (pagination helper)
  const loadMoreUsers = async () => {
    const { pagination, isLoading } = adminStore.getState().userList
    if (isLoading || !pagination.last) return

    return fetchUsers({ after: pagination.last })
  }

  // Search users
  const searchUsers = async (query: string) => {
    const store = adminStore.getState()
    store.setUserList({ searchQuery: query })
    // Reset and fetch - search will be applied server-side if supported
    return fetchUsers()
  }

  // Reset user list
  const resetUserList = () => {
    adminStore.getState().resetUserList()
  }

  // Discover MUC service
  const discoverMucService = async () => {
    return client.admin.discoverMucService()
  }

  // Fetch room list with pagination
  const fetchRooms = async (rsm?: RSMRequest) => {
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
  }

  // Load more rooms (pagination helper)
  const loadMoreRooms = async () => {
    const { pagination, isLoading } = adminStore.getState().roomList
    if (isLoading || !pagination.last) return

    return fetchRooms({ after: pagination.last })
  }

  // Reset room list
  const resetRoomList = () => {
    adminStore.getState().resetRoomList()
  }

  // Get room options/configuration
  const getRoomOptions = async (roomJid: string) => {
    return client.admin.fetchRoomOptions(roomJid)
  }

  // Check if a specific admin command is available
  const hasCommand = (commandName: string) => {
    return commands.some(cmd =>
      cmd.node === `api-commands/${commandName}` ||
      cmd.node.endsWith(`#${commandName}`)
    )
  }

  return {
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
    entityCounts,
    userList,
    roomList,
    mucServiceJid,

    // Computed
    hasCommands: commands.length > 0,
    hasUserCommands: userCommands.length > 0,
    isSessionActive: currentSession !== null && currentSession.status === 'executing',
    canGoBack: currentSession?.actions?.includes('prev') ?? false,
    canGoNext: currentSession?.actions?.includes('next') ?? false,
    hasMoreUsers: Boolean(userList.pagination.last),
    hasMoreRooms: Boolean(roomList.pagination.last),

    // Actions
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
    fetchEntityCounts,
    fetchVhosts,
    fetchUsers,
    loadMoreUsers,
    searchUsers,
    resetUserList,
    discoverMucService,
    fetchRooms,
    loadMoreRooms,
    resetRoomList,
    getRoomOptions,
    hasCommand,
  }
}
