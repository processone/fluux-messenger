export type FeatureFlag = 'enableMessageVirtualization'

/** Default state per flag (the shipped behavior when localStorage has no override). */
const FLAG_DEFAULTS: Record<FeatureFlag, boolean> = {
  // Message-list virtualization: OFF by default. It bounds the mounted DOM to the visible
  // window (per-interaction render cost stops scaling with resident message count, and it
  // cures the WebKitGTK large-room switch freeze), but its scroll integration is not yet
  // sound: the app manages scroll imperatively (prepend restore, scroll-to-bottom,
  // bottom-stick) assuming accurate, stable heights, while @tanstack reports estimated,
  // shifting heights. The result is prepend drift, scroll-to-bottom landing on a blank
  // window, and bottom-stick oscillation. Kept OFF until scroll ownership is reworked so the
  // virtualizer owns scroll position. Opt in for testing via the localStorage override below.
  enableMessageVirtualization: false,
}

/**
 * Dev/bake feature flags. The default is per-flag (see FLAG_DEFAULTS); a localStorage
 * override (`fluux:flags:<flag>`) forces the flag on (`'true'`) or off (`'false'`):
 *   localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false') // opt out
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  try {
    const stored = localStorage.getItem(`fluux:flags:${flag}`)
    if (stored === 'true') return true
    if (stored === 'false') return false
    return FLAG_DEFAULTS[flag]
  } catch {
    return FLAG_DEFAULTS[flag]
  }
}
