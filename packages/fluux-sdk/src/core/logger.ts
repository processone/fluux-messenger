/**
 * SDK diagnostic logger.
 *
 * By default, logs to `console.debug/info/warn/error` with a `[Fluux]` prefix
 * so messages are forwarded to the Rust file log via the Tauri console bridge.
 * This provides persistent, privacy-safe diagnostic output for
 * troubleshooting user-reported issues.
 *
 * A host that owns its own output can redirect all of it with
 * {@link setLogSink} — a CLI or bot otherwise has its own stdout buried under
 * SDK diagnostics, with no supported way to separate the two.
 *
 * **Privacy**: Never pass message bodies or JID local parts to these
 * functions. Use `getDomain(jid)` for 1:1 conversation identifiers.
 * Room JIDs (service addresses) are acceptable.
 *
 * @module Core/Logger
 */

const PREFIX = '[Fluux]'

/**
 * Severity of a diagnostic line, ordered from least to most serious.
 *
 * @category Core
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * Receives every SDK diagnostic instead of the console.
 *
 * The message carries no prefix: a sink that writes somewhere structured
 * should not have to strip one back off.
 *
 * @category Core
 */
export type LogSink = (level: LogLevel, message: string) => void

let sink: LogSink | null = null

/**
 * Route SDK diagnostics somewhere other than the console.
 *
 * Pass `null` to restore the console default. Silencing is a sink that does
 * nothing; a CLI usually wants one that writes to stderr, keeping stdout for
 * its own output.
 *
 * ```typescript
 * import { setLogSink } from '@fluux/sdk/core'
 *
 * setLogSink((level, message) => {
 *   if (level === 'warn' || level === 'error') console.error(`[sdk] ${message}`)
 * })
 * ```
 *
 * @param next - Sink to receive every diagnostic, or `null` for the console.
 *
 * @category Core
 */
export function setLogSink(next: LogSink | null): void {
  sink = next
}

export function logDebug(message: string): void {
  if (sink) return sink('debug', message)
  console.debug(PREFIX, message)
}

export function logInfo(message: string): void {
  if (sink) return sink('info', message)
  console.info(PREFIX, message)
}

export function logWarn(message: string): void {
  if (sink) return sink('warn', message)
  console.warn(PREFIX, message)
}

export function logError(message: string): void {
  if (sink) return sink('error', message)
  console.error(PREFIX, message)
}
