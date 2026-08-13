/**
 * Granular selectors for rosterStore to reduce re-renders.
 *
 * Using these selectors with Zustand's shallow comparison allows components
 * to subscribe to specific pieces of state instead of entire Maps/objects.
 *
 * @example
 * ```tsx
 * import { rosterSelectors } from '@fluux/sdk'
 * import { useRosterStore } from '@fluux/sdk/react'
 *
 * // Only re-renders when contact JIDs change (not when presence/status changes)
 * const contactJids = useRosterStore(rosterSelectors.contactJids)
 *
 * // Only re-renders when this specific contact changes
 * const contact = useRosterStore(rosterSelectors.contactById('user@example.com'))
 *
 * // Only re-renders when online count changes
 * const onlineCount = useRosterStore(rosterSelectors.onlineCount)
 * ```
 *
 * @packageDocumentation
 * @module Stores/RosterSelectors
 */

import type { RosterState } from './rosterStore'
import type { Contact, PresenceStatus, ResourcePresence } from '../core/types'

/**
 * Stable empty references to prevent infinite re-renders.
 */
const EMPTY_STRING_ARRAY: string[] = []
const EMPTY_RESOURCE_MAP: Map<string, ResourcePresence> = new Map()

/**
 * Presence ordering for sorting (lower = more available).
 */
const PRESENCE_ORDER: Record<PresenceStatus, number> = {
  online: 0,
  away: 1,
  dnd: 2,
  offline: 3,
}

/**
 * Granular selectors for rosterStore.
 *
 * These selectors enable fine-grained subscriptions to reduce unnecessary
 * re-renders. Use with Zustand's shallow comparison for array/object returns.
 *
 * @category Selectors
 */
export const rosterSelectors = {
  /**
   * Get all contact JIDs.
   * Use with shallow() to only re-render when JIDs change.
   */
  contactJids: (state: RosterState): string[] => {
    const jids = Array.from(state.contacts.keys())
    return jids.length > 0 ? jids : EMPTY_STRING_ARRAY
  },

  /**
   * Get online contact JIDs (not offline).
   */
  onlineContactJids: (state: RosterState): string[] => {
    const jids: string[] = []
    for (const [jid, contact] of state.contacts) {
      if (contact.presence !== 'offline') {
        jids.push(jid)
      }
    }
    return jids.length > 0 ? jids : EMPTY_STRING_ARRAY
  },

  /**
   * Get offline contact JIDs.
   */
  offlineContactJids: (state: RosterState): string[] => {
    const jids: string[] = []
    for (const [jid, contact] of state.contacts) {
      if (contact.presence === 'offline') {
        jids.push(jid)
      }
    }
    return jids.length > 0 ? jids : EMPTY_STRING_ARRAY
  },

  /**
   * Get contact JIDs sorted by presence then name.
   */
  sortedContactJids: (state: RosterState): string[] => {
    const jids = Array.from(state.contacts.keys())
    if (jids.length === 0) return EMPTY_STRING_ARRAY

    return jids.sort((a, b) => {
      const contactA = state.contacts.get(a)!
      const contactB = state.contacts.get(b)!
      const presenceDiff = PRESENCE_ORDER[contactA.presence] - PRESENCE_ORDER[contactB.presence]
      if (presenceDiff !== 0) return presenceDiff
      return contactA.name.localeCompare(contactB.name)
    })
  },

  /**
   * Get a specific contact by JID.
   * Returns a selector function for the given JID.
   */
  contactById: (jid: string) => (state: RosterState): Contact | undefined => {
    return state.contacts.get(jid)
  },

  /**
   * Get presence status for a specific contact.
   */
  presenceFor: (jid: string) => (state: RosterState): PresenceStatus => {
    return state.contacts.get(jid)?.presence ?? 'offline'
  },

  /**
   * Get status message for a specific contact.
   */
  statusMessageFor: (jid: string) => (state: RosterState): string | undefined => {
    return state.contacts.get(jid)?.statusMessage
  },

  /**
   * Get resources for a specific contact.
   */
  resourcesFor: (jid: string) => (state: RosterState): Map<string, ResourcePresence> => {
    return state.contacts.get(jid)?.resources ?? EMPTY_RESOURCE_MAP
  },

  /**
   * Get resource count for a specific contact.
   */
  resourceCountFor: (jid: string) => (state: RosterState): number => {
    return state.contacts.get(jid)?.resources?.size ?? 0
  },

  /**
   * Get avatar URL for a specific contact.
   */
  avatarFor: (jid: string) => (state: RosterState): string | undefined => {
    return state.contacts.get(jid)?.avatar
  },

  /**
   * Check if a contact exists.
   */
  hasContact: (jid: string) => (state: RosterState): boolean => {
    return state.contacts.has(jid)
  },

  /**
   * Get total contact count.
   */
  contactCount: (state: RosterState): number => {
    return state.contacts.size
  },

  /**
   * Get online contact count.
   */
  onlineCount: (state: RosterState): number => {
    let count = 0
    for (const contact of state.contacts.values()) {
      if (contact.presence !== 'offline') count++
    }
    return count
  },

  /**
   * Get offline contact count.
   */
  offlineCount: (state: RosterState): number => {
    let count = 0
    for (const contact of state.contacts.values()) {
      if (contact.presence === 'offline') count++
    }
    return count
  },

  /**
   * Get contact name for a specific JID (or JID if name not set).
   */
  nameFor: (jid: string) => (state: RosterState): string => {
    return state.contacts.get(jid)?.name ?? jid
  },

  /**
   * Get lastSeen date for a specific contact.
   */
  lastSeenFor: (jid: string) => (state: RosterState): Date | undefined => {
    return state.contacts.get(jid)?.lastSeen
  },

  /**
   * Get lastInteraction date for a specific contact.
   */
  lastInteractionFor: (jid: string) => (state: RosterState): Date | undefined => {
    return state.contacts.get(jid)?.lastInteraction
  },

  /**
   * Get presence error for a specific contact.
   */
  presenceErrorFor: (jid: string) => (state: RosterState): string | undefined => {
    return state.contacts.get(jid)?.presenceError
  },

  /**
   * Check if a contact is online (not offline).
   */
  isOnline: (jid: string) => (state: RosterState): boolean => {
    const contact = state.contacts.get(jid)
    return contact !== undefined && contact.presence !== 'offline'
  },

  /**
   * Get subscription state for a specific contact.
   */
  subscriptionFor: (jid: string) => (state: RosterState): string | undefined => {
    return state.contacts.get(jid)?.subscription
  },

  /**
   * Get groups for a specific contact.
   */
  groupsFor: (jid: string) => (state: RosterState): string[] => {
    return state.contacts.get(jid)?.groups ?? EMPTY_STRING_ARRAY
  },

  /**
   * Get all unique group names across all contacts.
   */
  allGroups: (state: RosterState): string[] => {
    const groupSet = new Set<string>()
    for (const contact of state.contacts.values()) {
      if (contact.groups) {
        for (const group of contact.groups) {
          groupSet.add(group)
        }
      }
    }
    const groups = Array.from(groupSet).sort()
    return groups.length > 0 ? groups : EMPTY_STRING_ARRAY
  },

  /**
   * Get consistent color (light theme) for a specific contact.
   */
  colorLightFor: (jid: string) => (state: RosterState): string | undefined => {
    return state.contacts.get(jid)?.colorLight
  },

  /**
   * Get consistent color (dark theme) for a specific contact.
   */
  colorDarkFor: (jid: string) => (state: RosterState): string | undefined => {
    return state.contacts.get(jid)?.colorDark
  },
}
