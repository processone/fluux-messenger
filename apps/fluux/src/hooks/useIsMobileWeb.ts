import { useState, useEffect } from 'react'
import { platform } from '@/platform'

/**
 * Detects the narrow web/PWA or native mobile layout.
 *
 * Returns true when:
 * - NOT running in the native desktop shell
 * - Viewport width is below the mobile breakpoint (768px)
 *
 * This is used to disable desktop-specific behaviors like auto-selecting
 * the first conversation, since mobile users need to see the sidebar first.
 */

const MOBILE_BREAKPOINT = 768 // Tailwind 'md' breakpoint

/**
 * Hook that returns true for the narrow web/PWA or native mobile layout.
 * Reactive - updates when viewport crosses the breakpoint.
 */
export function useIsMobileWeb(): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined') return false
    if (platform().shell === 'desktop') return false
    return window.innerWidth < MOBILE_BREAKPOINT
  })

  useEffect(() => {
    // The desktop app is never mobile web, whatever its window size.
    if (platform().shell === 'desktop') return

    const mediaQuery = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)

    const handleChange = (e: MediaQueryListEvent) => {
      setIsMobile(e.matches)
    }

    // Set initial value (handles SSR hydration)
    setIsMobile(mediaQuery.matches)

    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  return isMobile
}

/**
 * Non-reactive check for the narrow web/PWA or native mobile layout.
 * Use this in callbacks where you need the current value without subscribing to updates.
 */
export function isMobileWeb(): boolean {
  if (typeof window === 'undefined') return false
  if (platform().shell === 'desktop') return false
  return window.innerWidth < MOBILE_BREAKPOINT
}

/**
 * Non-reactive check for small screen (regardless of platform).
 * Returns true when viewport width is below the mobile breakpoint.
 * Use this for layout decisions that depend on screen size, not platform.
 */
export function isSmallScreen(): boolean {
  if (typeof window === 'undefined') return false
  return window.innerWidth < MOBILE_BREAKPOINT
}
