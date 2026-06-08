/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useRoster } from './useRoster'
import { useContactIdentities } from './useContactIdentities'
import { rosterStore } from '../stores'
import {
  wrapper,
  useRenderCount,
  generateContacts,
} from './renderStability.helpers'

describe('useRoster render stability', () => {
  beforeEach(() => {
    rosterStore.setState({
      contacts: new Map(),
    })
  })

  it('should render linearly during a presence flood', () => {
    // Set up 100 contacts, all offline
    const contacts = generateContacts(100)

    act(() => {
      rosterStore.getState().setContacts(contacts)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoster()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Simulate presence flood: 100 contacts come online
    act(() => {
      contacts.forEach(contact => {
        rosterStore.getState().updatePresence(
          `${contact.jid}/resource`,
          'chat',
          0,
          undefined,
          undefined,
          undefined
        )
      })
    })

    const totalRenders = result.current.renderCount - rendersAfterMount

    // Each presence update mutates the contacts Map → new reference → useShallow re-evaluates.
    // Inside act(), updates are batched, so we expect bounded renders.
    // Key assertion: not O(n²)
    expect(totalRenders).toBeLessThanOrEqual(100)

    // Verify the presence changes applied
    expect(result.current.onlineContacts.length).toBe(100)
  })

  it('should handle individual presence updates linearly', () => {
    // Set up 10 contacts, all offline
    const contacts = generateContacts(10)

    act(() => {
      rosterStore.getState().setContacts(contacts)
    })

    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoster()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Update presence one at a time (outside batch)
    for (let i = 0; i < 10; i++) {
      act(() => {
        rosterStore.getState().updatePresence(
          `${contacts[i].jid}/resource`,
          'chat',
          0,
          undefined,
          undefined,
          undefined
        )
      })
    }

    const totalRenders = result.current.renderCount - rendersAfterMount

    // Each individual update should cause at most 1 render
    expect(totalRenders).toBeLessThanOrEqual(10)
    expect(result.current.onlineContacts.length).toBe(10)
  })

  it('should re-render with correct sorted order after presence changes', () => {
    const contacts = generateContacts(5)

    act(() => {
      rosterStore.getState().setContacts(contacts)
    })

    const { result } = renderHook(
      () => useRoster(),
      { wrapper }
    )

    // All offline — sorted alphabetically
    expect(result.current.sortedContacts.length).toBe(5)
    expect(result.current.sortedContacts.every(c => c.presence === 'offline')).toBe(true)

    // Bring contact 3 online
    act(() => {
      rosterStore.getState().updatePresence(
        `${contacts[3].jid}/resource`,
        'chat',
        0,
        undefined,
        undefined,
        undefined
      )
    })

    // Contact 3 should now be first (online before offline)
    expect(result.current.sortedContacts[0].jid).toBe(contacts[3].jid)
  })

  it('should handle bulk contact setup without excessive renders', () => {
    const { result } = renderHook(
      () => {
        const renderCount = useRenderCount()
        const hookResult = useRoster()
        return { renderCount, ...hookResult }
      },
      { wrapper }
    )

    const rendersAfterMount = result.current.renderCount

    // Set 500 contacts at once
    const contacts = generateContacts(500)
    act(() => {
      rosterStore.getState().setContacts(contacts)
    })

    const totalRenders = result.current.renderCount - rendersAfterMount

    // setContacts is a single setState call — should be 1 render
    expect(totalRenders).toBeLessThanOrEqual(2)
    expect(result.current.contacts.length).toBe(500)
  })

  // Source proof for the RoomView fix: useRoster() subscribes to contacts/sortedContacts/
  // onlineContacts, so it re-renders on every presence stanza. useContactIdentities()
  // returns a stable ref unless an identity field (name/avatar/color) changes — so it is
  // immune to presence-only churn. RoomView builds its contactsByJid avatar-lookup map, and
  // that map is a memo-breaking prop on every message row (RoomView.tsx comment) and
  // OccupantRow (comparator) — so sourcing it from useContactIdentities stops presence
  // churn from re-rendering those rows.
  it('useContactIdentities() is immune to presence churn, unlike useRoster()', () => {
    const contacts = generateContacts(10)
    act(() => {
      rosterStore.getState().setContacts(contacts)
    })

    const rosterHook = renderHook(() => {
      const renderCount = useRenderCount()
      useRoster()
      return renderCount
    }, { wrapper })
    const identHook = renderHook(() => {
      const renderCount = useRenderCount()
      useContactIdentities()
      return renderCount
    }, { wrapper })

    const rosterBefore = rosterHook.result.current
    const identBefore = identHook.result.current

    // Presence-only burst: 10 contacts come online (identity fields unchanged), each in its
    // own act() so renders are not coalesced.
    for (let i = 0; i < 10; i++) {
      act(() => {
        rosterStore.getState().updatePresence(
          `${contacts[i].jid}/resource`, 'chat', 0, undefined, undefined, undefined
        )
      })
    }

    // useRoster re-renders on each presence update...
    expect(rosterHook.result.current - rosterBefore).toBeGreaterThan(0)
    // ...useContactIdentities does NOT (name/avatar/color unchanged).
    expect(identHook.result.current - identBefore).toBe(0)
  })
})
