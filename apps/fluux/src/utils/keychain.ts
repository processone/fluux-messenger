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

  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('save_credentials', { jid, password, server })
  // Set flag so we know to check keychain on next launch
  localStorage.setItem(STORAGE_KEY_HAS_CREDENTIALS, 'true')
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
    const { invoke } = await import('@tauri-apps/api/core')
    const result = await invoke<StoredCredentials | null>('get_credentials')
    return result
  } catch (error) {
    console.error('Failed to get credentials from keychain:', error)
    return null
  }
}

/**
 * Delete credentials from OS keychain (Tauri only)
 */
export async function deleteCredentials(): Promise<void> {
  // Always clear the flag, even if not in Tauri
  localStorage.removeItem(STORAGE_KEY_HAS_CREDENTIALS)

  if (!isTauri()) {
    return
  }

  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke('delete_credentials')
  } catch (error) {
    console.error('Failed to delete credentials from keychain:', error)
  }
}
