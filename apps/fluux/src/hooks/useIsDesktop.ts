import { useEffect, useState } from 'react'

// Matches Tailwind's `md` breakpoint, which ChatLayout uses for the
// mobile/desktop single-pane split.
const DESKTOP_QUERY = '(min-width: 768px)'

function getMatch(): boolean {
  // SSR / test environments without matchMedia default to desktop.
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia(DESKTOP_QUERY).matches
}

/**
 * Reactive desktop-width check (>= 768px). Re-renders on viewport crossing the
 * breakpoint. Used to gate desktop-only chrome (e.g. the window app bar) that
 * must not render in the mobile single-pane layout.
 */
export function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(getMatch)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(DESKTOP_QUERY)
    const handler = () => setIsDesktop(mq.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  return isDesktop
}
