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
 * - `proxy`: Native TCP/TLS connection via the always-on proxy (Tauri desktop)
 * - `websocket`: WebSocket connection (web browser or explicit ws:// URL)
 * - `null`: Not yet connected or unknown
 *
 * @category Connection
 */
export type ConnectionMethod = 'proxy' | 'websocket'

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
  /** Account password (optional when FAST token is available for auth) */
  password?: string
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
    /**
     * Total outbound stanzas the server is expected to know about
     * (= sm.outbound + outbound_q.length at persist time). Required so
     * xmpp.js's ackQueue doesn't shift an empty queue on resume.
     */
    outbound: number
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
  /**
   * Persist FAST tokens (XEP-0484) to localStorage for password-less reconnection.
   * When true, the SDK saves tokens received during SASL2 negotiation, enabling
   * auto-login on subsequent sessions for up to 14 days without a password.
   * When false (default), tokens are not persisted and each session requires a password.
   */
  rememberSession?: boolean
  /**
   * Auto-retry the initial connection on transient transport failures (e.g.,
   * WebSocket ECONNERROR right after wake from sleep).
   *
   * When true, a CONNECTION_ERROR during the initial `connecting` state routes
   * the machine into the normal reconnecting/backoff loop instead of going to
   * terminal.initialFailure. Auth failures and server conflicts still surface
   * immediately (they use separate machine events).
   *
   * Callers should set this only when the credentials are known-good (e.g.,
   * page-reload reconnection after a previous successful session). First-time
   * login should leave this false so bad credentials/servers surface to the
   * user immediately.
   *
   * When true, connect() does not throw on transient transport errors — the
   * retry loop owns the outcome. Terminal states (maxRetries, authFailed,
   * conflict) still surface via the machine's terminal transitions.
   *
   * @default false
   */
  autoRetryOnTransientFailure?: boolean
}
