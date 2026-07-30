/**
 * Build-time assertion that anomaly instrumentation is present exactly where it
 * should be, including support modules outside `src/anomaly/`.
 *
 * Inspects each emitted chunk's `modules` collection rather than chunk filenames: a
 * module inlined into an existing chunk has no distinguishing filename, so a
 * filename check would pass while the code shipped.
 *
 * Asserts in BOTH directions. The negative direction protects production; the
 * positive direction protects against a silent regression to "eliminated
 * everywhere, including where it was supposed to run" — which is exactly what the
 * `import.meta.env.DEV` gate did in the packaged Dev bundle before #1167. An
 * absence-only check would have passed there too.
 *
 * @module Scripts/AnomalyBuildAudit
 */
import type { Plugin } from 'vite'

/** `src/anomaly/` on either path separator, and not `src/anomalyReports/`. */
const ANOMALY_PATH = /[\\/]src[\\/]anomaly[\\/]/
const ANOMALY_SUPPORT_PATH = /[\\/]src[\\/]utils[\\/]viewportScroller\.ts$/

interface ChunkLike {
  type?: string
  modules?: Record<string, unknown>
}

/**
 * @internal Exported for testing.
 * @param bundle - Rollup/Rolldown's emitted bundle, keyed by file name.
 * @param expectPresent - whether this build is supposed to contain the runtime.
 */
export function auditBundle(bundle: Record<string, ChunkLike>, expectPresent: boolean): void {
  const runtimeModules: string[] = []
  const supportModules: string[] = []
  for (const chunk of Object.values(bundle)) {
    if (chunk.type !== 'chunk') continue
    for (const moduleId of Object.keys(chunk.modules ?? {})) {
      if (ANOMALY_PATH.test(moduleId)) runtimeModules.push(moduleId)
      else if (ANOMALY_SUPPORT_PATH.test(moduleId)) supportModules.push(moduleId)
    }
  }

  const instrumentationModules = [...runtimeModules, ...supportModules]

  if (!expectPresent && instrumentationModules.length > 0) {
    throw new Error(
      `[anomaly-build-audit] ${instrumentationModules.length} anomaly module(s) survived into a ` +
        `production bundle — dead-code elimination regressed:\n  ${instrumentationModules.join('\n  ')}\n` +
        'Check that every call site is guarded by `if (__FLUUX_ANOMALY__)` and that no ' +
        'module imports src/anomaly/ unconditionally.',
    )
  }

  if (expectPresent && runtimeModules.length === 0) {
    throw new Error(
      '[anomaly-build-audit] expected the anomaly modules in this build, but none were ' +
        'emitted. The gate is off where it should be on — check that FLUUX_ANOMALY=1 ' +
        'reaches vite (see apps/fluux/src/anomaly/gate.ts).',
    )
  }
}

export function anomalyBuildAudit(enabled: boolean): Plugin {
  return {
    name: 'anomaly-build-audit',
    apply: 'build',
    generateBundle(_options, bundle) {
      auditBundle(bundle as unknown as Record<string, ChunkLike>, enabled)
    },
  }
}
