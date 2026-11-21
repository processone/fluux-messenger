import { createStore } from 'zustand/vanilla'
import { containSubscriberErrors } from './shared/containSubscriberErrors'
import type { Contact, PresenceStatus, PresenceShow, ResourcePresence } from '../core/types'
import { getBareJid, getResource } from '../core/jid'
import { getPresenceRank, getPresenceFromShow } from '../utils/presenceUtils'
import {
  generateConsistentColorHexSync,
  LIGHT_THEME_DEFAULTS,
  DARK_THEME_DEFAULTS,
} from '../core/consistentColor'

/**
 * Calculate XEP-0392 consistent colors for a contact.
 * Returns both light and dark theme variants.
 */
function calculateContactColors(jid: string): { colorLight: string; colorDark: string } {
  return {
    colorLight: generateConsistentColorHexSync(jid, LIGHT_THEME_DEFAULTS),
    colorDark: generateConsistentColorHexSync(jid, DARK_THEME_DEFAULTS),
  }
}

/**
 * Stable empty array reference to prevent infinite re-renders.
 * When computed selectors return empty results, they should return this
 * constant instead of creating a new [] instance each time.
 */
const EMPTY_CONTACT_ARRAY: Contact[] = []
const EMPTY_CONTACT_ENTRIES: string[] = []

// Selector memoization caches.
// sortedContacts() and onlineContacts() are called on every Zustand subscription check.
// Cache by contacts Map reference to avoid redundant O(n log n) sorts.
let _cachedSortedContacts: Contact[] = EMPTY_CONTACT_ARRAY
let _cachedSortedContactsSource: Map<string, Contact> | null = null
let _cachedOnlineContacts: Contact[] = EMPTY_CONTACT_ARRAY
let _cachedOnlineContactsSource: Map<string, Contact> | null = null

/**
 * Roster state interface for the contact list (buddy list).
 *
 * Manages contacts, presence state aggregation across multiple resources,
 * and avatar information. Handles the complexity of XMPP presence where
 * a single contact may be online from multiple devices simultaneously.
 *
 * @remarks
 * Most applications should use the `useRoster` hook instead of accessing this
 * store directly. The hook provides a cleaner API with memoized actions.
 *
 * Presence aggregation rules:
 * 1. Highest priority resource wins
 * 2. On priority tie, "best" presence wins (chat > online > away > xa > dnd)
 * 3. Returns offline only when no resources are connected
 *
 * @example Direct store access (advanced)
 * ```ts
 * import { rosterStore } from '@fluux/sdk'
 *
 * // Get sorted contacts (online first)
 * const contacts = rosterStore.getState().sortedContacts()
 *
 * // Subscribe to roster changes
 * rosterStore.subscribe((state) => {
 *   console.log('Contacts updated:', state.contacts.size)
 * })
 *
 * // Check if JID is a known contact
 * const isContact = rosterStore.getState().hasContact('user@example.com')
 * ```
 *
 * @category Stores
 */
interface RosterState {
  /** Published UI snapshot; SDK presence ingress is coalesced for up to 16 ms. */
  contacts: Map<string, Contact>
  isLoaded: boolean
  accountJid: string | null

  // Actions
  setContacts: (contacts: Contact[], accountJid?: string | null) => void
  switchAccount: (jid: string) => void
  addOrUpdateContact: (contact: Contact) => void
  updateContact: (jid: string, update: Partial<Contact>) => void
  updatePresence: (
    fullJid: string,
    show: PresenceShow | null,
    priority: number,
    statusMessage?: string,
    lastInteraction?: Date,
    client?: string
  ) => void
  removePresence: (fullJid: string) => void
  /** SDK ingress: aggregate immediately, publish a single snapshot after 16 ms. */
  queuePresence: RosterState['updatePresence']
  queuePresenceRemoval: RosterState['removePresence']
  queueAvatar: RosterState['updateAvatar']
  flushPresence: () => void
  setPresenceError: (jid: string, error: string) => void
  updateAvatar: (jid: string, avatar: string | null, avatarHash?: string) => void
  removeContact: (jid: string) => void
  hasContact: (jid: string) => boolean
  /** Includes pending SDK presence so protocol callbacks observe wire-order aggregation. */
  getContact: (jid: string) => Contact | undefined
  getOfflineContacts: () => Contact[]
  resetAllPresence: () => void
  reset: () => void

