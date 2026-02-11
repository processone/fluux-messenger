/**
 * Tauri platform detection utilities
 */

/**
 * Check if running in Tauri (desktop app) vs web browser
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Check if running on Linux.
 * Linux users update through their distro package manager, not in-app updates.
 */
export function isLinux(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform?.toLowerCase() || ''
  const userAgent = navigator.userAgent?.toLowerCase() || ''
  return platform.includes('linux') || userAgent.includes('linux')
}

/**
 * Check if in-app updates should be enabled.
 * Enabled only in Tauri on macOS and Windows (not Linux, not web).
 */
export function isUpdaterEnabled(): boolean {
  return isTauri() && !isLinux()
}
