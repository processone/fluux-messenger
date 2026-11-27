import { isDatePillVisible } from '@/components/conversation/datePillFocus'
import { useEffect, useRef, useCallback, type RefObject } from 'react'

export type FocusZone = 'sidebarList' | 'mainContent' | 'composer' | 'account'

const ZONE_ORDER: FocusZone[] = ['sidebarList', 'mainContent', 'composer', 'account']

export interface FocusZoneRefs {
  sidebarList: RefObject<HTMLDivElement | null>
  mainContent: RefObject<HTMLElement | null>
  composer: RefObject<HTMLElement | null>
  /** The sidebar account row; skipped when it is not mounted. */
  account?: RefObject<HTMLElement | null>
}

/**
 * Hook for managing Tab cycling between focus zones.
 *
 * Tab cycles through: Sidebar List → Main Content → Composer → Account row
 * Shift+Tab reverses the direction.
 *
 * Each zone container should have tabIndex={0} to be focusable.
 * Conversation actions precede Main Content; visible date pills follow it.
 * Within zones, arrow keys can be used for navigation (handled separately).
 */
export function useFocusZones(refs: FocusZoneRefs, enabled: boolean = true) {
  const currentZoneRef = useRef<FocusZone>('sidebarList')
  const refsRef = useRef(refs)
  refsRef.current = refs

  // Get the current focused zone based on active element
  const getCurrentZone = useCallback((): FocusZone | null => {
    const activeElement = document.activeElement
    const currentRefs = refsRef.current

    for (const zone of ZONE_ORDER) {
      const zoneRef = currentRefs[zone]
      if (zoneRef?.current?.contains(activeElement)) {
        return zone
      }
    }
    return null
  }, [])

  // Focus a specific zone
  const focusZone = useCallback((zone: FocusZone) => {
    const zoneRef = refsRef.current[zone]
    if (zoneRef?.current) {
      // Try to focus the zone container
      zoneRef.current.focus()
      // A zone that is mounted but hidden (the sidebar behind an open conversation on a
      // phone) cannot take focus: report that so the cycle moves on instead of sticking.
      if (zone === 'account' && document.activeElement !== zoneRef.current) return false
      currentZoneRef.current = zone
      return true
    }
    return false
  }, [])

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
      if (e.key !== 'Tab' || e.defaultPrevented) return

      // Check if we're in a zone
      const currentZone = getCurrentZone()

      if (currentZone !== 'composer' && (activeElement?.matches('input, textarea') || activeElement?.isContentEditable)) return

      // Conversation actions and visible day pills belong to the message zone's
      // Tab route; unrelated per-message controls still use the existing zone hop.
      const main = refsRef.current.mainContent.current
      const conversation = main?.closest('[data-conversation-thread]')
      const dateStops = conversation
        ? [...conversation.querySelectorAll<HTMLElement>('[data-header-overflow-trigger], [data-date-pill]')].filter(isDatePillVisible)
        : []
      if (dateStops.length) {
        const stops = ZONE_ORDER.flatMap(zone => {
          const element = refsRef.current[zone]?.current
          if (!element) return []
          if (zone !== 'mainContent') return [element]
          return [
            ...dateStops.filter(stop => stop.hasAttribute('data-header-overflow-trigger')),
            element,
            ...dateStops.filter(stop => stop.hasAttribute('data-date-pill')),
          ]
        })
        const current = stops.includes(activeElement) ? activeElement : currentZone ? refsRef.current[currentZone]?.current : null
        const index = current ? stops.findIndex(stop => stop === current) : e.shiftKey ? 0 : -1
        e.preventDefault()
        for (let step = 1; step <= stops.length; step++) {
          const next = stops[(index + (e.shiftKey ? -step : step) + stops.length) % stops.length]
          next.focus({ preventScroll: true })
          if (document.activeElement === next) break
        }
        return
      }

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
