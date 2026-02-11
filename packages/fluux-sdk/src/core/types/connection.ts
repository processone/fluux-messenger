/**
 * Connection type definitions.
 *
 * @packageDocumentation
 * @module Types/Connection
 */

/**
 * Current connection status of the XMPP client.
 *
 * @remarks
 * Status transitions:
 * - `disconnected` → `connecting` → `online`
 * - `online` → `reconnecting` → `online` (on temporary disconnect)
 * - `online` → `verifying` → `online` (after wake from sleep, connection alive)
 * - `online` → `verifying` → `reconnecting` (after wake from sleep, connection dead)
 * - `online` → `error` → `disconnected` (on fatal error)
 *
 * @category Connection
 */
export type ConnectionStatus = 'disconnected' | 'connecting' | 'online' | 'reconnecting' | 'verifying' | 'error'

/**
 * The transport method used for the XMPP connection.
 *
 * @remarks
 * - `tls`: Direct TLS connection via native TCP proxy (port 5223, Tauri desktop)
 * - `starttls`: STARTTLS upgrade via native TCP proxy (port 5222, Tauri desktop)
 * - `websocket`: WebSocket connection (web browser or explicit ws:// URL)
 * - `null`: Not yet connected or unknown
 *
 * @category Connection
 */
export type ConnectionMethod = 'tls' | 'starttls' | 'websocket'

/**
 * System state changes that the app can signal to the SDK.
 *
 * Used with `notifySystemState()` to inform the SDK about platform-specific
 * events. The SDK handles the appropriate XMPP protocol response.
 *
 * @remarks
 * - `awake`: System woke from sleep. SDK verifies connection and reconnects if dead.
 * - `sleeping`: System is going to sleep. SDK may gracefully disconnect.
 * - `visible`: App became visible/foreground. SDK verifies connection after long hide.
 * - `hidden`: App went to background. SDK may reduce keepalive frequency.
 *
 * @example
 * ```typescript
 * // App detects wake from sleep
 * notifySystemState('awake')
 *
 * // App visibility changed
 * document.addEventListener('visibilitychange', () => {
 *   notifySystemState(document.hidden ? 'hidden' : 'visible')
 * })
 * ```
 *
 * @category Connection
 */
export type SystemState = 'awake' | 'sleeping' | 'visible' | 'hidden'

/**
 * Options for connecting to an XMPP server.
 *
 * @example
 * ```typescript
 * const options: ConnectOptions = {
 *   jid: 'user@example.com',
 *   password: 'secret',
 *   server: 'wss://example.com:5443/ws',
 *   resource: 'fluux-web'
 * }
 * await client.connect(options)
 * ```
 *
 * @category Connection
 */
export interface ConnectOptions {
  /** Full JID including domain (e.g., 'user@example.com') */
  jid: string
  /** Account password */
  password: string
  /** WebSocket server URL (e.g., 'wss://example.com:5443/ws') */
  server: string
  /** XMPP resource identifier (e.g., 'desktop', 'web', 'mobile') */
  resource?: string
  /**
   * XEP-0198 Stream Management state for session resumption.
   * Used internally to restore sessions after page reload.
   */
  smState?: {
    /** Stream Management session ID */
    id: string
    /** Number of stanzas received (for acknowledgment) */
    inbound: number
  }
  /** Language for the XMPP stream (xml:lang attribute, e.g., 'en', 'fr') */
  lang?: string
  /**
   * Previously joined rooms to rejoin after session restoration.
   * Used internally for reconnection handling.
   */
  previouslyJoinedRooms?: Array<{ jid: string; nickname: string; password?: string; autojoin?: boolean }>
  /**
   * Skip XEP-0156 WebSocket endpoint discovery.
   * When true, uses the server URL directly without attempting to discover
   * the WebSocket endpoint via host-meta. Useful for testing or when the
   * endpoint is already known.
   * @internal
   */
  skipDiscovery?: boolean
  /**
   * Disable xmpp.js's built-in Stream Management keepalive interval.
   * When true, the SDK will not send periodic SM acknowledgment requests.
   * Use this when the application implements its own keepalive mechanism
   * (e.g., Rust-side timer in Tauri that's immune to JS timer throttling).
   */
  disableSmKeepalive?: boolean
}
