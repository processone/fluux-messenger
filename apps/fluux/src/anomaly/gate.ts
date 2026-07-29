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
