/**
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { ReactNode } from 'react'
import { createActor } from 'xstate'
import { usePresence } from './usePresence'
import { PresenceContext } from '../provider/PresenceContext'
import { presenceMachine } from '../core/presenceMachine'

// Create a fresh actor for each test
let presenceActor: ReturnType<typeof createActor<typeof presenceMachine>>

// Wrapper component that provides presence context
function wrapper({ children }: { children: ReactNode }) {
  return (
    <PresenceContext.Provider value={{ presenceActor }}>
      {children}
    </PresenceContext.Provider>
  )
}

describe('usePresence hook', () => {
  beforeEach(() => {
    // Create a fresh actor for each test
    presenceActor = createActor(presenceMachine).start()
    vi.clearAllMocks()
  })

  describe('initial state', () => {
    it('should have offline status when disconnected', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      expect(result.current.presenceStatus).toBe('offline')
      expect(result.current.presenceShow).toBeUndefined()
      expect(result.current.statusMessage).toBeNull()
      expect(result.current.isAutoAway).toBe(false)
      expect(result.current.preAutoAwayState).toBeNull()
      expect(result.current.idleSince).toBeNull()
    })
  })

  describe('connection lifecycle', () => {
    it('should transition to online when connect is called', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.connect()
      })

      expect(result.current.presenceStatus).toBe('online')
      expect(result.current.presenceShow).toBeUndefined() // online has no show value
    })

    it('should transition to offline when disconnect is called', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      // First connect
      act(() => {
        result.current.connect()
      })
      expect(result.current.presenceStatus).toBe('online')

      // Then disconnect
      act(() => {
        result.current.disconnect()
      })
      expect(result.current.presenceStatus).toBe('offline')
    })
  })

  describe('presence actions', () => {
    beforeEach(() => {
      // Start in connected state for presence tests
      presenceActor.send({ type: 'CONNECT' })
    })

    it('should set presence to away with setAway', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.setAway()
      })

      expect(result.current.presenceStatus).toBe('away')
      expect(result.current.presenceShow).toBe('away')
    })

    it('should set presence to dnd with setDnd', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.setDnd()
      })

      expect(result.current.presenceStatus).toBe('dnd')
      expect(result.current.presenceShow).toBe('dnd')
    })

    it('should set presence to online with setOnline', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      // First set to away
      act(() => {
        result.current.setAway()
      })
      expect(result.current.presenceStatus).toBe('away')

      // Then set back to online
      act(() => {
        result.current.setOnline()
      })
      expect(result.current.presenceStatus).toBe('online')
    })

    it('should set presence with setPresence', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.setPresence('dnd')
      })

      expect(result.current.presenceStatus).toBe('dnd')
    })

    it('should set status message with presence', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.setAway('In a meeting')
      })

      expect(result.current.presenceStatus).toBe('away')
      expect(result.current.statusMessage).toBe('In a meeting')
    })

    it('should update status message while staying online', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.setPresence('online', 'Heads down')
      })

      expect(result.current.presenceStatus).toBe('online')
      expect(result.current.presenceShow).toBeUndefined()
      expect(result.current.statusMessage).toBe('Heads down')

      act(() => {
        result.current.setPresence('online', undefined)
      })

      expect(result.current.presenceStatus).toBe('online')
      expect(result.current.statusMessage).toBeNull()
    })

    it('should set status message when setting away', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.setAway('In a meeting')
      })

      expect(result.current.presenceStatus).toBe('away')
      expect(result.current.statusMessage).toBe('In a meeting')

      // Change status message by setting away again
      act(() => {
        result.current.setAway('Out for lunch')
      })

      expect(result.current.presenceStatus).toBe('away')
      expect(result.current.statusMessage).toBe('Out for lunch')
    })

    it('should clear status message when set to undefined', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      // Set with message
      act(() => {
        result.current.setAway('BRB')
      })
      expect(result.current.statusMessage).toBe('BRB')

      // Clear message
      act(() => {
        result.current.setAway(undefined)
      })
      expect(result.current.statusMessage).toBeNull()
    })
  })

  describe('auto-away system', () => {
    beforeEach(() => {
      presenceActor.send({ type: 'CONNECT' })
    })

    it('should transition to auto-away when idle detected', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })
      const idleSince = new Date()

      act(() => {
        result.current.idleDetected(idleSince)
      })

      expect(result.current.presenceStatus).toBe('away')
      expect(result.current.isAutoAway).toBe(true)
      expect(result.current.preAutoAwayState).toBe('online')
      expect(result.current.idleSince).toEqual(idleSince)
    })

    it('should restore presence when activity detected', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      // Go to auto-away
      act(() => {
        result.current.idleDetected(new Date())
      })
      expect(result.current.isAutoAway).toBe(true)

      // Activity detected
      act(() => {
        result.current.activityDetected()
      })

      expect(result.current.presenceStatus).toBe('online')
      expect(result.current.isAutoAway).toBe(false)
      expect(result.current.preAutoAwayState).toBeNull()
    })

    it('should not enter auto-away when manually away', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      // Set away manually first
      act(() => {
        result.current.setAway('Be right back')
      })
      expect(result.current.presenceStatus).toBe('away')
      expect(result.current.isAutoAway).toBe(false)

      // Idle detected - should NOT trigger auto-away since user is already manually away
      act(() => {
        result.current.idleDetected(new Date())
      })

      // Should still be manually away, not auto-away
      expect(result.current.presenceStatus).toBe('away')
      expect(result.current.isAutoAway).toBe(false)
      expect(result.current.preAutoAwayState).toBeNull()
    })

    it('should not enter auto-away when already in DND', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      // Set DND first
      act(() => {
        result.current.setDnd()
      })

      // Try to go to auto-away - should be ignored
      act(() => {
        result.current.idleDetected(new Date())
      })

      // Should still be in DND, not auto-away
      expect(result.current.presenceStatus).toBe('dnd')
      expect(result.current.isAutoAway).toBe(false)
    })
  })

  describe('sleep/wake detection', () => {
    beforeEach(() => {
      presenceActor.send({ type: 'CONNECT' })
    })

    it('should transition to sleep state when sleep detected', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.sleepDetected()
      })

      expect(result.current.isAutoAway).toBe(true)
      expect(result.current.preAutoAwayState).toBe('online')
    })

    it('should restore presence when wake detected', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      // Go to sleep
      act(() => {
        result.current.sleepDetected()
      })
      expect(result.current.isAutoAway).toBe(true)

      // Wake up
      act(() => {
        result.current.wakeDetected()
      })

      expect(result.current.presenceStatus).toBe('online')
      expect(result.current.isAutoAway).toBe(false)
    })

    it('should not enter sleep state when in DND', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      // Set DND
      act(() => {
        result.current.setDnd()
      })

      // Sleep detected - should be ignored
      act(() => {
        result.current.sleepDetected()
      })

      expect(result.current.presenceStatus).toBe('dnd')
      expect(result.current.isAutoAway).toBe(false)
    })
  })

  describe('state name for debugging', () => {
    it('should provide state name when connected', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.connect()
      })

      expect(result.current.stateName).toBe('userOnline')
    })

    it('should provide null state name when disconnected', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      expect(result.current.stateName).toBeNull()
    })

    it('should provide auto-away state name', () => {
      const { result } = renderHook(() => usePresence(), { wrapper })

      act(() => {
        result.current.connect()
        result.current.idleDetected(new Date())
      })

      expect(result.current.stateName).toBe('autoAway')
    })
  })

  describe('action stability', () => {
    it('should return stable function references', () => {
      const { result, rerender } = renderHook(() => usePresence(), { wrapper })

      const firstRender = {
        setOnline: result.current.setOnline,
        setAway: result.current.setAway,
        setDnd: result.current.setDnd,
        setPresence: result.current.setPresence,
        connect: result.current.connect,
        disconnect: result.current.disconnect,
        idleDetected: result.current.idleDetected,
        activityDetected: result.current.activityDetected,
        sleepDetected: result.current.sleepDetected,
        wakeDetected: result.current.wakeDetected,
      }

      rerender()

      // All functions should be the same reference (memoized)
      expect(result.current.setOnline).toBe(firstRender.setOnline)
      expect(result.current.setAway).toBe(firstRender.setAway)
      expect(result.current.setDnd).toBe(firstRender.setDnd)
      expect(result.current.setPresence).toBe(firstRender.setPresence)
      expect(result.current.connect).toBe(firstRender.connect)
      expect(result.current.disconnect).toBe(firstRender.disconnect)
      expect(result.current.idleDetected).toBe(firstRender.idleDetected)
      expect(result.current.activityDetected).toBe(firstRender.activityDetected)
      expect(result.current.sleepDetected).toBe(firstRender.sleepDetected)
      expect(result.current.wakeDetected).toBe(firstRender.wakeDetected)
    })
  })
})
