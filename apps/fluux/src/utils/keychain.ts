/**
 * Keychain utilities for storing credentials securely
 * Uses native OS keychain via Tauri commands (macOS Keychain, Windows Credential Manager, etc.)
 */

// Note: invoke is imported dynamically inside functions to avoid loading Tauri APIs in web mode

import { isTauri } from './tauri'

export interface StoredCredentials {
  jid: string
  password: string
  server: string | null
}

// Flag to track if credentials exist without triggering keychain prompt
const STORAGE_KEY_HAS_CREDENTIALS = 'xmpp-has-saved-credentials'

/**
 * Check if credentials might be saved (without triggering keychain prompt)
 * This allows showing the login form immediately on first run
 */
export function hasSavedCredentials(): boolean {
  return localStorage.getItem(STORAGE_KEY_HAS_CREDENTIALS) === 'true'
}

/**
 * Save credentials to OS keychain (Tauri only)
 */
export async function saveCredentials(
  jid: string,
  password: string,
  server: string | null
): Promise<void> {
  if (!isTauri()) {
    console.warn('Keychain storage is only available in the desktop app')
    return
  }

  console.log('[Fluux] Keychain: saving credentials')
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('save_credentials', { jid, password, server })
  // Set flag so we know to check keychain on next launch
  localStorage.setItem(STORAGE_KEY_HAS_CREDENTIALS, 'true')
  console.log('[Fluux] Keychain: credentials saved')
}

/**
 * Get credentials from OS keychain (Tauri only)
 * Returns null if no credentials are stored or if not running in Tauri
 */
export async function getCredentials(): Promise<StoredCredentials | null> {
  if (!isTauri()) {
    return null
  }

  try {
    console.log('[Fluux] Keychain: loading credentials')
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<StoredCredentials | null>('get_credentials')
    // If credentials were expected but not found, clear the flag to stay in sync
    if (result === null) {
      console.log('[Fluux] Keychain: no credentials found, clearing flag')
      localStorage.removeItem(STORAGE_KEY_HAS_CREDENTIALS)
    } else {
      console.log('[Fluux] Keychain: credentials loaded')
    }
    return result
  } catch (error) {
    console.error('[Fluux] Keychain: failed to get credentials:', error)
    // Clear flag on error to prevent repeated failed attempts
    localStorage.removeItem(STORAGE_KEY_HAS_CREDENTIALS)
    return null
  }
}

/**
 * Delete credentials from OS keychain (Tauri only).
 * Skips the keychain call if no credentials were previously saved,
 * avoiding unnecessary macOS auth dialogs.
 */
export async function deleteCredentials(): Promise<void> {
  // If no credentials were saved, just clear the flag and skip the keychain call.
  // This avoids triggering the macOS Keychain auth dialog when there's nothing to delete.
  const hadCredentials = localStorage.getItem(STORAGE_KEY_HAS_CREDENTIALS) === 'true'
  localStorage.removeItem(STORAGE_KEY_HAS_CREDENTIALS)

  if (!isTauri() || !hadCredentials) {
    console.log('[Fluux] Keychain: delete skipped (no credentials flag or not Tauri)')
    return
  }

  try {
    console.log('[Fluux] Keychain: deleting credentials')
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('delete_credentials')
    console.log('[Fluux] Keychain: credentials deleted')
  } catch (error) {
    console.error('[Fluux] Keychain: failed to delete credentials:', error)
  }
}
