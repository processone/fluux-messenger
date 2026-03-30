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
 * Shorter timeout for post-sleep verification.
 * After sleep, the socket is almost certainly dead — waiting 10s for a
 * response that will never come feels like a freeze. Use a shorter timeout
 * so we transition to reconnecting quickly.
 */
export const WAKE_VERIFY_TIMEOUT_MS = 3_000

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

/**
 * Per-IQ timeout during fresh session setup (roster, bookmarks, conversation sync).
 * Shorter than xmpp.js's 30s default to fail fast during reconnection after sleep.
 */
export const FRESH_SESSION_IQ_TIMEOUT_MS = 15_000

/**
 * Overall timeout for the entire fresh session setup phase (all IQs + room joins).
 * Safety net: if the combined setup takes longer, abort and let the reconnect loop retry.
 */
export const FRESH_SESSION_SETUP_TIMEOUT_MS = 30_000

/**
 * Maximum time to wait for network availability after wake-from-sleep.
 * If navigator.onLine is false, wait up to this duration for the browser
 * 'online' event before proceeding with (or skipping) the reconnect attempt.
 */
export const NETWORK_READY_TIMEOUT_MS = 15_000

/**
 * Timeout for the SASL authentication exchange.
 * If the server doesn't respond to SASL challenges within this window
 * (e.g., half-open WebSocket after sleep/wake), abort early instead of
 * waiting for the full RECONNECT_ATTEMPT_TIMEOUT_MS.
 */
export const SASL_AUTH_TIMEOUT_MS = 15_000
