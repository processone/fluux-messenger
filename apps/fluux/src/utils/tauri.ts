/**
 * Tauri platform detection utilities.
 *
 * Superseded by `@/platform`, which derives every platform-dependent answer
 * once and names it. These probes remain for the hooks and components that
 * still branch on them directly; do not add callers.
 */

import { platform } from '@/platform'

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

/** Check if running on Windows. */
export function isWindows(): boolean {
  if (typeof navigator === 'undefined') return false
  const platform = navigator.platform?.toLowerCase() || ''
  const userAgent = navigator.userAgent?.toLowerCase() || ''
  return platform.includes('win') || userAgent.includes('windows')
}

/**
 * Check if in-app updates should be enabled.
 * Enabled only in Tauri on macOS and Windows (not Linux, not web).
 */
export function isUpdaterEnabled(): boolean {
  return platform().hasInAppUpdates
}
