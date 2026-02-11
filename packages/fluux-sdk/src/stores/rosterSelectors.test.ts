import { describe, it, expect } from 'vitest'
import { rosterSelectors } from './rosterSelectors'
import type { RosterState } from './rosterStore'
import type { Contact, ResourcePresence } from '../core/types'

/**
 * Create a minimal RosterState mock for testing selectors.
 */
function createMockState(overrides: Partial<RosterState> = {}): RosterState {
  return {
    contacts: new Map(),
    // Actions are not needed for selector tests
    setContacts: () => {},
    addOrUpdateContact: () => {},
    updateContact: () => {},
    updatePresence: () => {},
    removePresence: () => {},
    setPresenceError: () => {},
    updateAvatar: () => {},
    removeContact: () => {},
    hasContact: () => false,
    getContact: () => undefined,
    getOfflineContacts: () => [],
    resetAllPresence: () => {},
    reset: () => {},
    onlineContacts: () => [],
    sortedContacts: () => [],
    ...overrides,
  }
}

function createMockContact(jid: string, overrides: Partial<Contact> = {}): Contact {
  return {
    jid,
    name: `Contact ${jid}`,
    presence: 'offline',
    subscription: 'both',
    ...overrides,
  }
}

describe('rosterSelectors', () => {
  describe('contactJids', () => {
    it('should return empty array when no contacts', () => {
      const state = createMockState()
      const result = rosterSelectors.contactJids(state)
      expect(result).toEqual([])
    })

    it('should return all contact JIDs', () => {
      const contacts = new Map<string, Contact>([
        ['user1@example.com', createMockContact('user1@example.com')],
        ['user2@example.com', createMockContact('user2@example.com')],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.contactJids(state)
      expect(result).toContain('user1@example.com')
      expect(result).toContain('user2@example.com')
    })

    it('should return stable empty array reference', () => {
      const state = createMockState()
      const result1 = rosterSelectors.contactJids(state)
      const result2 = rosterSelectors.contactJids(state)
      expect(result1).toBe(result2)
    })
  })

  describe('onlineContactJids', () => {
    it('should return only online contact JIDs', () => {
      const contacts = new Map<string, Contact>([
        ['user1@example.com', createMockContact('user1@example.com', { presence: 'online' })],
        ['user2@example.com', createMockContact('user2@example.com', { presence: 'offline' })],
        ['user3@example.com', createMockContact('user3@example.com', { presence: 'away' })],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.onlineContactJids(state)
      expect(result).toContain('user1@example.com')
      expect(result).toContain('user3@example.com')
      expect(result).not.toContain('user2@example.com')
    })
  })

  describe('offlineContactJids', () => {
    it('should return only offline contact JIDs', () => {
      const contacts = new Map<string, Contact>([
        ['user1@example.com', createMockContact('user1@example.com', { presence: 'online' })],
        ['user2@example.com', createMockContact('user2@example.com', { presence: 'offline' })],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.offlineContactJids(state)
      expect(result).toEqual(['user2@example.com'])
    })
  })

  describe('sortedContactJids', () => {
    it('should return JIDs sorted by presence then name', () => {
      const contacts = new Map<string, Contact>([
        ['zebra@example.com', createMockContact('zebra@example.com', { name: 'Zebra', presence: 'online' })],
        ['alpha@example.com', createMockContact('alpha@example.com', { name: 'Alpha', presence: 'offline' })],
        ['beta@example.com', createMockContact('beta@example.com', { name: 'Beta', presence: 'online' })],
        ['gamma@example.com', createMockContact('gamma@example.com', { name: 'Gamma', presence: 'away' })],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.sortedContactJids(state)
      // Online first (sorted by name), then away, then offline
      expect(result).toEqual(['beta@example.com', 'zebra@example.com', 'gamma@example.com', 'alpha@example.com'])
    })
  })

  describe('contactById', () => {
    it('should return contact for given JID', () => {
      const contact = createMockContact('user@example.com')
      const contacts = new Map([['user@example.com', contact]])
      const state = createMockState({ contacts })
      const result = rosterSelectors.contactById('user@example.com')(state)
      expect(result).toBe(contact)
    })

    it('should return undefined for unknown JID', () => {
      const state = createMockState()
      const result = rosterSelectors.contactById('unknown@example.com')(state)
      expect(result).toBeUndefined()
    })
  })

  describe('presenceFor', () => {
    it('should return presence status for contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { presence: 'dnd' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.presenceFor('user@example.com')(state)).toBe('dnd')
    })

    it('should return offline for unknown contact', () => {
      const state = createMockState()
      expect(rosterSelectors.presenceFor('unknown@example.com')(state)).toBe('offline')
    })
  })

  describe('statusMessageFor', () => {
    it('should return status message for contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { statusMessage: 'On vacation' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.statusMessageFor('user@example.com')(state)).toBe('On vacation')
    })
  })

  describe('resourcesFor', () => {
    it('should return resources for contact', () => {
      const resources = new Map<string, ResourcePresence>([
        ['phone', { show: null, priority: 5 }],
        ['laptop', { show: 'away', priority: 10 }],
      ])
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { resources })],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.resourcesFor('user@example.com')(state)
      expect(result).toBe(resources)
    })

    it('should return empty map for no resources', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com')],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.resourcesFor('user@example.com')(state)
      expect(result.size).toBe(0)
    })
  })

  describe('resourceCountFor', () => {
    it('should return resource count for contact', () => {
      const resources = new Map<string, ResourcePresence>([
        ['phone', { show: null, priority: 5 }],
        ['laptop', { show: 'away', priority: 10 }],
      ])
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { resources })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.resourceCountFor('user@example.com')(state)).toBe(2)
    })
  })

  describe('avatarFor', () => {
    it('should return avatar URL for contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { avatar: 'blob:abc123' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.avatarFor('user@example.com')(state)).toBe('blob:abc123')
    })
  })

  describe('hasContact', () => {
    it('should return true for existing contact', () => {
      const contacts = new Map([['user@example.com', createMockContact('user@example.com')]])
      const state = createMockState({ contacts })
      expect(rosterSelectors.hasContact('user@example.com')(state)).toBe(true)
    })

    it('should return false for non-existing contact', () => {
      const state = createMockState()
      expect(rosterSelectors.hasContact('user@example.com')(state)).toBe(false)
    })
  })

  describe('contactCount', () => {
    it('should return total contact count', () => {
      const contacts = new Map<string, Contact>([
        ['user1@example.com', createMockContact('user1@example.com')],
        ['user2@example.com', createMockContact('user2@example.com')],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.contactCount(state)).toBe(2)
    })
  })

  describe('onlineCount', () => {
    it('should return online contact count', () => {
      const contacts = new Map<string, Contact>([
        ['user1@example.com', createMockContact('user1@example.com', { presence: 'online' })],
        ['user2@example.com', createMockContact('user2@example.com', { presence: 'offline' })],
        ['user3@example.com', createMockContact('user3@example.com', { presence: 'away' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.onlineCount(state)).toBe(2)
    })
  })

  describe('offlineCount', () => {
    it('should return offline contact count', () => {
      const contacts = new Map<string, Contact>([
        ['user1@example.com', createMockContact('user1@example.com', { presence: 'online' })],
        ['user2@example.com', createMockContact('user2@example.com', { presence: 'offline' })],
        ['user3@example.com', createMockContact('user3@example.com', { presence: 'offline' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.offlineCount(state)).toBe(2)
    })
  })

  describe('nameFor', () => {
    it('should return name for contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { name: 'John Doe' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.nameFor('user@example.com')(state)).toBe('John Doe')
    })

    it('should return JID for unknown contact', () => {
      const state = createMockState()
      expect(rosterSelectors.nameFor('user@example.com')(state)).toBe('user@example.com')
    })
  })

  describe('lastSeenFor', () => {
    it('should return lastSeen date for contact', () => {
      const lastSeen = new Date('2024-01-15')
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { lastSeen })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.lastSeenFor('user@example.com')(state)).toBe(lastSeen)
    })
  })

  describe('lastInteractionFor', () => {
    it('should return lastInteraction date for contact', () => {
      const lastInteraction = new Date('2024-01-16')
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { lastInteraction })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.lastInteractionFor('user@example.com')(state)).toBe(lastInteraction)
    })
  })

  describe('presenceErrorFor', () => {
    it('should return presence error for contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { presenceError: 'forbidden' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.presenceErrorFor('user@example.com')(state)).toBe('forbidden')
    })
  })

  describe('isOnline', () => {
    it('should return true for online contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { presence: 'online' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.isOnline('user@example.com')(state)).toBe(true)
    })

    it('should return true for away contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { presence: 'away' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.isOnline('user@example.com')(state)).toBe(true)
    })

    it('should return false for offline contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { presence: 'offline' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.isOnline('user@example.com')(state)).toBe(false)
    })

    it('should return false for unknown contact', () => {
      const state = createMockState()
      expect(rosterSelectors.isOnline('unknown@example.com')(state)).toBe(false)
    })
  })

  describe('subscriptionFor', () => {
    it('should return subscription state for contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { subscription: 'from' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.subscriptionFor('user@example.com')(state)).toBe('from')
    })
  })

  describe('groupsFor', () => {
    it('should return groups for contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { groups: ['Friends', 'Work'] })],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.groupsFor('user@example.com')(state)
      expect(result).toEqual(['Friends', 'Work'])
    })

    it('should return empty array for no groups', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com')],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.groupsFor('user@example.com')(state)
      expect(result).toEqual([])
    })
  })

  describe('allGroups', () => {
    it('should return all unique groups sorted', () => {
      const contacts = new Map<string, Contact>([
        ['user1@example.com', createMockContact('user1@example.com', { groups: ['Friends', 'Work'] })],
        ['user2@example.com', createMockContact('user2@example.com', { groups: ['Family', 'Friends'] })],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.allGroups(state)
      expect(result).toEqual(['Family', 'Friends', 'Work'])
    })

    it('should return empty array when no groups', () => {
      const contacts = new Map<string, Contact>([
        ['user@example.com', createMockContact('user@example.com')],
      ])
      const state = createMockState({ contacts })
      const result = rosterSelectors.allGroups(state)
      expect(result).toEqual([])
    })
  })

  describe('colorLightFor', () => {
    it('should return light theme color for contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { colorLight: '#ff6b6b' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.colorLightFor('user@example.com')(state)).toBe('#ff6b6b')
    })
  })

  describe('colorDarkFor', () => {
    it('should return dark theme color for contact', () => {
      const contacts = new Map([
        ['user@example.com', createMockContact('user@example.com', { colorDark: '#4ecdc4' })],
      ])
      const state = createMockState({ contacts })
      expect(rosterSelectors.colorDarkFor('user@example.com')(state)).toBe('#4ecdc4')
    })
  })
})
