/**
 * Runtime diagnostics flags for high-volume connection/proxy tracing.
 *
 * Enable detailed traces via one of:
 * - localStorage: DEBUG_CONNECTION_TRACE=true
 * - global flag:  globalThis.__FLUUX_DEBUG_CONNECTION_TRACE__ = true
 * - env var:      VITE_FLUUX_DEBUG_CONNECTION_TRACE=true (build-time)
 * - env var:      FLUUX_DEBUG_CONNECTION_TRACE=true|1 (Node/test)
 */

const LOCAL_STORAGE_TRACE_KEY = 'DEBUG_CONNECTION_TRACE'
const GLOBAL_TRACE_KEY = '__FLUUX_DEBUG_CONNECTION_TRACE__'

function isTruthy(value: string | undefined): boolean {
  if (!value) return false
  return value === '1' || value.toLowerCase() === 'true'
}

function readLocalStorageFlag(): boolean {
  try {
    return typeof localStorage !== 'undefined'
      && localStorage.getItem(LOCAL_STORAGE_TRACE_KEY) === 'true'
  } catch {
    return false
  }
}

function readGlobalFlag(): boolean {
  try {
    const globalObj = globalThis as Record<string, unknown>
    return globalObj[GLOBAL_TRACE_KEY] === true
  } catch {
    return false
  }
}

function readImportMetaFlag(): boolean {
  try {
    // @ts-expect-error - import.meta.env may not exist in all runtime contexts
    const env = typeof import.meta !== 'undefined' ? import.meta.env : undefined
    return isTruthy(env?.VITE_FLUUX_DEBUG_CONNECTION_TRACE)
  } catch {
    return false
  }
}

function readProcessEnvFlag(): boolean {
  try {
    if (typeof process === 'undefined') return false
    return isTruthy(process.env?.FLUUX_DEBUG_CONNECTION_TRACE)
  } catch {
    return false
  }
}

/**
 * Whether verbose connection/proxy tracing should be emitted.
 */
export function isConnectionTraceEnabled(): boolean {
  return (
    readLocalStorageFlag()
    || readGlobalFlag()
    || readImportMetaFlag()
    || readProcessEnvFlag()
  )
}
