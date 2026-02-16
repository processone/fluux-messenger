/**
 * Shared utility functions and constants for connection management.
 *
 * Pure functions extracted from Connection.ts and XMPPClient.ts to
 * eliminate duplication and enable independent testing.
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** Timeout for graceful client stop (stream close + socket close).
 *  When the socket is already dead, xmpp.js stop() can hang waiting for events. */
export const CLIENT_STOP_TIMEOUT_MS = 2000

/** Timeout for a single reconnection attempt (XMPP negotiation).
 *  If xmpp.js hangs during connection negotiation (e.g., the WebSocket connects
 *  but XMPP stream negotiation stalls), this ensures the attempt is abandoned
 *  and the next retry can begin. */
export const RECONNECT_ATTEMPT_TIMEOUT_MS = 30_000

// ── Functions ──────────────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout. Resolves with void if the timeout fires first.
 * Used to prevent hanging on xmpp.js stop() when the socket is already dead.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | void> {
  return Promise.race([
    promise,
    new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ])
}

/**
 * Check if an error indicates a dead WebSocket connection.
 * This can happen after system sleep when the socket dies silently.
 */
export function isDeadSocketError(errorMessage: string): boolean {
  return (
    errorMessage.includes('socket.write') ||
    errorMessage.includes('null is not an object') ||
    errorMessage.includes('Cannot read properties of null') ||
    errorMessage.includes('socket is null') ||
    errorMessage.includes('Socket not available') ||
    errorMessage.includes('WebSocket is not open')
  )
}
