/**
 * Service worker registration + user-triggered update (browser/PWA only).
 *
 * The custom service worker (`sw.ts`) no longer calls `skipWaiting()` on install:
 * a freshly deployed build installs and then PARKS in the `waiting` state instead
 * of seizing control. That keeps the running page on its current (matching) build
 * — no mixed old/new assets, no surprise reload — until the user opts in.
 *
 * Previously we reloaded the page automatically as soon as the new worker took
 * control. On an installed PWA that fires on nearly every foreground-after-deploy
 * (see the focus update check below), so the app reloaded out from under the user
 * mid-session. Now, when a waiting worker is detected we flag
 * `appUpdateStore.webUpdateReady` so the sidebar surfaces an "update available"
 * button; clicking it runs `applyWaitingUpdate`, which tells the waiting worker to
 * `skipWaiting()` and reloads once it takes control.
 *
 * The browser only checks for an updated `sw.js` on `register()`, on navigations
 * within scope, and on its own ~24h timer — none of which fire for a backgrounded,
 * installed PWA merely brought back to the foreground. So we also force an update
 * check (`registration.update()`) when the document becomes visible again,
 * throttled by `createFocusUpdateChecker`. A found update now flows into the
 * button, not a reload.
 */

import { useAppUpdateStore } from '@/stores/appUpdateStore'

/** Minimum gap between focus-triggered update checks (one short network probe). */
export const FOCUS_UPDATE_MIN_INTERVAL_MS = 60_000

/**
 * Watch a registration for an update that is ready to activate, and invoke
 * `onReady` when one is.
 *
 * "Ready" means a worker is `waiting` — either already (from a check on a prior
 * page load) or after a fresh `updatefound` reaches the `installed` state while a
 * controller exists. The controller check is what distinguishes a genuine update
 * from the very first install (which has no prior controller and must not prompt).
 */
export function installUpdateReadyDetection(
  registration: ServiceWorkerRegistration,
  hasController: () => boolean,
  onReady: () => void,
): void {
  if (registration.waiting) {
    onReady()
    return
  }
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing
    if (!installing) return
    installing.addEventListener('statechange', () => {
      if (installing.state === 'installed' && hasController()) {
        onReady()
      }
    })
  })
}

/**
 * Activate a waiting service worker and reload once it takes control.
 *
 * Posts `SKIP_WAITING` to the waiting worker (which triggers `self.skipWaiting()`
 * in `sw.ts`); the resulting `controllerchange` reloads the page into the new
 * build. The reload listener is attached only here (never at registration), so a
 * first-install `clients.claim()` can never trigger a reload, and it fires at
 * most once. No-op when nothing is waiting.
 */
export function applyWaitingUpdate(
  registration: ServiceWorkerRegistration,
  container: ServiceWorkerContainer,
  reload: () => void,
): void {
  const waiting = registration.waiting
  if (!waiting) return
  let reloaded = false
  container.addEventListener('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    reload()
  })
  waiting.postMessage({ type: 'SKIP_WAITING' })
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
 * Register the service worker and wire user-triggered update detection plus a
 * focus-triggered update check. No-op when the runtime has no service worker
 * support (e.g. the Tauri webview, which serves the app over a custom protocol
 * that doesn't support service workers) — so `webUpdateReady` stays false there.
 */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((registration) => {
        // A waiting worker means a new build is ready. Surface the button and
        // register the apply action (skipWaiting + one reload) for it.
        installUpdateReadyDetection(
          registration,
          () => navigator.serviceWorker.controller !== null,
          () => {
            useAppUpdateStore.getState().setWebUpdateReady(true, () =>
              applyWaitingUpdate(registration, navigator.serviceWorker, () => window.location.reload()),
            )
          },
        )

        const checker = createFocusUpdateChecker({ minIntervalMs: FOCUS_UPDATE_MIN_INTERVAL_MS })
        // Re-check for a new build whenever the app is brought back to the
        // foreground — the only reliable signal for an installed PWA that never
        // navigates. A found update surfaces the button via the detection above.
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
