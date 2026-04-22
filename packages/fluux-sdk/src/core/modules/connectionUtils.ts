/**
 * Shared utility functions and constants for connection management.
 *
 * Pure functions extracted from Connection.ts and XMPPClient.ts to
 * eliminate duplication and enable independent testing.
 */

// ── Constants ──────────────────────────────────────────────────────────────────
//
// Re-exported for backward compatibility with existing imports/tests.
export {
  CLIENT_STOP_TIMEOUT_MS,
  RECONNECT_ATTEMPT_TIMEOUT_MS,
} from './connectionTimeouts'

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
 * Compute how long to wait for the network stack to settle after a wake-from-sleep.
 *
 * Returns 0 when no wait is needed: either no wake has been recorded, the
 * wake was long enough ago that the settle window has already passed, or
 * the remaining delay rounds to zero.
 *
 * The `+ 1_000` slack on the upper bound keeps the window open slightly
 * past `settleDelayMs` so clocks reading a few hundred ms after the wake
 * still apply the delay.
 */
export function computePostWakeSettleMs(
  lastWakeTimestamp: number,
  nowMs: number,
  settleDelayMs: number
): number {
  if (lastWakeTimestamp <= 0) return 0
  const msSinceWake = nowMs - lastWakeTimestamp
  if (msSinceWake >= settleDelayMs + 1_000) return 0
  return Math.max(0, settleDelayMs - msSinceWake)
}

/**
 * Decide whether a connection-attempt timer firing `elapsedMs` after it was
 * scheduled should be treated as evidence that the system slept through it.
 *
 * `setTimeout` freezes while macOS sleeps; when the app wakes, the timer
 * fires immediately regardless of how long the sleep lasted. An elapsed
 * time well past the scheduled timeout is a strong signal that we just
 * came out of sleep, even when no explicit wake event was delivered.
 */
export function didTimerSleepThrough(
  elapsedMs: number,
  timeoutMs: number
): boolean {
  return elapsedMs > timeoutMs * 1.5
}

/**
 * Budget for how long to let the OS network stack settle after a wake,
 * scaled to the length of sleep we just came out of.
 *
 * Short sleeps (lid flicks, brief throttling) keep the network path
 * mostly warm and don't need a delay at all — blocking would only add
 * perceived latency. Long sleeps typically require Wi-Fi re-association,
 * DHCP renewal, and a fresh TLS session, so SASL fires into a half-open
 * socket if we don't give the stack a moment. The upper bound caps at
 * 3s because past that the bottleneck is the TCP/TLS handshake itself,
 * not the pre-connect settle.
 *
 * `undefined` falls through to the middle-of-the-road default so a wake
 * from an untagged source (e.g. a heartbeat with no duration hint) is
 * still protected.
 */
export function computeNetworkSettleMs(sleepDurationMs: number | undefined): number {
  if (sleepDurationMs === undefined) return 2_000
  if (sleepDurationMs < 30_000) return 0
  if (sleepDurationMs < 180_000) return 500
  if (sleepDurationMs < 900_000) return 1_500
  return 3_000
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
