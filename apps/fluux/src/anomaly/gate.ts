/**
 * Build-time gate for the anomaly instrumentation tree.
 *
 * `__FLUUX_ANOMALY__` is substituted as a literal by Vite, so every
 * `if (__FLUUX_ANOMALY__)` branch is dead-code eliminated in a release build and
 * the guarded modules are never emitted.
 *
 * It is deliberately NOT `import.meta.env.DEV`. `Fluux Messenger Dev` is produced
 * by `tauri build`, whose `beforeBuildCommand` runs the PRODUCTION Vite build — so
 * `import.meta.env.DEV` is **false** in the one build whose usage we most want to
 * observe, and equally false in release. A gate that is off everywhere is not a
 * gate.
 *
 * @module Anomaly/Gate
 */

/**
 * Resolve the gate for a build.
 *
 * Shared by `vite.config.ts` and `vitest.config.ts` so the matrix below has exactly
 * one definition rather than two that can drift:
 *
 * | Build path                                  | Gate |
 * |---------------------------------------------|------|
 * | Release desktop and PWA web (CI)             | off  |
 * | `Fluux Messenger Dev` (`tauri-build.sh`)     | on   |
 * | Demo build and Playwright (`build-e2e.mjs`)  | on   |
 * | `npm run dev` / `npm run tauri:dev`          | on   |
 *
 * @param mode - Vite mode (`'development'` | `'production'` | …)
 * @param env - `process.env`, or a subset in tests
 */
export function resolveAnomalyGate(
  mode: string,
  env: { FLUUX_ANOMALY?: string },
): boolean {
  if (env.FLUUX_ANOMALY === '1') return true
  if (env.FLUUX_ANOMALY === '0') return false
  return mode !== 'production'
}

/**
 * Marker string CI greps for in the emitted assets.
 *
 * Its presence in a production build means dead-code elimination regressed; its
 * absence from a Dev build means the gate is off where it should be on — the
 * failure that went unnoticed before #1167.
 */
export const ANOMALY_BUILD_SENTINEL = 'fluux-anomaly-instrumentation-present'

/**
 * Publish the sentinel at runtime.
 *
 * Called from the gated install path so the string is reachable from application
 * code and therefore emitted into a Dev bundle and eliminated from a production
 * one. Declaring the constant is not enough on its own: `vite.config.ts` imports
 * this module in **Node at build time**, which puts nothing in the browser bundle,
 * so a check grepping the assets would find the string in neither build and pass
 * vacuously in production while being impossible to satisfy in Dev.
 */
export function markAnomalyBuild(): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>).__fluuxAnomalyBuild = ANOMALY_BUILD_SENTINEL
}
