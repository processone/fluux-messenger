import { createStore } from 'zustand/vanilla'
import type {
  AdminCommand,
  AdminSession,
  AdminUser,
  AdminRoom,
  EntityListState,
  EntityCounts,
  RSMResponse,
  AdminCategory,
} from '../core/types'

// Re-export for convenience
export type { AdminCommand, AdminSession, DataForm, DataFormField, AdminNote } from '../core/types'

/**
 * Admin statistics for the dashboard.
 *
 * @category Admin
 */
export interface AdminStats {
  onlineUsers: number | null
  registeredUsers: number | null
  lastFetched: Date | null
}

// Initial state for entity lists
const initialEntityListState = <T>(): EntityListState<T> => ({
  items: [],
  pagination: {},
  isLoading: false,
  error: null,
  searchQuery: '',
  hasFetched: false,
})

/**
 * Admin state interface for server administration via XEP-0050 Ad-Hoc Commands.
 *
 * Manages admin privileges, available commands, command execution sessions,
 * and entity lists (users, rooms). Admin commands are discovered via XEP-0133
 * Service Administration and executed as multi-step forms.
 *
 * @remarks
 * Most applications should use the `useAdmin` hook instead of accessing this
 * store directly. The hook provides a cleaner API with memoized actions.
 *
 * @example Direct store access (advanced)
 * ```ts
 * import { useAdminStore } from '@fluux/sdk'
 *
 * // Check if current user is admin
 * const isAdmin = useAdminStore.getState().isAdmin
 *
 * // Get available commands
 * const commands = useAdminStore.getState().commands
 *
 * // Subscribe to command execution state
 * useAdminStore.subscribe(
 *   (state) => state.currentSession,
 *   (session) => {
 *     if (session?.status === 'completed') {
 *       console.log('Command completed:', session.notes)
 *     }
 *   }
 * )
 * ```
 *
 * @category Stores
 */
export interface AdminState {
  // Whether the current user has admin privileges (discovered via XEP-0133)
  isAdmin: boolean
  // Available admin commands from the server
  commands: AdminCommand[]
  // Current command execution session
  currentSession: AdminSession | null
  // Loading states
  isDiscovering: boolean
  isExecuting: boolean

  // Pre-filled JID for user-specific commands (from profile view)
  targetJid: string | null

  // Pending user to select when navigating to users list (from roster context menu)
  pendingSelectedUserJid: string | null

  // Dashboard state (legacy)
  stats: AdminStats
  users: string[]  // List of registered users (JIDs) - legacy
  vhosts: string[]  // Available virtual hosts
  selectedVhost: string | null  // Currently selected vhost

  // Entity list management (new)
  activeCategory: AdminCategory | null
  entityCounts: EntityCounts
  userList: EntityListState<AdminUser>
  roomList: EntityListState<AdminRoom>
  mucServiceJid: string | null
  /** Whether the MUC service advertises MAM support globally (XEP-0313) */
  mucServiceSupportsMAM: boolean | null

  // Actions
  setIsAdmin: (isAdmin: boolean) => void
  setCommands: (commands: AdminCommand[]) => void
  setCurrentSession: (session: AdminSession | null) => void
  setIsDiscovering: (loading: boolean) => void
  setIsExecuting: (loading: boolean) => void
  setTargetJid: (jid: string | null) => void
  setPendingSelectedUserJid: (jid: string | null) => void
  setStats: (stats: Partial<AdminStats>) => void
  setUsers: (users: string[]) => void
  setVhosts: (vhosts: string[]) => void
  setSelectedVhost: (vhost: string | null) => void

  // Entity list actions
  setActiveCategory: (category: AdminCategory | null) => void
  setEntityCounts: (counts: Partial<EntityCounts>) => void
  setUserList: (state: Partial<EntityListState<AdminUser>>) => void
  appendUserList: (items: AdminUser[], pagination: RSMResponse) => void
  resetUserList: () => void
  setRoomList: (state: Partial<EntityListState<AdminRoom>>) => void
  appendRoomList: (items: AdminRoom[], pagination: RSMResponse) => void
  resetRoomList: () => void
  setMucServiceJid: (jid: string | null) => void
  setMucServiceSupportsMAM: (supportsMAM: boolean | null) => void

  // Getters
  getCurrentSession: () => AdminSession | null
  getMucServiceJid: () => string | null
  getMucServiceSupportsMAM: () => boolean | null

  reset: () => void
}

const initialStats: AdminStats = {
  onlineUsers: null,
  registeredUsers: null,
  lastFetched: null,
}

const initialEntityCounts: EntityCounts = {}

const initialState = {
  isAdmin: false,
  commands: [] as AdminCommand[],
  currentSession: null as AdminSession | null,
  isDiscovering: false,
  isExecuting: false,
  targetJid: null as string | null,
  pendingSelectedUserJid: null as string | null,
  stats: initialStats,
  users: [] as string[],
  vhosts: [] as string[],
  selectedVhost: null as string | null,
  // Entity list management
  activeCategory: null as AdminCategory | null,
  entityCounts: initialEntityCounts,
  userList: initialEntityListState<AdminUser>(),
  roomList: initialEntityListState<AdminRoom>(),
  mucServiceJid: null as string | null,
  mucServiceSupportsMAM: null as boolean | null,
}

export const adminStore = createStore<AdminState>((set, get) => ({
  ...initialState,

  setIsAdmin: (isAdmin) => set({ isAdmin }),

  setCommands: (commands) => set({ commands }),

  setCurrentSession: (session) => set({ currentSession: session }),

  setIsDiscovering: (loading) => set({ isDiscovering: loading }),

  setIsExecuting: (loading) => set({ isExecuting: loading }),

  setTargetJid: (jid) => set({ targetJid: jid }),

  setPendingSelectedUserJid: (jid) => set({ pendingSelectedUserJid: jid }),

  setStats: (stats) => set((state) => ({
    stats: { ...state.stats, ...stats },
  })),

  setUsers: (users) => set({ users }),

  setVhosts: (vhosts) => set({ vhosts }),

  setSelectedVhost: (vhost) => set({ selectedVhost: vhost }),

  // Entity list actions
  setActiveCategory: (category) => set({ activeCategory: category }),

  setEntityCounts: (counts) => set((state) => ({
    entityCounts: { ...state.entityCounts, ...counts },
  })),

  setUserList: (update) => set((state) => ({
    userList: { ...state.userList, ...update },
  })),

  appendUserList: (items, pagination) => set((state) => ({
    userList: {
      ...state.userList,
      items: [...state.userList.items, ...items],
      pagination,
      isLoading: false,
    },
  })),

  resetUserList: () => set({
    userList: initialEntityListState<AdminUser>(),
  }),

  setRoomList: (update) => set((state) => ({
    roomList: { ...state.roomList, ...update },
  })),

  appendRoomList: (items, pagination) => set((state) => ({
    roomList: {
      ...state.roomList,
      items: [...state.roomList.items, ...items],
      pagination,
      isLoading: false,
    },
  })),

  resetRoomList: () => set({
    roomList: initialEntityListState<AdminRoom>(),
  }),

  setMucServiceJid: (jid) => set({ mucServiceJid: jid }),
  setMucServiceSupportsMAM: (supportsMAM) => set({ mucServiceSupportsMAM: supportsMAM }),

  // Getters
  getCurrentSession: () => get().currentSession,
  getMucServiceJid: () => get().mucServiceJid,
  getMucServiceSupportsMAM: () => get().mucServiceSupportsMAM,

  reset: () => set(initialState),
}))