  // Computed
  onlineContacts: () => Contact[]
  sortedContacts: () => Contact[]
  /**
   * Sidebar-ordered contact entries, each encoded as `<group> <jid>` where group is
   * `online` (any non-offline presence) | `offline` | `errored`, sorted by name within
   * each group. Cached by snapshot and retained when names/grouping are unchanged,
   * so ContactList subscribes to this instead of the full Contact objects: a presence
   * flap that stays in the same group (e.g. online<->away) does NOT re-render the list,
   * and each ContactItem self-subscribes to its own contact by jid.
   */
  contactSidebarEntries: () => string[]
}

/**
 * Compute aggregated presence from all resources
 * Rules:
 * 1. Highest priority resource wins
 * 2. On priority tie, "best" presence wins (chat > online > away > xa > dnd)
 * 3. Returns offline only when no resources
 */
function computeAggregatedPresence(resources: Map<string, ResourcePresence>): {
  presence: PresenceStatus
  statusMessage?: string
  lastInteraction?: Date
} {
  if (resources.size === 0) {
    return { presence: 'offline' }
  }

  // Find the best resource: highest priority, then best presence
  let bestResource: ResourcePresence | null = null

  for (const resource of resources.values()) {
    if (!bestResource) {
      bestResource = resource
      continue
    }

    // Higher priority wins
    if (resource.priority > bestResource.priority) {
      bestResource = resource
    } else if (resource.priority === bestResource.priority) {
      // Same priority: better presence wins
      if (getPresenceRank(resource.show) < getPresenceRank(bestResource.show)) {
        bestResource = resource
      }
    }
  }

  return {
    presence: getPresenceFromShow(bestResource!.show),
    statusMessage: bestResource!.status,
    lastInteraction: bestResource!.lastInteraction,
  }
}

function withPresence(
  existing: Contact,
  fullJid: string,
  show: PresenceShow | null,
  priority: number,
  statusMessage?: string,
  lastInteraction?: Date,
  client?: string,
): Contact {
  const resources = new Map(existing.resources)
  resources.set(getResource(fullJid) || '', { show, priority, status: statusMessage, lastInteraction, client })
  return { ...existing, resources, ...computeAggregatedPresence(resources), presenceError: undefined }
}

function withoutPresence(existing: Contact, fullJid: string): Contact {
  const resources = new Map(existing.resources)
  resources.delete(getResource(fullJid) || '')
  const aggregated = computeAggregatedPresence(resources)
  return {
    ...existing,
    presence: aggregated.presence,
    statusMessage: aggregated.statusMessage,
    lastInteraction: aggregated.lastInteraction,
    resources: resources.size > 0 ? resources : undefined,
    lastSeen: aggregated.presence === 'offline' && existing.presence !== 'offline'
      ? new Date() : existing.lastSeen,
  }
}

function withAvatar(existing: Contact, avatar: string | null, avatarHash?: string): Contact {
  return {
    ...existing,
    avatar: avatar ?? undefined,
    avatarHash: avatarHash ?? (avatar === null ? undefined : existing.avatarHash),
  }
}

function sidebarGroup(contact: Contact): string {
  return contact.presenceError ? 'errored' : contact.presence === 'offline' ? 'offline' : 'online'
}

