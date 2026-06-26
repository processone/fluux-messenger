export type FeatureFlag = 'enableMessageVirtualization'

/** Default state per flag (the shipped behavior when localStorage has no override). */
const FLAG_DEFAULTS: Record<FeatureFlag, boolean> = {
  // Message-list virtualization: ON. Bounds the mounted DOM to the visible window so
  // per-interaction render cost stops scaling with resident message count, and cures the
  // WebKitGTK large-room switch freeze. Scroll integration proven by 6 Playwright
  // invariants (chromium + webkit): prepend anchor within 20px, no oscillation, FAB
  // scroll-to-bottom lands correctly, windowing active. Opt out via localStorage override.
  enableMessageVirtualization: true,
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
