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
 * Forcefully destroy an xmpp.js client instance without graceful shutdown.
 *
 * Unlike client.stop() which tries to send </stream:stream> and wait for
 * server close (which can hang when the socket is dead), this:
 * 1. Strips all event listeners to prevent stale events from firing
 * 2. Force-closes the underlying WebSocket
 *
 * Use this during reconnection when the socket is already dead.
 * For user-initiated disconnect, use the graceful stop() instead.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function forceDestroyClient(client: any): void {
  // Strip all event listeners to prevent stale events from interfering
  // with the reconnection flow. xmpp.js Client extends EventEmitter.
  try {
    if (typeof client.removeAllListeners === 'function') {
      client.removeAllListeners()
    }
  } catch {
    // Ignore — client may be in a broken state
  }

  // Force-close the underlying socket without graceful XMPP stream close.
  // The socket hierarchy is: Client.socket (xmpp/websocket Socket wrapper)
  //   → Socket.socket (native WebSocket).
  // We try the wrapper's end() first, then fall back to the native WS.
  try {
    const socket = client.socket
    if (socket?.end) {
      socket.end()
    } else if (socket?.socket?.close) {
      socket.socket.close()
    }
  } catch {
    // Ignore — socket may already be closed/null
  }
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
