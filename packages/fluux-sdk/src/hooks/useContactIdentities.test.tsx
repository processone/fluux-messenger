/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { useContactIdentities } from './useContactIdentities'
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

describe('useContactIdentities hook', () => {
  beforeEach(() => {
    rosterStore.getState().reset()
    vi.clearAllMocks()
  })

  it('should return empty map when no contacts', () => {
    const { result } = renderHook(() => useContactIdentities(), { wrapper })
    expect(result.current.size).toBe(0)
  })

  it('should return identities when contacts exist', () => {
    const { result } = renderHook(() => useContactIdentities(), { wrapper })

    act(() => {
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice'),
        createContact('bob@example.com', 'Bob'),
      ])
    })

    expect(result.current.size).toBe(2)
    const alice = result.current.get('alice@example.com')
    expect(alice?.jid).toBe('alice@example.com')
    expect(alice?.name).toBe('Alice')
    expect(alice?.avatar).toBeUndefined()
    expect(result.current.get('bob@example.com')?.name).toBe('Bob')
  })

  it('should include avatar and color fields', () => {
    const { result } = renderHook(() => useContactIdentities(), { wrapper })

    act(() => {
      rosterStore.getState().setContacts([{
        jid: 'alice@example.com',
        name: 'Alice',
        presence: 'online',
        subscription: 'both',
        avatar: 'blob:avatar-url',
      }])
    })

    const alice = result.current.get('alice@example.com')
    expect(alice?.avatar).toBe('blob:avatar-url')
    // Colors are auto-generated from JID by setContacts (XEP-0392)
    expect(alice?.colorLight).toBeDefined()
    expect(alice?.colorDark).toBeDefined()
  })

  it('should NOT return a new reference when only presence changes', () => {
    const { result } = renderHook(() => useContactIdentities(), { wrapper })

    act(() => {
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice', 'offline'),
      ])
    })

    const mapAfterAdd = result.current

    // Simulate presence update (the main scenario we're optimizing for)
    act(() => {
      rosterStore.getState().updatePresence(
        'alice@example.com/resource1',
        'chat',
        0,
        'Available',
      )
    })

    // The map reference should be the SAME — no re-render needed
    expect(result.current).toBe(mapAfterAdd)
  })

  it('should return a new reference when contact name changes', () => {
    const { result } = renderHook(() => useContactIdentities(), { wrapper })

    act(() => {
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice'),
      ])
    })

    const mapBefore = result.current

    act(() => {
      rosterStore.getState().addOrUpdateContact({
        ...createContact('alice@example.com', 'Alice Renamed'),
      })
    })

    // Should be a new reference since name changed
    expect(result.current).not.toBe(mapBefore)
    expect(result.current.get('alice@example.com')?.name).toBe('Alice Renamed')
  })

  it('should return a new reference when contact avatar changes', () => {
    const { result } = renderHook(() => useContactIdentities(), { wrapper })

    act(() => {
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice'),
      ])
    })

    const mapBefore = result.current

    act(() => {
      rosterStore.getState().updateAvatar('alice@example.com', 'blob:new-avatar')
    })

    // Should be a new reference since avatar changed
    expect(result.current).not.toBe(mapBefore)
    expect(result.current.get('alice@example.com')?.avatar).toBe('blob:new-avatar')
  })

  it('should return a new reference when a contact is added', () => {
    const { result } = renderHook(() => useContactIdentities(), { wrapper })

    act(() => {
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice'),
      ])
    })

    const mapBefore = result.current
    expect(mapBefore.size).toBe(1)

    act(() => {
      rosterStore.getState().addOrUpdateContact(createContact('bob@example.com', 'Bob'))
    })

    expect(result.current).not.toBe(mapBefore)
    expect(result.current.size).toBe(2)
  })

  it('should return a new reference when a contact is removed', () => {
    const { result } = renderHook(() => useContactIdentities(), { wrapper })

    act(() => {
      rosterStore.getState().setContacts([
        createContact('alice@example.com', 'Alice'),
        createContact('bob@example.com', 'Bob'),
      ])
    })

    const mapBefore = result.current
    expect(mapBefore.size).toBe(2)

    act(() => {
      rosterStore.getState().removeContact('bob@example.com')
    })

    expect(result.current).not.toBe(mapBefore)
    expect(result.current.size).toBe(1)
  })

  it('should NOT include presence-related fields', () => {
    const { result } = renderHook(() => useContactIdentities(), { wrapper })

    act(() => {
      const contacts: Contact[] = [{
        jid: 'alice@example.com',
        name: 'Alice',
        presence: 'online',
        statusMessage: 'Working on code',
        subscription: 'both',
        resources: new Map([['resource1', { show: 'chat' as const, priority: 0 }]]),
      }]
      rosterStore.getState().setContacts(contacts)
    })

    const alice = result.current.get('alice@example.com')
    // Only identity fields should be present
    expect(Object.keys(alice!).sort()).toEqual(['avatar', 'colorDark', 'colorLight', 'jid', 'name'])
  })
})
