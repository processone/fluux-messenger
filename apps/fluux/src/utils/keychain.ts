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

export interface DeleteCredentialsOptions {
  /**
   * Force a keychain deletion attempt even when the local "has credentials" flag
   * is missing. Useful for full data wipes where localStorage may be cleared first.
   */
  force?: boolean
}

// Flag to track if credentials exist without triggering keychain prompt
const STORAGE_KEY_HAS_CREDENTIALS = 'xmpp-has-saved-credentials'
const KEYCHAIN_DELETE_TIMEOUT_MS = 2500

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
export async function deleteCredentials(options: DeleteCredentialsOptions = {}): Promise<void> {
  const { force = false } = options
  // If no credentials were saved, skip the keychain call to avoid unnecessary
  // macOS auth dialogs. Clear the local flag in this skip path to recover from
  // stale local state.
  const hadCredentials = localStorage.getItem(STORAGE_KEY_HAS_CREDENTIALS) === 'true'

  if (!isTauri() || (!hadCredentials && !force)) {
    localStorage.removeItem(STORAGE_KEY_HAS_CREDENTIALS)
    console.log('[Fluux] Keychain: delete skipped (no credentials flag, not Tauri, or not forced)')
    return
  }

  try {
    console.log('[Fluux] Keychain: deleting credentials')
    const { invoke } = await import('@tauri-apps/api/core')

    const deleteOp = invoke('delete_credentials').then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error })
    )

    const timeoutSentinel = Symbol('keychain-delete-timeout')
    const result = await Promise.race([
      deleteOp,
      new Promise<typeof timeoutSentinel>((resolve) => {
        setTimeout(() => resolve(timeoutSentinel), KEYCHAIN_DELETE_TIMEOUT_MS)
      }),
    ])

    if (result === timeoutSentinel) {
      throw new Error(`delete_credentials timed out after ${KEYCHAIN_DELETE_TIMEOUT_MS}ms`)
    }

    if (!result.ok) {
      throw result.error
    }

    console.log('[Fluux] Keychain: credentials deleted')
  } catch (error) {
    console.error('[Fluux] Keychain: failed to delete credentials:', error)
  } finally {
    // Clear the local flag even when native keychain access fails/times out.
    // This prevents the app from repeatedly waiting on a broken keychain backend.
    localStorage.removeItem(STORAGE_KEY_HAS_CREDENTIALS)
  }
}
