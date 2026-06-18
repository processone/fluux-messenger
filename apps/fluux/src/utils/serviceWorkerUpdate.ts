/**
 * Service worker registration + auto-reload-on-update (browser/PWA only).
 *
 * The custom service worker (`sw.ts`) calls `skipWaiting()` on install and
 * `clients.claim()` on activate, so a freshly deployed build activates and
 * caches its assets immediately. But activating a new SW does NOT reload the
 * page that is already running — it only changes what future fetches return.
 * On a desktop tab you eventually get a fresh navigation (close/reopen), so the
 * gap is invisible; on an installed Android PWA the activity persists and even
 * a cold tap is served the old precached `index.html` by the still-current SW,
 * so the app stays pinned to a stale version until the user uninstalls and
 * reinstalls it.
 *
 * vite-plugin-pwa's `autoUpdate` registration normally closes this gap by
 * reloading the page once the new SW takes control. We register manually
 * (`injectRegister: false`) so we can skip the SW entirely under Tauri, which
 * means we also have to wire that reload ourselves — that is what
 * `installServiceWorkerAutoReload` does.
 *
 * Reloading on activation only helps once a new SW is *detected*, though. The
 * browser only checks for an updated `sw.js` on the initial `register()` call,
 * on navigations within scope, and on its own ~24h timer — none of which fire
 * for a backgrounded, installed PWA that is merely brought back to the
 * foreground. So we also force an update check (`registration.update()`) when
 * the document becomes visible again, throttled by `createFocusUpdateChecker`.
 * A check that finds a new build flows straight into the activation reload
 * above, so the app refreshes to the latest version shortly after refocus.
 */

/** Minimum gap between focus-triggered update checks (one short network probe). */
export const FOCUS_UPDATE_MIN_INTERVAL_MS = 60_000

/**
 * Reload the page once an updated service worker takes control.
 *
 * `controllerchange` fires whenever the active SW changes. There are two
 * cases we must distinguish:
 *
 *  - **Fresh install** (no prior controller): the very first `controllerchange`
 *    is just the new SW's initial `clients.claim()`. The page was already
 *    loaded from the network, so reloading here would be a pointless refresh on
 *    first visit. We adopt the controller silently and arm for later updates.
 *  - **Update** (page was already controlled, or a second change after install):
 *    a new build has taken over — reload so the running page picks it up.
 *
 * Reload is guarded so repeated `controllerchange` events can only ever trigger
 * a single reload.
 */
export function installServiceWorkerAutoReload(
  container: ServiceWorkerContainer,
  reload: () => void
): void {
  let hasController = container.controller !== null
  let reloading = false

  container.addEventListener('controllerchange', () => {
    if (!hasController) {
      // Initial install's clients.claim() — adopt the controller, don't reload.
      hasController = true
      return
    }
    if (reloading) return
    reloading = true
    reload()
  })
}

/** Decides whether a focus-triggered update check should run right now. */
export interface FocusUpdateChecker {
  /**
   * Returns true (and arms the throttle) when the app has just become visible
   * and enough time has passed since the last check; false otherwise. Hidden
   * states never check and never touch the throttle window.
   */
  shouldCheck(visibilityState: DocumentVisibilityState, nowMs: number): boolean
}

/**
 * Throttled gate for "check the server for a newer service worker now". Mirrors
 * the factory shape of the other lifecycle utils (e.g. stallSentinel) so the
 * decision logic is unit-testable without faking the DOM visibility API.
 */
export function createFocusUpdateChecker(options: { minIntervalMs: number }): FocusUpdateChecker {
  let lastCheckMs = -Infinity
  return {
    shouldCheck(visibilityState, nowMs) {
      if (visibilityState !== 'visible') return false
      if (nowMs - lastCheckMs < options.minIntervalMs) return false
      lastCheckMs = nowMs
      return true
    },
  }
}

/**
 * Register the service worker and wire auto-reload-on-update plus a
 * focus-triggered update check. No-op when the runtime has no service worker
 * support (e.g. the Tauri webview, which serves the app over a custom protocol
 * that doesn't support service workers).
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  installServiceWorkerAutoReload(navigator.serviceWorker, () => window.location.reload())

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((registration) => {
        const checker = createFocusUpdateChecker({ minIntervalMs: FOCUS_UPDATE_MIN_INTERVAL_MS })
        // Re-check for a new build whenever the app is brought back to the
        // foreground — the only reliable signal for an installed PWA that never
        // navigates. A found update activates and reloads via the listener above.
        document.addEventListener('visibilitychange', () => {
          if (checker.shouldCheck(document.visibilityState, Date.now())) {
            registration.update().catch(() => {
              // Update check can fail offline — ignore; it retries on next focus.
            })
          }
        })
      })
      .catch(() => {
        // Registration can fail in development or unsupported environments —
        // ignore silently; the app still works without offline caching.
      })
  })
}
