/**
 * Tauri platform detection utilities
 */

/**
 * Check if running in Tauri (desktop app) vs web browser
 */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}
