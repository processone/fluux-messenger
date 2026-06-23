import { useState, useEffect } from 'react'

/**
 * Detects whether the device has a precise *hovering* pointer (a mouse or
 * trackpad) versus a touch screen.
 *
 * This is a **capability** query, intentionally distinct from `useIsMobileWeb()`
 * which is a **layout** query gated on viewport width AND on not being Tauri.
 * Conflating the two is a latent bug: a touch laptop or a 2-in-1 in tablet mode
 * is wide and may be Tauri, yet still needs touch affordances; conversely a
 * narrow desktop window with a mouse should keep hover affordances.
 *
 * Use this to decide whether to expose hover-only affordances (e.g. the message
 * hover toolbar) or their touch fallbacks (e.g. a long-press action sheet). It
 * behaves identically in a browser, an installed PWA, and a future Tauri-mobile
 * build because it asks the device, not the platform.
 */

const HOVER_QUERY = '(hover: hover) and (pointer: fine)'

/** Read the current hover capability. Defaults to `true` (assume mouse) when
 *  matchMedia is unavailable (SSR / some test environments) so desktop-oriented
 *  behaviour is the safe fallback. */
function queryHasHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia(HOVER_QUERY).matches
}

/**
 * Reactive hook — `true` when the device has a hovering, fine pointer (mouse).
 * Updates if the capability changes (e.g. a tablet docking to a mouse).
 */
export function useHasHover(): boolean {
  const [hasHover, setHasHover] = useState(queryHasHover)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(HOVER_QUERY)
    const handleChange = (e: MediaQueryListEvent) => setHasHover(e.matches)
    // Re-sync in case the capability changed between initial render and effect.
    setHasHover(mq.matches)
    mq.addEventListener('change', handleChange)
    return () => mq.removeEventListener('change', handleChange)
  }, [])

  return hasHover
}

/**
 * Reactive hook — `true` when the device is touch-primary (no hover / coarse
 * pointer). Convenience inverse of `useHasHover()` for readability at call sites
 * that branch on "is this touch".
 */
export function useIsTouch(): boolean {
  return !useHasHover()
}

/**
 * Non-reactive check — current hover capability without subscribing to changes.
 * Use inside event callbacks where the instantaneous value is enough.
 */
export function hasHover(): boolean {
  return queryHasHover()
}

/**
 * Non-reactive check — current touch-primary state.
 */
export function isTouchDevice(): boolean {
  return !queryHasHover()
}
