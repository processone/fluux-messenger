/**
 * Default storage adapter using browser sessionStorage.
 *
 * This adapter is suitable for web apps where:
 * - Session state persists across page reloads (within same tab)
 * - Session state is cleared when the tab/browser closes
 * - No secure credential storage (credentials must be re-entered)
 *
 * For desktop apps with secure credential storage, use a custom adapter
 * that integrates with the OS keychain.
 *
 * @packageDocumentation
 * @module Utils
 */

import type { StorageAdapter, SessionState } from '../core/types'

/** Storage key prefix for all SDK data */
const PREFIX = 'fluux:'

/** Keys for different data types */
const KEYS = {
  session: (jid: string) => `${PREFIX}session:${jid}`,
  roster: (jid: string) => `${PREFIX}roster:${jid}`,
  rooms: (jid: string) => `${PREFIX}rooms:${jid}`,
  serverInfo: (jid: string) => `${PREFIX}server-info:${jid}`,
  profile: (jid: string) => `${PREFIX}profile:${jid}`,
}

/**
 * Check if sessionStorage is available.
 *
 * sessionStorage may be unavailable in:
 * - Private browsing mode (some browsers)
 * - Server-side rendering
 * - Certain iframe contexts
 */
function isSessionStorageAvailable(): boolean {
  try {
    const testKey = '__fluux_test__'
    sessionStorage.setItem(testKey, 'test')
    sessionStorage.removeItem(testKey)
    return true
  } catch {
    return false
  }
}

/**
 * Safely get an item from sessionStorage.
 *
 * @param key - Storage key
 * @returns Parsed JSON value or null
 */
function getItem<T>(key: string): T | null {
  if (!isSessionStorageAvailable()) return null
  try {
    const value = sessionStorage.getItem(key)
    return value ? (JSON.parse(value) as T) : null
  } catch {
    return null
  }
}

/**
 * Safely set an item in sessionStorage.
 *
 * @param key - Storage key
 * @param value - Value to store (will be JSON stringified)
 */
function setItem(key: string, value: unknown): void {
  if (!isSessionStorageAvailable()) return
  try {
    sessionStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage full or unavailable - silently fail
  }
}

/**
 * Safely remove an item from sessionStorage.
 *
 * @param key - Storage key
 */
function removeItem(key: string): void {
  if (!isSessionStorageAvailable()) return
  try {
    sessionStorage.removeItem(key)
  } catch {
    // Silently fail
  }
}

/**
 * Default storage adapter using browser sessionStorage.
 *
 * Features:
 * - Session state persists across page reloads (same tab)
 * - Automatically cleared when tab/browser closes
 * - Supports roster and room caching for faster reconnection
 * - NO credential storage (web apps should re-prompt for login)
 *
 * @example
 * ```tsx fragment
 * import { XMPPProvider, sessionStorageAdapter } from '@fluux/sdk'
 *
 * // Uses sessionStorageAdapter by default
 * <XMPPProvider>
 *   <App />
 * </XMPPProvider>
 *
 * // Explicitly pass the adapter
 * <XMPPProvider storageAdapter={sessionStorageAdapter}>
 *   <App />
 * </XMPPProvider>
 * ```
 */
export const sessionStorageAdapter: StorageAdapter = {
  // ==================== Session State ====================

  getSessionState: async (jid: string): Promise<SessionState | null> => {
    return getItem<SessionState>(KEYS.session(jid))
  },

  setSessionState: async (jid: string, state: SessionState): Promise<void> => {
    setItem(KEYS.session(jid), state)
  },

  clearSessionState: async (jid: string): Promise<void> => {
    removeItem(KEYS.session(jid))
  },

  // ==================== Credentials ====================
  // Not implemented - web apps should re-prompt for login
  // Desktop apps can provide a custom adapter with OS keychain

  // getCredentials: not implemented
  // setCredentials: not implemented
  // clearCredentials: not implemented

  // ==================== Roster State ====================

  getRoster: async (jid: string): Promise<unknown[] | null> => {
    return getItem<unknown[]>(KEYS.roster(jid))
  },

  setRoster: async (jid: string, roster: unknown[]): Promise<void> => {
    setItem(KEYS.roster(jid), roster)
  },

  clearRoster: async (jid: string): Promise<void> => {
    removeItem(KEYS.roster(jid))
  },

  // ==================== Server Info ====================

  getServerInfo: async (jid: string): Promise<unknown | null> => {
    return getItem<unknown>(KEYS.serverInfo(jid))
  },

  setServerInfo: async (jid: string, serverInfo: unknown): Promise<void> => {
    setItem(KEYS.serverInfo(jid), serverInfo)
  },

  clearServerInfo: async (jid: string): Promise<void> => {
    removeItem(KEYS.serverInfo(jid))
  },

  // ==================== Room State ====================

  getRooms: async (jid: string): Promise<unknown[] | null> => {
    return getItem<unknown[]>(KEYS.rooms(jid))
  },

  setRooms: async (jid: string, rooms: unknown[]): Promise<void> => {
    setItem(KEYS.rooms(jid), rooms)
  },

  clearRooms: async (jid: string): Promise<void> => {
    removeItem(KEYS.rooms(jid))
  },

  // ==================== Profile ====================

  getProfile: async (jid: string): Promise<{ avatarHash: string | null; nickname: string | null } | null> => {
    return getItem<{ avatarHash: string | null; nickname: string | null }>(KEYS.profile(jid))
  },

  setProfile: async (jid: string, profile: { avatarHash: string | null; nickname: string | null }): Promise<void> => {
    setItem(KEYS.profile(jid), profile)
  },

  clearProfile: async (jid: string): Promise<void> => {
    removeItem(KEYS.profile(jid))
  },

  // ==================== Bulk Clear ====================

  clearAll: async (jid: string): Promise<void> => {
    removeItem(KEYS.session(jid))
    removeItem(KEYS.roster(jid))
    removeItem(KEYS.rooms(jid))
    removeItem(KEYS.serverInfo(jid))
    removeItem(KEYS.profile(jid))
  },
}
