/**
 * SDK diagnostic logger.
 *
 * Logs to `console.info/warn/error` with a `[Fluux]` prefix so messages
 * are forwarded to the Rust file log via the Tauri console bridge.
 * This provides persistent, privacy-safe diagnostic output for
 * troubleshooting user-reported issues.
 *
 * **Privacy**: Never pass message bodies or JID local parts to these
 * functions. Use `getDomain(jid)` for 1:1 conversation identifiers.
 * Room JIDs (service addresses) are acceptable.
 *
 * @module Core/Logger
 */

const PREFIX = '[Fluux]'

export function logInfo(message: string): void {
  console.info(PREFIX, message)
}

export function logWarn(message: string): void {
  console.warn(PREFIX, message)
}

export function logError(message: string): void {
  console.error(PREFIX, message)
}
