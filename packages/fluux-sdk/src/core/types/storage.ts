/**
 * Storage adapter types for session persistence.
 *
 * The SDK uses a storage adapter pattern to allow apps to provide
 * platform-specific storage implementations (localStorage for web,
 * OS keychain for desktop apps, etc.)
 *
 * @packageDocumentation
 * @module Types
 */

/**
 * Minimal room info for session resumption.
 *
 * When SM resumption fails after page reload, we need to rejoin rooms
 * that were manually joined (not autojoin bookmarks).
 */
export interface JoinedRoomInfo {
  /** Room JID */
  jid: string
  /** Our nickname in the room */
  nickname: string
  /** Room password if any */
  password?: string
  /** Whether this room has autojoin enabled (from bookmark) */
  autojoin?: boolean
}

/**
 * Stream Management session state for XEP-0198 session resumption.
 *
 * This state allows the client to resume an existing XMPP session
 * after a brief disconnection (e.g., network switch, page reload)
 * without re-authenticating.
 */
export interface SessionState {
  /** Stream Management session ID */
  smId: string
  /** Last acknowledged inbound stanza count */
  smInbound: number
  /**
   * Total outbound stanzas the server is expected to know about on resume
   * (= `sm.outbound` + pending `outbound_q` length at persist time).
   * Required to hydrate `sm.outbound` so xmpp.js's ackQueue loop runs 0
   * iterations when `<resumed h=N/>` comes back — preventing a crash on
   * the empty in-memory queue after page reload.
   */
  smOutbound: number
  /** XMPP resource for this session */
  resource: string
  /** Timestamp when this state was saved */
  timestamp: number
  /**
   * Rooms that were joined when session was saved.
   * Used to rejoin rooms when SM resumption fails after page reload.
   */
  joinedRooms?: JoinedRoomInfo[]
}

/**
 * User credentials for XMPP authentication.
 *
 * When stored via a secure storage adapter (e.g., OS keychain),
 * these enable automatic reconnection without re-entering credentials.
 */
export interface StoredCredentials {
  /** Full JID (user@domain) */
  jid: string
  /** Account password */
  password: string
  /** XMPP server address or WebSocket URL */
  server: string
}

/**
 * Interface for session storage adapters.
 *
 * Implement this interface to provide custom storage for session state
 * and optionally credentials. The SDK provides a default `sessionStorageAdapter`
 * for web apps that uses browser sessionStorage.
 *
 * @example Web app (uses default)
 * ```tsx
 * <XMPPProvider>
 *   <App />
 * </XMPPProvider>
 * ```
 *
 * @example Desktop app with OS keychain
 * ```tsx
 * import { tauriStorageAdapter } from './utils/tauriStorageAdapter'
 *
 * <XMPPProvider storageAdapter={tauriStorageAdapter}>
 *   <App />
 * </XMPPProvider>
 * ```
 */
export interface StorageAdapter {
  // ==================== Session State ====================
  // Required for XEP-0198 Stream Management resumption

  /**
   * Get stored session state for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @returns Session state if found, null otherwise
   */
  getSessionState: (jid: string) => Promise<SessionState | null>

  /**
   * Store session state for a JID.
   *
   * Called after successful SM negotiation and on SM state updates.
   *
   * @param jid - The bare JID (user@domain)
   * @param state - Session state to store
   */
  setSessionState: (jid: string, state: SessionState) => Promise<void>

  /**
   * Clear stored session state for a JID.
   *
   * Called on manual disconnect or when SM resumption fails.
   *
   * @param jid - The bare JID (user@domain)
   */
  clearSessionState: (jid: string) => Promise<void>

  // ==================== Credentials ====================
  // Optional - only needed for "Remember Me" functionality

  /**
   * Get stored credentials for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @returns Credentials if found, null otherwise
   */
  getCredentials?: (jid: string) => Promise<StoredCredentials | null>

  /**
   * Store credentials for a JID.
   *
   * Should use secure storage (OS keychain) when available.
   *
   * @param jid - The bare JID (user@domain)
   * @param credentials - Credentials to store
   */
  setCredentials?: (jid: string, credentials: StoredCredentials) => Promise<void>

  /**
   * Clear stored credentials for a JID.
   *
   * @param jid - The bare JID (user@domain)
   */
  clearCredentials?: (jid: string) => Promise<void>

  // ==================== Roster State ====================
  // Optional - for faster roster restoration on reconnect

  /**
   * Get stored roster for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @returns Serialized roster contacts, or null if not stored
   */
  getRoster?: (jid: string) => Promise<unknown[] | null>

  /**
   * Store roster for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @param roster - Roster contacts to store (will be serialized as JSON)
   */
  setRoster?: (jid: string, roster: unknown[]) => Promise<void>

  /**
   * Clear stored roster for a JID.
   *
   * @param jid - The bare JID (user@domain)
   */
  clearRoster?: (jid: string) => Promise<void>

  // ==================== Server Info ====================
  // Optional - cache server discovery results

  /**
   * Get stored server info for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @returns Server info (discovery results), or null if not stored
   */
  getServerInfo?: (jid: string) => Promise<unknown | null>

  /**
   * Store server info for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @param serverInfo - Server discovery results to store
   */
  setServerInfo?: (jid: string, serverInfo: unknown) => Promise<void>

  /**
   * Clear stored server info for a JID.
   *
   * @param jid - The bare JID (user@domain)
   */
  clearServerInfo?: (jid: string) => Promise<void>

  // ==================== Room State ====================
  // Optional - for MUC room restoration

  /**
   * Get stored rooms for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @returns Serialized room data, or null if not stored
   */
  getRooms?: (jid: string) => Promise<unknown[] | null>

  /**
   * Store rooms for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @param rooms - Room data to store (will be serialized as JSON)
   */
  setRooms?: (jid: string, rooms: unknown[]) => Promise<void>

  /**
   * Clear stored rooms for a JID.
   *
   * @param jid - The bare JID (user@domain)
   */
  clearRooms?: (jid: string) => Promise<void>

  // ==================== Profile ====================
  // Optional - cache own profile (avatar hash, nickname)

  /**
   * Get stored profile for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @returns Profile data (avatar hash, nickname), or null if not stored
   */
  getProfile?: (jid: string) => Promise<{ avatarHash: string | null; nickname: string | null } | null>

  /**
   * Store profile for a JID.
   *
   * @param jid - The bare JID (user@domain)
   * @param profile - Profile data to store
   */
  setProfile?: (jid: string, profile: { avatarHash: string | null; nickname: string | null }) => Promise<void>

  /**
   * Clear stored profile for a JID.
   *
   * @param jid - The bare JID (user@domain)
   */
  clearProfile?: (jid: string) => Promise<void>

  // ==================== Bulk Clear ====================

  /**
   * Clear all stored data for a JID.
   *
   * Called on explicit logout to clean up all session data.
   *
   * @param jid - The bare JID (user@domain)
   */
  clearAll?: (jid: string) => Promise<void>
}
