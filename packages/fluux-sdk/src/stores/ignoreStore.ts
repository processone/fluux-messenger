import { createStore } from 'zustand/vanilla'
import { persist } from 'zustand/middleware'

const STORAGE_KEY = 'fluux-ignored-users'

/**
 * An ignored user entry, stored per room.
 *
 * @category Stores
 */
export interface IgnoredUser {
  /**
   * Stable identifier for matching messages.
   * Priority: occupantId (XEP-0421) > bareJid > nick.
   */
  identifier: string
  /** Display name for the UI */
  displayName: string
  /** Real JID if known (for display purposes) */
  jid?: string
}

/**
 * Ignore state for managing per-room ignored users.
 *
 * Ignored users' messages are hidden client-side in the room view.
 * State is persisted to localStorage so it survives page reloads.
 *
 * @category Stores
 */
interface IgnoreState {
  /** Map of roomJid → list of ignored users */
  ignoredUsers: Record<string, IgnoredUser[]>

  addIgnored: (roomJid: string, user: IgnoredUser) => void
  removeIgnored: (roomJid: string, identifier: string) => void
  /** Replace the full ignore list for a single room (used for server sync) */
  setIgnoredForRoom: (roomJid: string, users: IgnoredUser[]) => void
  isIgnored: (roomJid: string, identifier: string) => boolean
  getIgnoredForRoom: (roomJid: string) => IgnoredUser[]
  reset: () => void
}

export const ignoreStore = createStore<IgnoreState>()(
  persist(
    (set, get) => ({
      ignoredUsers: {},

      addIgnored: (roomJid, user) => {
        set((state) => {
          const existing = state.ignoredUsers[roomJid] || []
          // Don't add duplicates
          if (existing.some(u => u.identifier === user.identifier)) return state
          return {
            ignoredUsers: {
              ...state.ignoredUsers,
              [roomJid]: [...existing, user],
            },
          }
        })
      },

      setIgnoredForRoom: (roomJid, users) => {
        set((state) => {
          const newIgnored = { ...state.ignoredUsers }
          if (users.length === 0) {
            delete newIgnored[roomJid]
          } else {
            newIgnored[roomJid] = users
          }
          return { ignoredUsers: newIgnored }
        })
      },

      removeIgnored: (roomJid, identifier) => {
        set((state) => {
          const existing = state.ignoredUsers[roomJid]
          if (!existing) return state
          const filtered = existing.filter(u => u.identifier !== identifier)
          if (filtered.length === existing.length) return state
          const newIgnored = { ...state.ignoredUsers }
          if (filtered.length === 0) {
            delete newIgnored[roomJid]
          } else {
            newIgnored[roomJid] = filtered
          }
          return { ignoredUsers: newIgnored }
        })
      },

      isIgnored: (roomJid, identifier) => {
        const users = get().ignoredUsers[roomJid]
        return users?.some(u => u.identifier === identifier) ?? false
      },

      getIgnoredForRoom: (roomJid) => {
        return get().ignoredUsers[roomJid] || []
      },

      reset: () => {
        set({ ignoredUsers: {} })
        try {
          localStorage.removeItem(STORAGE_KEY)
        } catch {
          // Ignore storage errors
        }
      },
    }),
    {
      name: STORAGE_KEY,
    }
  )
)

export type { IgnoreState }
