/**
 * Helpers for surfacing transport-level (TLS / TCP) connection failures relayed
 * by the Rust proxy bridge.
 *
 * When the upstream TLS handshake or TCP connect fails, the proxy encodes a
 * stable class in the WebSocket close reason as `"… tls-error <class>"`
 * (e.g. `certificate-expired`). This mirrors the `stream-error <condition>`
 * encoding handled by `streamErrors.ts`. These pure helpers recover the class
 * and turn it into a clear message, and expose a single classifier the app uses
 * to pick localized error UX.
 *
 * Note: genuine TLS-class detection is desktop-only (the proxy). On web the
 * browser hides cert detail behind an opaque close, so `extractTransportErrorClass`
 * returns `null` there and callers keep their generic message.
 */

/** Coarse connection-error kind the UI maps to localized error UX. */
export type ConnectionErrorKind =
  | 'tls-certificate'
  | 'tls-other'
  | 'connection-refused'
  | 'timeout'
  | 'auth'
  | 'unknown'

/** Clear, actionable wording for each transport class we expect to relay. */
const TRANSPORT_ERROR_MESSAGES: Record<string, string> = {
  'certificate-expired':
    "The server's security certificate has expired. (certificate-expired)",
  'certificate-name-mismatch':
    "The server's security certificate was issued for a different host. (certificate-name-mismatch)",
  'certificate-untrusted':
    "The server's security certificate is not trusted (self-signed or unknown issuer). (certificate-untrusted)",
  certificate:
    "The server's security certificate could not be verified. (certificate)",
  timeout: 'The server did not respond in time. (timeout)',
  refused: 'The server refused the connection. (refused)',
}

/**
 * Extract a transport-error class from a bridge close reason or connection
 * error message. Recognizes the proxy's `"… tls-error <class>"` /
 * `"… tls-error: <class>"` encodings, including when wrapped in a verbose
 * WebSocket-close message. Returns the lower-cased class, or `null`.
 */
export function extractTransportErrorClass(text: string): string | null {
  const match = text.match(/tls-error[:\s]+([a-z][a-z-]*)/i)
  return match ? match[1].toLowerCase() : null
}

/**
 * Turn a connection error that encodes a transport class into a clear message.
 * Returns `null` when no transport class is present, so callers keep their
 * existing (transport-level) message unchanged.
 */
export function humanizeTransportError(text: string): string | null {
  const cls = extractTransportErrorClass(text)
  if (!cls) return null
  const detail = TRANSPORT_ERROR_MESSAGES[cls]
  return detail ?? `The connection failed at the transport layer: ${cls}.`
}

/** Auth-failure detection (bad credentials). */
function isAuthErrorText(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('not-authorized') || lower.includes('authentication failed')
}

/**
 * Classify a connection error string into a coarse kind the UI maps to localized
 * error UX. Single source of truth for parsing connection errors.
 */
export function classifyConnectionError(error: string): ConnectionErrorKind {
  if (!error) return 'unknown'
  const cls = extractTransportErrorClass(error)
  if (cls) {
    if (cls.startsWith('certificate')) return 'tls-certificate'
    if (cls === 'timeout') return 'timeout'
    if (cls === 'refused') return 'connection-refused'
    return 'tls-other'
  }
  if (isAuthErrorText(error)) return 'auth'
  return 'unknown'
}
