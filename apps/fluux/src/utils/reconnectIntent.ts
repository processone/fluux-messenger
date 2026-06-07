/**
 * Single source of truth for "should the app auto-reconnect?".
 *
 * The recurring "click logout → immediately logged back in" regression came
 * from there being NO stored answer to this question. Auto-reconnect was
 * re-derived on every startup from a fragile mix of surviving credentials
 * (sessionStorage session, FAST token) plus an in-memory once-per-startup ref
 * that the Tauri/WRY post-logout `window.location.reload()` silently resets.
 * Every prior fix tried to delete a credential fast enough to beat that reload
 * — i.e. to win a race. This module replaces the race with a persisted intent.
 *
 * `markLoggedOut()` is called synchronously at the very start of logout, before
 * any disconnect/cleanup side effect or reload. The auto-reconnect engines
 * (`useSessionPersistence`, LoginScreen's keychain auto-connect) refuse to
 * connect while the intent is `logged-out`, regardless of which credential
 * happened to survive cleanup. `markConnectActive()` re-arms it whenever a
 * connection actually reaches `online`.
 *
 * The flag lives in localStorage so it survives the JS-context teardown that a
 * webview reload causes (an in-memory guard cannot). It is deliberately NOT
 * removed by `clearLocalData()` / `clearSession()`: a missing flag defaults to
 * `active` (so remembered users still reconnect), so it must persist as the
 * explicit `logged-out` marker once set.
 */

export type ReconnectIntent = 'active' | 'logged-out'

export const RECONNECT_INTENT_KEY = 'fluux:reconnect-intent'

/**
 * Returns the stored connection intent.
 *
 * Defaults to `'active'` when absent (backward compatibility: existing installs
 * with a valid session keep auto-reconnecting) and for any unrecognised value
 * (fail-open — never strand a remembered user on the login screen). The only
 * value that suppresses auto-reconnect is the explicit `'logged-out'` marker.
 */
export function getReconnectIntent(): ReconnectIntent {
  return localStorage.getItem(RECONNECT_INTENT_KEY) === 'logged-out'
    ? 'logged-out'
    : 'active'
}

/**
 * Record that the user deliberately logged out. Call this FIRST in the logout
 * handler — synchronously, before any await or reload — so the auto-reconnect
 * engines see it even if cleanup stalls or the webview reloads mid-logout.
 */
export function markLoggedOut(): void {
  localStorage.setItem(RECONNECT_INTENT_KEY, 'logged-out')
}

/**
 * Record that the user is connected on purpose, re-arming auto-reconnect for
 * future reloads. Call this when a connection reaches `online`, regardless of
 * how it got there (manual login, keychain auto-connect, reload reconnect).
 */
export function markConnectActive(): void {
  localStorage.setItem(RECONNECT_INTENT_KEY, 'active')
}
