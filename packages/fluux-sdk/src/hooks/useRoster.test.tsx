/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useRoster } from './useRoster'
import { rosterStore } from '../stores'
import { XMPPProvider } from '../provider'
import type { Contact } from '../core'
import { createMockXMPPClientForHooks } from '../core/test-utils'

// Create shared mock client
const mockClient = createMockXMPPClientForHooks()

vi.mock('../provider', async () => {
  const actual = await vi.importActual('../provider')
  return {
    ...actual,
    useXMPPContext: () => ({ client: mockClient }),
  }
})

// Wrapper component that provides XMPP context
function wrapper({ children }: { children: ReactNode }) {
  return <XMPPProvider>{children}</XMPPProvider>
}

// Helper to create a contact
function createContact(jid: string, name: string, presence: Contact['presence'] = 'offline'): Contact {
  return {
    jid,
    name,
    presence,
    subscription: 'both',
  }
}

describe('useRoster hook', () => {
  beforeEach(() => {
    // Reset store state before each test
    rosterStore.getState().reset()
    vi.clearAllMocks()
  })

  describe('contacts reactivity', () => {
    it('should update when a contact is added to the store', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      expect(result.current.contacts).toHaveLength(0)

      act(() => {
        rosterStore.getState().addOrUpdateContact(createContact('alice@example.com', 'Alice'))
      })

      expect(result.current.contacts).toHaveLength(1)
      expect(result.current.contacts[0].jid).toBe('alice@example.com')
    })

    it('should update when multiple contacts are added', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().setContacts([
          createContact('alice@example.com', 'Alice'),
          createContact('bob@example.com', 'Bob'),
          createContact('carol@example.com', 'Carol'),
        ])
      })

      expect(result.current.contacts).toHaveLength(3)
    })

    it('should update when contact presence changes', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().addOrUpdateContact(createContact('alice@example.com', 'Alice', 'offline'))
      })

      expect(result.current.contacts[0].presence).toBe('offline')

      act(() => {
        rosterStore.getState().updatePresence('alice@example.com/mobile', null, 0)
      })

      expect(result.current.contacts[0].presence).toBe('online')
    })
  })

  describe('sortedContacts', () => {
    it('should sort contacts by presence then name', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().setContacts([
          createContact('zebra@example.com', 'Zebra', 'offline'),
          createContact('alice@example.com', 'Alice', 'online'),
          createContact('bob@example.com', 'Bob', 'away'),
          createContact('carol@example.com', 'Carol', 'online'),
        ])
      })

      const sorted = result.current.sortedContacts

      // Online contacts first (alphabetically)
      expect(sorted[0].name).toBe('Alice')
      expect(sorted[1].name).toBe('Carol')
      // Then away
      expect(sorted[2].name).toBe('Bob')
      // Then offline
      expect(sorted[3].name).toBe('Zebra')
    })
  })

  describe('onlineContacts', () => {
    it('should return only online contacts', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().setContacts([
          createContact('alice@example.com', 'Alice', 'online'),
          createContact('bob@example.com', 'Bob', 'offline'),
          createContact('carol@example.com', 'Carol', 'away'),
          createContact('dave@example.com', 'Dave', 'offline'),
        ])
      })

      const online = result.current.onlineContacts

      expect(online).toHaveLength(2)
      expect(online.map(c => c.name).sort()).toEqual(['Alice', 'Carol'])
    })

    it('should include dnd contacts as online', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().setContacts([
          createContact('alice@example.com', 'Alice', 'dnd'),
          createContact('bob@example.com', 'Bob', 'offline'),
        ])
      })

      expect(result.current.onlineContacts).toHaveLength(1)
      expect(result.current.onlineContacts[0].name).toBe('Alice')
    })
  })

  describe('getContact', () => {
    it('should return contact by JID', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().setContacts([
          createContact('alice@example.com', 'Alice'),
          createContact('bob@example.com', 'Bob'),
        ])
      })

      const alice = result.current.getContact('alice@example.com')
      expect(alice?.name).toBe('Alice')

      const bob = result.current.getContact('bob@example.com')
      expect(bob?.name).toBe('Bob')
    })

    it('should return undefined for non-existent contact', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      const contact = result.current.getContact('unknown@example.com')
      expect(contact).toBeUndefined()
    })
  })

  describe('actions', () => {
    it('should call client.addContact when addContact is called', async () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      mockClient.roster.addContact.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.addContact('newuser@example.com', 'New User')
      })

      expect(mockClient.roster.addContact).toHaveBeenCalledWith('newuser@example.com', 'New User')
    })

    it('should call client.addContact without nickname if not provided', async () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      mockClient.roster.addContact.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.addContact('newuser@example.com')
      })

      expect(mockClient.roster.addContact).toHaveBeenCalledWith('newuser@example.com', undefined)
    })

    it('should call client.removeContact when removeContact is called', async () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      mockClient.roster.removeContact.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.removeContact('alice@example.com')
      })

      expect(mockClient.roster.removeContact).toHaveBeenCalledWith('alice@example.com')
    })

    it('should call client.renameContact when renameContact is called', async () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      mockClient.roster.renameContact.mockResolvedValue(undefined)

      await act(async () => {
        await result.current.renameContact('alice@example.com', 'Alice Smith')
      })

      expect(mockClient.roster.renameContact).toHaveBeenCalledWith('alice@example.com', 'Alice Smith')
    })

    // Removed: Avatar caching was deprecated and removed from SDK
    // it('should call client.restoreContactAvatarFromCache when restoreContactAvatarFromCache is called', ...)

    it('should call client.fetchContactNickname when fetchContactNickname is called', async () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      mockClient.profile.fetchContactNickname.mockResolvedValue('Alice Nickname')

      await act(async () => {
        const nickname = await result.current.fetchContactNickname('alice@example.com')
        expect(nickname).toBe('Alice Nickname')
      })

      expect(mockClient.profile.fetchContactNickname).toHaveBeenCalledWith('alice@example.com')
    })

    it('should call client.profile.fetchVCard when fetchVCard is called', async () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      const vcard = { fullName: 'Alice Smith', org: 'Acme Corp' }
      mockClient.profile.fetchVCard.mockResolvedValue(vcard)

      await act(async () => {
        const res = await result.current.fetchVCard('alice@example.com')
        expect(res).toEqual(vcard)
      })

      expect(mockClient.profile.fetchVCard).toHaveBeenCalledWith('alice@example.com')
    })
  })

  describe('contact updates', () => {
    it('should update when contact avatar changes', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().addOrUpdateContact(createContact('alice@example.com', 'Alice'))
      })

      expect(result.current.contacts[0].avatar).toBeUndefined()

      act(() => {
        rosterStore.getState().updateAvatar('alice@example.com', 'blob:avatar-url', 'hash123')
      })

      expect(result.current.contacts[0].avatar).toBe('blob:avatar-url')
      expect(result.current.contacts[0].avatarHash).toBe('hash123')
    })

    it('should update when contact is removed', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().setContacts([
          createContact('alice@example.com', 'Alice'),
          createContact('bob@example.com', 'Bob'),
        ])
      })

      expect(result.current.contacts).toHaveLength(2)

      act(() => {
        rosterStore.getState().removeContact('alice@example.com')
      })

      expect(result.current.contacts).toHaveLength(1)
      expect(result.current.contacts[0].jid).toBe('bob@example.com')
    })

    it('should update when presence error is set', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().addOrUpdateContact(createContact('alice@example.com', 'Alice', 'online'))
      })

      expect(result.current.contacts[0].presenceError).toBeUndefined()

      act(() => {
        rosterStore.getState().setPresenceError('alice@example.com', 'not-authorized')
      })

      expect(result.current.contacts[0].presenceError).toBe('not-authorized')
      expect(result.current.contacts[0].presence).toBe('offline')
    })
  })

  describe('reference stability (prevents render loops)', () => {
    it('should return stable empty array reference for contacts when no contacts exist', () => {
      const { result, rerender } = renderHook(() => useRoster(), { wrapper })

      const contacts1 = result.current.contacts
      rerender()
      const contacts2 = result.current.contacts

      // Should be the exact same reference (toBe), not just equal content (toEqual)
      expect(contacts1).toBe(contacts2)
    })

    it('should return stable empty array reference for sortedContacts when no contacts exist', () => {
      const { result, rerender } = renderHook(() => useRoster(), { wrapper })

      const sorted1 = result.current.sortedContacts
      rerender()
      const sorted2 = result.current.sortedContacts

      expect(sorted1).toBe(sorted2)
    })

    it('should return stable empty array reference for onlineContacts when no contacts are online', () => {
      const { result, rerender } = renderHook(() => useRoster(), { wrapper })

      // Add only offline contacts
      act(() => {
        rosterStore.getState().setContacts([
          createContact('alice@example.com', 'Alice', 'offline'),
          createContact('bob@example.com', 'Bob', 'offline'),
        ])
      })

      const online1 = result.current.onlineContacts
      rerender()
      const online2 = result.current.onlineContacts

      expect(online1.length).toBe(0)
      expect(online1).toBe(online2)
    })

    it('should maintain stable array reference when unrelated state changes', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().setContacts([
          createContact('alice@example.com', 'Alice', 'online'),
          createContact('bob@example.com', 'Bob', 'offline'),
        ])
      })

      const contacts1 = result.current.contacts
      const sorted1 = result.current.sortedContacts
      const online1 = result.current.onlineContacts

      // Trigger a rerender without changing contacts
      // The arrays should maintain the same content
      expect(contacts1.length).toBe(2)
      expect(sorted1.length).toBe(2)
      expect(online1.length).toBe(1)
    })

    it('should update array reference when contacts actually change', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().setContacts([
          createContact('alice@example.com', 'Alice', 'online'),
        ])
      })

      const contacts1 = result.current.contacts

      act(() => {
        rosterStore.getState().addOrUpdateContact(
          createContact('bob@example.com', 'Bob', 'online')
        )
      })

      const contacts2 = result.current.contacts

      // Content should have changed
      expect(contacts1.length).toBe(1)
      expect(contacts2.length).toBe(2)
      // References should be different (new array created)
      expect(contacts1).not.toBe(contacts2)
    })
  })

  describe('multiple resources', () => {
    it('should aggregate presence from multiple resources', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().addOrUpdateContact(createContact('alice@example.com', 'Alice'))
      })

      // Add first resource as away
      act(() => {
        rosterStore.getState().updatePresence('alice@example.com/mobile', 'away', 0)
      })

      expect(result.current.contacts[0].presence).toBe('away')

      // Add second resource as online with higher priority
      act(() => {
        rosterStore.getState().updatePresence('alice@example.com/desktop', null, 10)
      })

      // Higher priority resource (online) should win
      expect(result.current.contacts[0].presence).toBe('online')
    })

    it('should go offline when all resources disconnect', () => {
      const { result } = renderHook(() => useRoster(), { wrapper })

      act(() => {
        rosterStore.getState().addOrUpdateContact(createContact('alice@example.com', 'Alice'))
        rosterStore.getState().updatePresence('alice@example.com/mobile', null, 0)
      })

      expect(result.current.contacts[0].presence).toBe('online')

      act(() => {
        rosterStore.getState().removePresence('alice@example.com/mobile')
      })

      expect(result.current.contacts[0].presence).toBe('offline')
    })
  })
})
