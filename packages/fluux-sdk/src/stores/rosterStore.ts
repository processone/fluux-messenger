import { createStore } from 'zustand/vanilla'
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
 * import { useRosterStore } from '@fluux/sdk'
 *
 * // Get sorted contacts (online first)
 * const contacts = useRosterStore.getState().sortedContacts()
 *
 * // Subscribe to roster changes
 * useRosterStore.subscribe(
 *   (state) => state.contacts,
 *   (contacts) => console.log('Contacts updated:', contacts.size)
 * )
 *
 * // Check if JID is a known contact
 * const isContact = useRosterStore.getState().hasContact('user@example.com')
 * ```
 *
 * @category Stores
 */
interface RosterState {
  contacts: Map<string, Contact>

  // Actions
  setContacts: (contacts: Contact[]) => void
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
  setPresenceError: (jid: string, error: string) => void
  updateAvatar: (jid: string, avatar: string | null, avatarHash?: string) => void
  removeContact: (jid: string) => void
  hasContact: (jid: string) => boolean
  getContact: (jid: string) => Contact | undefined
  getOfflineContacts: () => Contact[]
  resetAllPresence: () => void
  reset: () => void

  // Computed
  onlineContacts: () => Contact[]
  sortedContacts: () => Contact[]
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

export const rosterStore = createStore<RosterState>((set, get) => ({
  contacts: new Map(),

  setContacts: (contacts) => {
    const map = new Map<string, Contact>()
    contacts.forEach(c => {
      const colors = calculateContactColors(c.jid)
      map.set(c.jid, { ...c, ...colors })
    })
    set({ contacts: map })
  },

  addOrUpdateContact: (contact) => {
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
    set((state) => {
      const newContacts = new Map(state.contacts)
      const existing = newContacts.get(jid)
      if (existing) {
        newContacts.set(jid, { ...existing, ...update })
      }
      return { contacts: newContacts }
    })
  },

  updatePresence: (fullJid, show, priority, statusMessage, lastInteraction, client) => {
    set((state) => {
      const bareJid = getBareJid(fullJid)
      const resource = getResource(fullJid)
      if (!resource) {
        // No resource - treat as bare JID, use empty string as resource key
        // This shouldn't happen normally but handle gracefully
      }
      const resourceKey = resource || ''

      const newContacts = new Map(state.contacts)
      const existing = newContacts.get(bareJid)
      if (existing) {
        // Update or create resources map
        const resources = new Map(existing.resources || new Map())
        resources.set(resourceKey, {
          show,
          status: statusMessage,
          priority,
          lastInteraction,
          client,
        })

        // Compute aggregated presence from all resources
        const aggregated = computeAggregatedPresence(resources)

        newContacts.set(bareJid, {
          ...existing,
          resources,
          presence: aggregated.presence,
          statusMessage: aggregated.statusMessage,
          lastInteraction: aggregated.lastInteraction,
          presenceError: undefined, // Clear any previous error
        })
      }
      return { contacts: newContacts }
    })
  },

  removePresence: (fullJid) => {
    set((state) => {
      const bareJid = getBareJid(fullJid)
      const resource = getResource(fullJid)
      const resourceKey = resource || ''

      const newContacts = new Map(state.contacts)
      const existing = newContacts.get(bareJid)
      if (existing) {
        const resources = new Map(existing.resources || new Map())
        resources.delete(resourceKey)

        // Compute aggregated presence from remaining resources
        const aggregated = computeAggregatedPresence(resources)

        // Track lastSeen when going offline (all resources gone)
        const lastSeen = aggregated.presence === 'offline' && existing.presence !== 'offline'
          ? new Date()
          : existing.lastSeen

        newContacts.set(bareJid, {
          ...existing,
          resources: resources.size > 0 ? resources : undefined,
          presence: aggregated.presence,
          statusMessage: aggregated.statusMessage,
          lastInteraction: aggregated.lastInteraction,
          lastSeen,
        })
      }
      return { contacts: newContacts }
    })
  },

  setPresenceError: (jid, error) => {
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
    set((state) => {
      const newContacts = new Map(state.contacts)
      const existing = newContacts.get(jid)
      if (existing) {
        newContacts.set(jid, {
          ...existing,
          avatar: avatar ?? undefined,
          avatarHash: avatarHash ?? existing.avatarHash,
        })
      }
      return { contacts: newContacts }
    })
  },

  removeContact: (jid) => {
    set((state) => {
      const newContacts = new Map(state.contacts)
      newContacts.delete(jid)
      return { contacts: newContacts }
    })
  },

  hasContact: (jid) => get().contacts.has(jid),

  getContact: (jid) => get().contacts.get(jid),

  getOfflineContacts: () => {
    const result = Array.from(get().contacts.values())
      .filter(c => c.presence === 'offline')
    return result.length > 0 ? result : EMPTY_CONTACT_ARRAY
  },

  resetAllPresence: () => {
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

  reset: () => set({ contacts: new Map() }),

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
}))

export type { RosterState }
