import { createStore } from 'zustand/vanilla'
import { persist } from 'zustand/middleware'
import { getResource } from '../core/jid'
import { buildScopedStorageKey } from '../utils/storageScope'

const STORAGE_KEY_BASE = 'fluux-ignored-users'
const EMPTY_IGNORED_ARRAY: IgnoredUser[] = []

function getScopedStorageKey(): string {
  return buildScopedStorageKey(STORAGE_KEY_BASE)
}

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
  rehydrate: () => void
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
        return get().ignoredUsers[roomJid] ?? EMPTY_IGNORED_ARRAY
      },

      rehydrate: () => {
        ignoreStore.persist.rehydrate()
      },

      reset: () => {
        set({ ignoredUsers: {} })
        try {
          localStorage.removeItem(getScopedStorageKey())
        } catch {
          // Ignore storage errors
        }
      },
    }),
    {
      name: STORAGE_KEY_BASE,
      storage: {
        getItem: () => {
          const scopedKey = getScopedStorageKey()
          try {
            let str = localStorage.getItem(scopedKey)
            // Migration: copy from base key if scoped key is empty
            if (!str && scopedKey !== STORAGE_KEY_BASE) {
              const legacy = localStorage.getItem(STORAGE_KEY_BASE)
              if (legacy) {
                localStorage.setItem(scopedKey, legacy)
                localStorage.removeItem(STORAGE_KEY_BASE)
                str = legacy
              }
            }
            if (!str) return null
            return JSON.parse(str)
          } catch {
            localStorage.removeItem(scopedKey)
            return null
          }
        },
        setItem: (_, value) => {
          try {
            localStorage.setItem(getScopedStorageKey(), JSON.stringify(value))
          } catch {
            // Storage quota exceeded or other error, continue without persistence
          }
        },
        removeItem: () => {
          try {
            localStorage.removeItem(getScopedStorageKey())
          } catch {
            // Ignore storage errors
          }
        },
      },
    }
  )
)

/**
 * Check whether a room message was sent by an ignored user.
 *
 * Matching priority: occupantId (XEP-0421) > JID via nickToJidCache > nick.
 * Also cross-matches the stored `jid` field against `nickToJidCache` so that
 * messages without occupantId (e.g., MAM history) are still caught when the
 * identifier is an occupantId.
 */
export function isMessageFromIgnoredUser(
  ignoredUsers: IgnoredUser[],
  msg: { occupantId?: string; nick: string },
  nickToJidCache?: Map<string, string>,
): boolean {
  if (ignoredUsers.length === 0) return false
  const ignoredIds = new Set(ignoredUsers.map(u => u.identifier))
  const ignoredJids = new Set(ignoredUsers.map(u => u.jid).filter(Boolean))

  // Check occupantId first (XEP-0421, most reliable)
  if (msg.occupantId && ignoredIds.has(msg.occupantId)) return true
  // Check by JID via nickToJidCache (matches when identifier is bareJid OR occupantId with stored jid)
  if (nickToJidCache) {
    const jid = nickToJidCache.get(msg.nick)
    if (jid && (ignoredIds.has(jid) || ignoredJids.has(jid))) return true
  }
  // Check by nick (least reliable, last resort)
  if (ignoredIds.has(msg.nick)) return true
  return false
}

/**
 * Check whether a room message is a reply quoting an ignored user.
 *
 * When `replyTo.to` is present (XEP-0461), the value is the full occupant JID
 * (e.g. `room@conference/nick`).  We extract the nick and run the same
 * matching logic used for direct messages from ignored users.
 */
export function isReplyToIgnoredUser(
  ignoredUsers: IgnoredUser[],
  replyTo: { to?: string } | undefined,
  nickToJidCache?: Map<string, string>,
): boolean {
  if (!replyTo?.to || ignoredUsers.length === 0) return false

  const nick = getResource(replyTo.to)
  if (!nick) return false

  return isMessageFromIgnoredUser(ignoredUsers, { nick }, nickToJidCache)
}

export type { IgnoreState }
