import { useEffect, useRef, useCallback, type RefObject } from 'react'

export type FocusZone = 'sidebarList' | 'mainContent' | 'composer'

const ZONE_ORDER: FocusZone[] = ['sidebarList', 'mainContent', 'composer']

export interface FocusZoneRefs {
  sidebarList: RefObject<HTMLDivElement>
  mainContent: RefObject<HTMLElement>
  composer: RefObject<HTMLElement>
}

/**
 * Hook for managing Tab cycling between focus zones.
 *
 * Tab cycles through: Sidebar List → Main Content → Composer
 * Shift+Tab reverses the direction.
 *
 * Each zone container should have tabIndex={0} to be focusable.
 * Within zones, arrow keys can be used for navigation (handled separately).
 */
export function useFocusZones(refs: FocusZoneRefs, enabled: boolean = true) {
  const currentZoneRef = useRef<FocusZone>('sidebarList')

  // Get the current focused zone based on active element
  const getCurrentZone = useCallback((): FocusZone | null => {
    const activeElement = document.activeElement

    for (const zone of ZONE_ORDER) {
      const zoneRef = refs[zone]
      if (zoneRef.current?.contains(activeElement)) {
        return zone
      }
    }
    return null
  }, [refs])

  // Focus a specific zone
  const focusZone = useCallback((zone: FocusZone) => {
    const zoneRef = refs[zone]
    if (zoneRef.current) {
      // Try to focus the zone container
      zoneRef.current.focus()
      currentZoneRef.current = zone
      return true
    }
    return false
  }, [refs])

  // Move to the next zone
  const focusNextZone = useCallback(() => {
    const currentZone = getCurrentZone() || currentZoneRef.current
    const currentIndex = ZONE_ORDER.indexOf(currentZone)

    // Try each zone in order, wrapping around
    for (let i = 1; i <= ZONE_ORDER.length; i++) {
      const nextIndex = (currentIndex + i) % ZONE_ORDER.length
      const nextZone = ZONE_ORDER[nextIndex]
      if (focusZone(nextZone)) {
        return true
      }
    }
    return false
  }, [getCurrentZone, focusZone])

  // Move to the previous zone
  const focusPreviousZone = useCallback(() => {
    const currentZone = getCurrentZone() || currentZoneRef.current
    const currentIndex = ZONE_ORDER.indexOf(currentZone)

    // Try each zone in reverse order, wrapping around
    for (let i = 1; i <= ZONE_ORDER.length; i++) {
      const prevIndex = (currentIndex - i + ZONE_ORDER.length) % ZONE_ORDER.length
      const prevZone = ZONE_ORDER[prevIndex]
      if (focusZone(prevZone)) {
        return true
      }
    }
    return false
  }, [getCurrentZone, focusZone])

  // Handle Tab key to cycle between zones, and Arrow keys outside zones to focus sidebar
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      const activeElement = document.activeElement as HTMLElement

      // Don't handle if focus is in a modal
      const isInModal = activeElement?.closest('[data-modal="true"], .fixed.z-50')
      if (isInModal) return

      // Handle arrow keys when outside focus zones - focus sidebar
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const currentZone = getCurrentZone()
        if (!currentZone) {
          // Don't steal arrow keys from text editing contexts outside zones
          // (e.g., XMPP console textarea). Inside zones, the zone or
          // component handles arrow keys (e.g., composer ArrowUp to edit).
          if (
            activeElement?.tagName === 'INPUT' ||
            activeElement?.tagName === 'TEXTAREA' ||
            activeElement?.isContentEditable
          ) {
            return
          }
          // Check if focus is in the XMPP console log - let it handle its own arrow keys
          if (activeElement?.closest('.xmpp-console-log')) {
            return
          }
          // Not in any zone, focus the sidebar
          e.preventDefault()
          focusZone('sidebarList')
          return
        }
        // If in a zone, let the zone handle arrow keys
        return
      }

      // Only handle Tab key for zone cycling
      if (e.key !== 'Tab') return

      // Check if we're in a zone
      const currentZone = getCurrentZone()

      // Handle Tab from input/textarea elements
      const target = e.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        // If in the composer zone, intercept Tab to move between zones
        // This prevents Tab from going to interactive elements inside messages
        if (currentZone === 'composer') {
          e.preventDefault()
          if (e.shiftKey) {
            focusPreviousZone()
          } else {
            focusNextZone()
          }
          return
        }

        // For other zones (e.g., input fields in sidebar), let browser handle it
        return
      }

      if (!currentZone) {
        // Not in any zone, focus the first one
        e.preventDefault()
        focusZone('sidebarList')
        return
      }

      // Move between zones
      e.preventDefault()
      if (e.shiftKey) {
        focusPreviousZone()
      } else {
        focusNextZone()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, getCurrentZone, focusZone, focusNextZone, focusPreviousZone])

  return {
    focusZone,
    focusNextZone,
    focusPreviousZone,
    getCurrentZone,
  }
}
