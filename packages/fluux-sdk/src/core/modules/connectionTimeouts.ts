/**
 * Centralized timeout budgets for connection and proxy lifecycle operations.
 *
 * These are safety bounds for failure modes (dead sockets, hung IPC, stalled
 * cleanup), not expected steady-state timings.
 */

/**
 * Best-effort cleanup budget during manual disconnect.
 * Applies to storage/cache cleanup phases before socket teardown.
 */
export const DISCONNECT_CLEANUP_TIMEOUT_MS = 2_000

/**
 * Timeout for graceful client stop (stream close + socket close).
 * Used as a safety bound when xmpp.js stop() hangs on dead transports.
 */
export const CLIENT_STOP_TIMEOUT_MS = 2_000

/**
 * Timeout for a single reconnect attempt (XMPP negotiation/start path).
 */
export const RECONNECT_ATTEMPT_TIMEOUT_MS = 30_000

/**
 * Default timeout for health verification (SM ack or ping fallback).
 */
export const VERIFY_CONNECTION_TIMEOUT_MS = 10_000

/**
 * Timeout for the desktop direct-WebSocket pre-check when proxy is available.
 * If the direct WS handshake stalls, we quickly fall back to TCP/SRV via proxy.
 */
export const DIRECT_WEBSOCKET_PRECHECK_TIMEOUT_MS = 5_000

/**
 * Upper bound for proxy start IPC call.
 */
export const PROXY_START_TIMEOUT_MS = 10_000

/**
 * Upper bound for proxy stop IPC call.
 */
export const PROXY_STOP_TIMEOUT_MS = 5_000
