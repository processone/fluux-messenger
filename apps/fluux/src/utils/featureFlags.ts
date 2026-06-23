export type FeatureFlag = 'enableMessageVirtualization'

/**
 * Dev/bake feature flags, persisted in localStorage (`fluux:flags:<flag>`). Default OFF.
 * Flip on for a session with:
 *   localStorage.setItem('fluux:flags:enableMessageVirtualization', 'true')
 */
export function isFeatureEnabled(flag: FeatureFlag): boolean {
  try {
    return localStorage.getItem(`fluux:flags:${flag}`) === 'true'
  } catch {
    return false
  }
}