export const rosterStore = createStore<RosterState>()(containSubscriberErrors((set, get) => {
  // Pending contacts are immutable replacements, not mutations of published snapshots.
  // Protocol consumers read these through getContact before the UI snapshot is published.
  const pending = new Map<string, Contact>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancelPresence = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pending.clear()
  }
  const flushPresence = () => {
    if (pending.size === 0) return
    const contacts = new Map(get().contacts)
    for (const [jid, contact] of pending) contacts.set(jid, contact)
    cancelPresence()
    set({ contacts })
  }
  const queue = (fullJid: string, update: (contact: Contact) => Contact) => {
    const jid = getBareJid(fullJid)
    const existing = pending.get(jid) ?? get().contacts.get(jid)
    if (!existing) return
    pending.set(jid, update(existing))
    timer ??= setTimeout(flushPresence, 16)
  }
  const writeAvatar = (jid: string, avatar: string | null, avatarHash?: string) => {
    const existing = get().contacts.get(jid)
    if (!existing) return
    const contacts = new Map(get().contacts)
    contacts.set(jid, withAvatar(existing, avatar, avatarHash))
    set({ contacts })
  }
  let sidebarSource: Map<string, Contact> | undefined
  let sidebarEntries = EMPTY_CONTACT_ENTRIES

  return {
    contacts: new Map(),
    isLoaded: false,
    accountJid: null,

    setContacts: (contacts, accountJid = get().accountJid) => {
      cancelPresence()
      const map = new Map<string, Contact>()
      contacts.forEach(c => {
        const colors = calculateContactColors(c.jid)
        map.set(c.jid, { ...c, ...colors })
      })
      set({ contacts: map, isLoaded: true, accountJid })
    },

    switchAccount: (accountJid) => {
      if (get().accountJid === accountJid) return
      cancelPresence()
      set({ contacts: new Map(), isLoaded: false, accountJid })
    },

    addOrUpdateContact: (contact) => {
      flushPresence()
      set((state) => {
        const newContacts = new Map(state.contacts)
        const existing = newContacts.get(contact.jid)
        if (existing) {
          // Preserve presence state and colors when updating
          newContacts.set(contact.jid, { ...existing, ...contact, presence: existing.presence })
        } else {
          // Calculate colors for new contacts
          const colors = calculateContactColors(contact.jid)
          newContacts.set(contact.jid, { ...contact, ...colors })
        }
        return { contacts: newContacts }
      })
    },

    updateContact: (jid, update) => {
      flushPresence()
      set((state) => {
        const newContacts = new Map(state.contacts)
        const existing = newContacts.get(jid)
        if (existing) {
          newContacts.set(jid, { ...existing, ...update })
        }
        return { contacts: newContacts }
      })
    },

    updatePresence: (...args) => {
      flushPresence()
      const jid = getBareJid(args[0])
      const existing = get().contacts.get(jid)
      if (!existing) return
      const contacts = new Map(get().contacts)
      contacts.set(jid, withPresence(existing, ...args))
      set({ contacts })
    },

    removePresence: (fullJid) => {
      flushPresence()
      const jid = getBareJid(fullJid)
      const existing = get().contacts.get(jid)
      if (!existing) return
      const contacts = new Map(get().contacts)
      contacts.set(jid, withoutPresence(existing, fullJid))
      set({ contacts })
    },

    queuePresence: (...args) => queue(args[0], c => withPresence(c, ...args)),
    queuePresenceRemoval: (fullJid) => queue(fullJid, c => withoutPresence(c, fullJid)),
    flushPresence,

    setPresenceError: (jid, error) => {
      flushPresence()
      set((state) => {
        const newContacts = new Map(state.contacts)
        const existing = newContacts.get(jid)
        if (existing) {
          // Clear resources when setting error - stale resource data should not
          // override the error state when removePresence recalculates
          newContacts.set(jid, {
            ...existing,
            presence: 'offline',
            presenceError: error,
            resources: undefined,
            statusMessage: undefined,
          })
        }
        return { contacts: newContacts }
      })
    },

    updateAvatar: (jid, avatar, avatarHash) => {
      flushPresence()
      writeAvatar(jid, avatar, avatarHash)
    },

    queueAvatar: (jid, avatar, avatarHash) => {
      const queued = pending.get(jid)
      if (queued) pending.set(jid, withAvatar(queued, avatar, avatarHash))
      else writeAvatar(jid, avatar, avatarHash)
    },

    removeContact: (jid) => {
      flushPresence()
      set((state) => {
        const newContacts = new Map(state.contacts)
        newContacts.delete(jid)
        return { contacts: newContacts }
      })
    },

    hasContact: (jid) => get().contacts.has(jid),

    getContact: (jid) => pending.get(jid) ?? get().contacts.get(jid),

    getOfflineContacts: () => {
      const result = Array.from(get().contacts.values())
        .filter(c => c.presence === 'offline')
      return result.length > 0 ? result : EMPTY_CONTACT_ARRAY
    },

    resetAllPresence: () => {
      flushPresence()
      set((state) => {
        const newContacts = new Map(state.contacts)
        for (const [jid, contact] of newContacts) {
          newContacts.set(jid, {
            ...contact,
            presence: 'offline',
            statusMessage: undefined,
            presenceError: undefined,
            resources: undefined,  // Clear all resource presence
            lastSeen: contact.presence !== 'offline' ? new Date() : contact.lastSeen,
          })
        }
        return { contacts: newContacts }
      })
    },

    reset: () => {
      cancelPresence()
      set({ contacts: new Map(), isLoaded: false, accountJid: null })
    },

    onlineContacts: () => {
      const contacts = get().contacts
      if (contacts === _cachedOnlineContactsSource) return _cachedOnlineContacts
      _cachedOnlineContactsSource = contacts
      const result = Array.from(contacts.values())
        .filter(c => c.presence !== 'offline')
      _cachedOnlineContacts = result.length > 0 ? result : EMPTY_CONTACT_ARRAY
      return _cachedOnlineContacts
    },

    sortedContacts: () => {
      const contacts = get().contacts
      if (contacts === _cachedSortedContactsSource) return _cachedSortedContacts
      _cachedSortedContactsSource = contacts
      const presenceOrder: Record<PresenceStatus, number> = {
        online: 0,
        away: 1,
        dnd: 2,
        offline: 3,
      }

      const result = Array.from(contacts.values())
        .sort((a, b) => {
          const presenceDiff = presenceOrder[a.presence] - presenceOrder[b.presence]
          if (presenceDiff !== 0) return presenceDiff
          return a.name.localeCompare(b.name)
        })
      _cachedSortedContacts = result.length > 0 ? result : EMPTY_CONTACT_ARRAY
      return _cachedSortedContacts
    },

    contactSidebarEntries: () => {
      const contacts = get().contacts
      if (contacts === sidebarSource) return sidebarEntries
      // A new snapshot need not change the sidebar order: status, resource and avatar
      // updates within a group retain the cached strings without sorting again.
      let unchanged = sidebarSource?.size === contacts.size
      const previousKeys = sidebarSource?.keys()
      if (unchanged) {
        for (const [jid, contact] of contacts) {
          const previous = sidebarSource!.get(jid)
          if (previousKeys!.next().value !== jid || !previous || previous.name !== contact.name ||
            sidebarGroup(previous) !== sidebarGroup(contact)) {
            unchanged = false
            break
          }
        }
      }
      sidebarSource = contacts
      if (unchanged) return sidebarEntries
      if (contacts.size === 0) return (sidebarEntries = EMPTY_CONTACT_ENTRIES)
      const online: Contact[] = []
      const offline: Contact[] = []
      const errored: Contact[] = []
      for (const c of contacts.values()) {
        if (c.presenceError) errored.push(c)
        else if (c.presence !== 'offline') online.push(c)
        else offline.push(c)
      }
      const byName = (a: Contact, b: Contact) => a.name.localeCompare(b.name)
      online.sort(byName)
      offline.sort(byName)
      errored.sort(byName)
      return (sidebarEntries = [
        ...online.map((c) => `online ${c.jid}`),
        ...offline.map((c) => `offline ${c.jid}`),
        ...errored.map((c) => `errored ${c.jid}`),
      ])
    },
  }
}))

export type { RosterState }
