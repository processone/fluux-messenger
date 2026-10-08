import { describe, it, expect, beforeEach } from 'vitest'
import { rosterStore } from './rosterStore'
import type { Contact } from '../core/types'
import { getLocalPart } from '../core/jid'

// Helper to create test contacts
function createContact(jid: string, name?: string, presence: Contact['presence'] = 'offline'): Contact {
  return {
    jid,
    name: name || getLocalPart(jid),
    presence,
    subscription: 'both',
  }
}

describe('rosterStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    rosterStore.getState().reset()
  })

  describe('setContacts', () => {
    it('owns restored contacts and preserves them on a same-account connect', () => {
      rosterStore.getState().setContacts([], 'alice@example.com')
      rosterStore.getState().switchAccount('alice@example.com')
      expect(rosterStore.getState()).toMatchObject({ accountJid: 'alice@example.com', isLoaded: true })
    })

    it('clears retained contacts and load state when switching accounts', () => {
      rosterStore.getState().setContacts([createContact('private@example.com')], 'alice@example.com')
      rosterStore.getState().switchAccount('bob@example.com')
      expect(rosterStore.getState().contacts.size).toBe(0)
      expect(rosterStore.getState()).toMatchObject({ accountJid: 'bob@example.com', isLoaded: false })
      rosterStore.getState().setContacts([])
      expect(rosterStore.getState()).toMatchObject({ accountJid: 'bob@example.com', isLoaded: true })
      rosterStore.getState().reset()
      expect(rosterStore.getState()).toMatchObject({ accountJid: null, isLoaded: false })
    })

    it('distinguishes an uninitialized roster from a loaded empty roster', () => {
      expect(rosterStore.getState().isLoaded).toBe(false)
      rosterStore.getState().resetAllPresence()
      expect(rosterStore.getState().isLoaded).toBe(false)

      rosterStore.getState().setContacts([])
      expect(rosterStore.getState().isLoaded).toBe(true)
      rosterStore.getState().resetAllPresence()
      expect(rosterStore.getState().isLoaded).toBe(true)

      rosterStore.getState().reset()
      expect(rosterStore.getState().isLoaded).toBe(false)
    })

    it('keeps a roster initialized after removing the last contact', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com')])
      rosterStore.getState().removeContact('alice@example.com')
      expect(rosterStore.getState().contacts.size).toBe(0)
      expect(rosterStore.getState().isLoaded).toBe(true)
    })

    it('should set contacts from array', () => {
      const contacts = [
        createContact('alice@example.com', 'Alice'),
        createContact('bob@example.com', 'Bob'),
      ]

      rosterStore.getState().setContacts(contacts)

      expect(rosterStore.getState().contacts.size).toBe(2)
      expect(rosterStore.getState().contacts.get('alice@example.com')?.name).toBe('Alice')
    })
  })

  describe('updatePresence', () => {
    it('should update contact presence from resource', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com')])

      // Update presence with full JID (with resource), show=null means online, priority=0
      rosterStore.getState().updatePresence('alice@example.com/mobile', null, 0)

      expect(rosterStore.getState().contacts.get('alice@example.com')?.presence).toBe('online')
    })

    it('should update contact presence with status message', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com')])

      // show='away', priority=0, status='Be right back'
      rosterStore.getState().updatePresence('alice@example.com/desktop', 'away', 0, 'Be right back')

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      expect(contact?.presence).toBe('away')
      expect(contact?.statusMessage).toBe('Be right back')
    })

    it('should track multiple resources for same contact', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com')])

      // Mobile is online with priority 10
      rosterStore.getState().updatePresence('alice@example.com/mobile', null, 10)
      // Desktop is away with priority 5
      rosterStore.getState().updatePresence('alice@example.com/desktop', 'away', 5, 'Stepped away')

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      // Higher priority (10) wins, so mobile's online presence is shown
      expect(contact?.presence).toBe('online')
      expect(contact?.resources?.size).toBe(2)
    })

    it('should use best presence on priority tie', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com')])

      // Both resources have priority 0
      rosterStore.getState().updatePresence('alice@example.com/mobile', 'away', 0)
      rosterStore.getState().updatePresence('alice@example.com/desktop', 'dnd', 0)

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      // On tie, 'away' is better than 'dnd', so away wins
      expect(contact?.presence).toBe('away')
    })

    it('should prefer chat over online', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com')])

      rosterStore.getState().updatePresence('alice@example.com/mobile', null, 0) // online
      rosterStore.getState().updatePresence('alice@example.com/desktop', 'chat', 0)

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      // chat > online
      expect(contact?.presence).toBe('online') // Both map to 'online' in PresenceStatus
    })
  })

  describe('removePresence', () => {
    it('should remove resource and recalculate aggregated presence', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com')])

      // Two resources online
      rosterStore.getState().updatePresence('alice@example.com/mobile', null, 10)
      rosterStore.getState().updatePresence('alice@example.com/desktop', 'away', 5)

      expect(rosterStore.getState().contacts.get('alice@example.com')?.presence).toBe('online')

      // Mobile goes offline
      rosterStore.getState().removePresence('alice@example.com/mobile')

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      // Only desktop remains, which is away
      expect(contact?.presence).toBe('away')
      expect(contact?.resources?.size).toBe(1)
    })

    it('should set offline when last resource goes away', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com')])

      rosterStore.getState().updatePresence('alice@example.com/mobile', null, 0)
      expect(rosterStore.getState().contacts.get('alice@example.com')?.presence).toBe('online')

      rosterStore.getState().removePresence('alice@example.com/mobile')

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      expect(contact?.presence).toBe('offline')
      expect(contact?.resources).toBeUndefined()
      expect(contact?.lastSeen).toBeDefined() // Should track when they went offline
    })

    it('should not mark offline when other resources remain', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com')])

      rosterStore.getState().updatePresence('alice@example.com/mobile', null, 0)
      rosterStore.getState().updatePresence('alice@example.com/desktop', null, 0)

      // One resource goes offline
      rosterStore.getState().removePresence('alice@example.com/mobile')

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      // Should NOT be offline - desktop is still online
      expect(contact?.presence).toBe('online')
    })
  })

  describe('onlineContacts', () => {
    it('should return only online contacts', () => {
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice', 'online'),
        createContact('bob@example.com', 'Bob', 'offline'),
        createContact('charlie@example.com', 'Charlie', 'away'),
      ])

      const online = rosterStore.getState().onlineContacts()

      expect(online.length).toBe(2)
      expect(online.map(c => c.jid)).toContain('alice@example.com')
      expect(online.map(c => c.jid)).toContain('charlie@example.com')
    })
  })

  describe('resetAllPresence', () => {
    it('should reset all contacts presence to offline', () => {
      // Setup: contacts with various presence states
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice', 'online'),
        createContact('bob@example.com', 'Bob', 'away'),
        createContact('charlie@example.com', 'Charlie', 'dnd'),
      ])

      // Verify initial state
      expect(rosterStore.getState().contacts.get('alice@example.com')?.presence).toBe('online')
      expect(rosterStore.getState().contacts.get('bob@example.com')?.presence).toBe('away')
      expect(rosterStore.getState().contacts.get('charlie@example.com')?.presence).toBe('dnd')

      // Act: reset all presence
      rosterStore.getState().resetAllPresence()

      // Assert: all should be offline
      expect(rosterStore.getState().contacts.get('alice@example.com')?.presence).toBe('offline')
      expect(rosterStore.getState().contacts.get('bob@example.com')?.presence).toBe('offline')
      expect(rosterStore.getState().contacts.get('charlie@example.com')?.presence).toBe('offline')
    })

    it('should clear status messages and resources when resetting presence', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com', 'Alice', 'online')])
      rosterStore.getState().updatePresence('alice@example.com/desktop', 'away', 0, 'On vacation')

      expect(rosterStore.getState().contacts.get('alice@example.com')?.statusMessage).toBe('On vacation')
      expect(rosterStore.getState().contacts.get('alice@example.com')?.resources?.size).toBe(1)

      rosterStore.getState().resetAllPresence()

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      expect(contact?.statusMessage).toBeUndefined()
      expect(contact?.resources).toBeUndefined()
    })

    it('should preserve contact roster data when resetting presence', () => {
      rosterStore.getState().setContacts([
        { jid: 'alice@example.com', name: 'Alice Smith', presence: 'online', subscription: 'both' },
      ])

      rosterStore.getState().resetAllPresence()

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      expect(contact?.name).toBe('Alice Smith')
      expect(contact?.subscription).toBe('both')
      expect(contact?.presence).toBe('offline')
    })
  })

  describe('full auth after failed SM resumption', () => {
    it('should handle the scenario where SM rebind fails and full auth is required', () => {
      // Scenario:
      // 1. User was connected, contacts had presence states
      // 2. Connection dropped
      // 3. SM rebind failed, full auth required
      // 4. After full auth, only online contacts send presence
      // 5. Contacts that went offline during disconnect should show as offline

      // Initial state: Alice and Bob are online, Charlie is offline
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice', 'online'),
        createContact('bob@example.com', 'Bob', 'online'),
        createContact('charlie@example.com', 'Charlie', 'offline'),
      ])

      // Verify Bob is online before disconnect
      expect(rosterStore.getState().contacts.get('bob@example.com')?.presence).toBe('online')

      // Connection dropped, SM rebind failed, full auth required
      // At this point, resetAllPresence should be called
      rosterStore.getState().resetAllPresence()

      // All contacts should now be offline
      expect(rosterStore.getState().contacts.get('alice@example.com')?.presence).toBe('offline')
      expect(rosterStore.getState().contacts.get('bob@example.com')?.presence).toBe('offline')
      expect(rosterStore.getState().contacts.get('charlie@example.com')?.presence).toBe('offline')

      // After reconnect, only Alice sends presence (Bob went offline while we were disconnected)
      rosterStore.getState().updatePresence('alice@example.com/desktop', null, 0)

      // Now Alice should be online, but Bob should remain offline
      // (this is the bug: without resetAllPresence, Bob would still show as online)
      expect(rosterStore.getState().contacts.get('alice@example.com')?.presence).toBe('online')
      expect(rosterStore.getState().contacts.get('bob@example.com')?.presence).toBe('offline')
    })
  })

  describe('presence error handling', () => {
    it('should clear resources when presence error is received', () => {
      // Scenario from real XMPP traffic:
      // 1. Contact has multiple resources online (some with stale cached presence)
      // 2. Server sends presence error (recipient-unavailable)
      // 3. One resource sends unavailable
      // Bug: Without clearing resources, removePresence would recalculate
      // presence from stale resources, showing contact as online with error

      rosterStore.getState().setContacts([createContact('matthew@example.com', 'Matthew')])

      // Two resources come online (one is stale cached presence from server)
      rosterStore.getState().updatePresence('matthew@example.com/yaxim', 'dnd', 0)
      rosterStore.getState().updatePresence('matthew@example.com/poezio', null, 0) // online

      expect(rosterStore.getState().contacts.get('matthew@example.com')?.presence).toBe('online')
      expect(rosterStore.getState().contacts.get('matthew@example.com')?.resources?.size).toBe(2)

      // Server sends presence error from bare JID
      rosterStore.getState().setPresenceError('matthew@example.com', 'recipient-unavailable')

      // Should be offline with error, resources cleared
      const contact = rosterStore.getState().contacts.get('matthew@example.com')
      expect(contact?.presence).toBe('offline')
      expect(contact?.presenceError).toBe('recipient-unavailable')
      expect(contact?.resources).toBeUndefined()

      // Now yaxim goes unavailable - should remain offline (no stale poezio to resurrect)
      rosterStore.getState().removePresence('matthew@example.com/yaxim')

      const afterRemove = rosterStore.getState().contacts.get('matthew@example.com')
      expect(afterRemove?.presence).toBe('offline')
      expect(afterRemove?.presenceError).toBe('recipient-unavailable')
    })

    it('should clear presence error when new presence is received', () => {
      rosterStore.getState().setContacts([createContact('alice@example.com', 'Alice')])

      // Set error state
      rosterStore.getState().setPresenceError('alice@example.com', 'recipient-unavailable')
      expect(rosterStore.getState().contacts.get('alice@example.com')?.presenceError).toBe('recipient-unavailable')

      // New presence comes in - should clear error
      rosterStore.getState().updatePresence('alice@example.com/mobile', null, 0)

      const contact = rosterStore.getState().contacts.get('alice@example.com')
      expect(contact?.presence).toBe('online')
      expect(contact?.presenceError).toBeUndefined()
    })
  })

  describe('contact color generation (XEP-0392)', () => {
    it('should calculate colorLight and colorDark when setting contacts', () => {
      const contacts = [
        createContact('alice@example.com', 'Alice'),
        createContact('bob@example.com', 'Bob'),
      ]

      rosterStore.getState().setContacts(contacts)

      const alice = rosterStore.getState().contacts.get('alice@example.com')
      const bob = rosterStore.getState().contacts.get('bob@example.com')

      // Both should have colors calculated
      expect(alice?.colorLight).toBeDefined()
      expect(alice?.colorDark).toBeDefined()
      expect(bob?.colorLight).toBeDefined()
      expect(bob?.colorDark).toBeDefined()

      // Colors should be hex strings
      expect(alice?.colorLight).toMatch(/^#[0-9a-f]{6}$/i)
      expect(alice?.colorDark).toMatch(/^#[0-9a-f]{6}$/i)
    })

    it('should generate different colors for different JIDs', () => {
      const contacts = [
        createContact('alice@example.com', 'Alice'),
        createContact('bob@example.com', 'Bob'),
      ]

      rosterStore.getState().setContacts(contacts)

      const alice = rosterStore.getState().contacts.get('alice@example.com')
      const bob = rosterStore.getState().contacts.get('bob@example.com')

      // Different JIDs should (usually) have different colors
      // This is probabilistic but for these specific JIDs they should differ
      expect(alice?.colorDark).not.toBe(bob?.colorDark)
    })

    it('should generate consistent colors for the same JID', () => {
      // First set
      rosterStore.getState().setContacts([createContact('alice@example.com', 'Alice')])
      const alice1 = rosterStore.getState().contacts.get('alice@example.com')

      // Reset and set again
      rosterStore.getState().reset()
      rosterStore.getState().setContacts([createContact('alice@example.com', 'Alice')])
      const alice2 = rosterStore.getState().contacts.get('alice@example.com')

      // Same JID should produce same colors
      expect(alice1?.colorLight).toBe(alice2?.colorLight)
      expect(alice1?.colorDark).toBe(alice2?.colorDark)
    })

    it('should calculate colors for new contacts added via addOrUpdateContact', () => {
      // Add new contact
      rosterStore.getState().addOrUpdateContact(createContact('alice@example.com', 'Alice'))

      const alice = rosterStore.getState().contacts.get('alice@example.com')

      expect(alice?.colorLight).toBeDefined()
      expect(alice?.colorDark).toBeDefined()
      expect(alice?.colorLight).toMatch(/^#[0-9a-f]{6}$/i)
    })

    it('should preserve colors when updating existing contact', () => {
      // Add contact
      rosterStore.getState().addOrUpdateContact(createContact('alice@example.com', 'Alice'))
      const aliceOriginal = rosterStore.getState().contacts.get('alice@example.com')

      // Update contact (name change)
      rosterStore.getState().addOrUpdateContact(createContact('alice@example.com', 'Alice Smith'))
      const aliceUpdated = rosterStore.getState().contacts.get('alice@example.com')

      // Colors should be preserved (same JID)
      expect(aliceUpdated?.colorLight).toBe(aliceOriginal?.colorLight)
      expect(aliceUpdated?.colorDark).toBe(aliceOriginal?.colorDark)
      // But name should be updated
      expect(aliceUpdated?.name).toBe('Alice Smith')
    })

    it('should generate darker colors for light theme and lighter colors for dark theme', () => {
      rosterStore.getState().setContacts([createContact('test@example.com')])

      const contact = rosterStore.getState().contacts.get('test@example.com')

      // Parse hex colors to check relative lightness
      const parseLightness = (hex: string) => {
        const r = parseInt(hex.slice(1, 3), 16)
        const g = parseInt(hex.slice(3, 5), 16)
        const b = parseInt(hex.slice(5, 7), 16)
        // Simple perceived lightness formula
        return (r * 0.299 + g * 0.587 + b * 0.114)
      }

      const lightThemeLightness = parseLightness(contact!.colorLight!)
      const darkThemeLightness = parseLightness(contact!.colorDark!)

      // Dark theme colors should be lighter (higher lightness value)
      expect(darkThemeLightness).toBeGreaterThan(lightThemeLightness)
    })
  })

  describe('reference stability', () => {
    it('should return stable empty array reference for onlineContacts when no contacts are online', () => {
      // No contacts at all
      const result1 = rosterStore.getState().onlineContacts()
      const result2 = rosterStore.getState().onlineContacts()

      // Should be the exact same reference (toBe), not just equal (toEqual)
      expect(result1).toBe(result2)
    })

    it('should return stable empty array reference for sortedContacts when no contacts exist', () => {
      const result1 = rosterStore.getState().sortedContacts()
      const result2 = rosterStore.getState().sortedContacts()

      expect(result1).toBe(result2)
    })

    it('should return stable empty array reference for getOfflineContacts when no contacts exist', () => {
      const result1 = rosterStore.getState().getOfflineContacts()
      const result2 = rosterStore.getState().getOfflineContacts()

      expect(result1).toBe(result2)
    })

    it('should return stable empty array for onlineContacts when all contacts are offline', () => {
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice', 'offline'),
        createContact('bob@example.com', 'Bob', 'offline'),
      ])

      const result1 = rosterStore.getState().onlineContacts()
      const result2 = rosterStore.getState().onlineContacts()

      expect(result1.length).toBe(0)
      expect(result1).toBe(result2)
    })

    it('should return stable empty array for getOfflineContacts when all contacts are online', () => {
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice', 'online'),
        createContact('bob@example.com', 'Bob', 'away'),
      ])

      const result1 = rosterStore.getState().getOfflineContacts()
      const result2 = rosterStore.getState().getOfflineContacts()

      expect(result1.length).toBe(0)
      expect(result1).toBe(result2)
    })
  })
})
