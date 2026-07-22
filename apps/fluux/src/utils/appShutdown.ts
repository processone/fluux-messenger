/**
 * Single source of truth for "is the app shutting down?".
 *
 * Quitting is not logging out, so `reconnectIntent` stays `'active'` across a
 * quit (we *want* the next launch to reconnect). That left the shutdown window
 * with no signal at all, and the app's auto-reconnect machinery happily fired
 * inside it:
 *
 * Rust emits `graceful-shutdown` (tray Quit, Cmd+Q, window close) ->
 * `useTauriCloseHandler` calls `client.disconnect()` -> `disconnect()`
 * synchronously flips the connection store to `'disconnected'` -> `App` routes
 * to `LoginScreen` -> that is a *fresh mount* (LoginScreen is unmounted while
 * online), so its mount effects ran with all their once-per-instance refs
 * reset: the WRY reload workaround reloaded the webview (destroying the JS
 * context before `exit_app` could be invoked, so the app only died via Rust's
 * 2s force-exit fallback) and the keychain auto-connect opened a brand-new XMPP
 * session that was then killed mid-login, stranding a ghost session on the
 * server.
 *
 * This flag is deliberately **in-memory only**. It marks a one-way transition
 * that ends in process exit, so it must never survive into the next launch —
 * persisting it (localStorage/sessionStorage) would risk stranding a future
 * start-up with auto-reconnect disabled. Losing it on a webview reload is fine
 * because the guards below exist precisely to prevent that reload.
 */

let shuttingDown = false

/**
 * Record that the app has begun its shutdown sequence. Call this FIRST in the
 * `graceful-shutdown` handler — synchronously, before `client.disconnect()` —
 * so the status change disconnect() emits is already seen as "shutting down"
 * by every effect that reacts to it.
 */
export function markShuttingDown(): void {
  shuttingDown = true
}

/**
 * Whether the app is tearing down. Auto-reconnect engines and the WRY reload
 * workaround must no-op while this is true: any connection opened here is
 * killed seconds later by the exit, and any reload prevents a clean exit.
 */
export function isShuttingDown(): boolean {
  return shuttingDown
}

/** Test-only: reset the module state between cases. */
export function resetShutdownStateForTests(): void {
  shuttingDown = false
}
