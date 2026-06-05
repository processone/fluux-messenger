/**
 * Fan-out diagnostic logger for the E2EE subsystem.
 *
 * Turns a console-store sink plus the SDK module logger into the `Logger`
 * interface that `E2EEManager` (and, via `ctx.logger`, plugins) call. Every
 * line is prefixed with `[E2EE]` and written to BOTH:
 *   - the in-app, filterable, exportable XMPP events log (`addEvent`), and
 *   - the persistent `[Fluux]` console/Rust file log.
 *
 * **Privacy:** callers must pass already-redacted messages (domain-only peer
 * identifiers, no plaintext/keys/passphrases). This module only formats and
 * fans out — it does not redact.
 *
 * @module Core/E2EEDiagnosticLogger
 */
import type { Logger } from './e2ee/types'
import { logDebug, logInfo, logWarn, logError } from './logger'

type EventCategory = 'connection' | 'error' | 'sm' | 'presence' | 'e2ee'

/** Minimal slice of the console store this logger needs. */
export interface E2EEDiagnosticSink {
  addEvent(message: string, category?: EventCategory): void
}

const PREFIX = '[E2EE]'

/** Append safe (string / Error.message) extra args; drop objects. */
function format(message: string, args: unknown[]): string {
  const base = `${PREFIX} ${message}`
  if (args.length === 0) return base
  const extra = args
    .map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : ''))
    .filter(Boolean)
    .join(' ')
  return extra ? `${base} ${extra}` : base
}

/**
 * Build the e2ee `Logger`. `sink` is the console store (or any object with a
 * compatible `addEvent`); pass `undefined` for headless use (module logger only).
 */
export function createE2EEDiagnosticLogger(sink?: E2EEDiagnosticSink): Logger {
  const emit = (moduleLog: (m: string) => void, message: string, args: unknown[]): void => {
    const line = format(message, args)
    moduleLog(line)
    sink?.addEvent(line, 'e2ee')
  }
  return {
    debug: (message, ...args) => emit(logDebug, message, args),
    info: (message, ...args) => emit(logInfo, message, args),
    warn: (message, ...args) => emit(logWarn, message, args),
    error: (message, ...args) => emit(logError, message, args),
  }
}
