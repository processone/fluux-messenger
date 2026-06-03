/**
 * Helpers for surfacing XMPP stream-error conditions relayed by the Rust proxy
 * bridge.
 *
 * When an upstream XMPP server closes the stream with a `<stream:error>` (RFC
 * 6120 §4.9) — e.g. `host-unknown` when the connection host serves a different
 * vhost than the JID domain — the Tauri proxy encodes the condition in the
 * WebSocket close reason as `"… stream-error <condition>"`. Without translation
 * the user only sees a generic transport failure (`WebSocket ECONNERROR`), which
 * hides the real, actionable cause. These pure helpers recover the condition and
 * turn it into a clear message.
 */

/**
 * Clear, actionable wording for the stream-error conditions we expect to relay.
 * Conditions not listed here fall back to a generic message that still includes
 * the raw condition name.
 */
const STREAM_ERROR_MESSAGES: Record<string, string> = {
  'host-unknown':
    "This server does not serve your account's domain. Check the server address.",
  'host-gone': "This server no longer serves your account's domain.",
  'see-other-host': 'The server redirected the connection to a different host.',
  'not-authorized': 'The server refused the connection (not authorized).',
  'policy-violation': 'The connection was closed for a server policy violation.',
  'remote-connection-failed': 'The server could not reach a required backend service.',
  'system-shutdown': 'The server is shutting down or restarting.',
  conflict: 'Another session replaced this connection.',
}

/**
 * Extract an XMPP stream-error condition from a bridge close reason or
 * connection error message.
 *
 * Recognizes the proxy's `"… stream-error <condition>"` and
 * `"… stream-error: <condition>"` encodings, including when wrapped in a verbose
 * WebSocket-close message. Returns the lower-cased condition (an XML element
 * local name such as `host-unknown`), or `null` when the text carries no
 * stream-error condition (e.g. a plain transport failure).
 */
export function extractStreamErrorCondition(text: string): string | null {
  const match = text.match(/stream-error[:\s]+([a-z][a-z-]*)/i)
  return match ? match[1].toLowerCase() : null
}

/**
 * Turn a bridge close reason / connection error that encodes an upstream
 * stream-error condition into a clear, actionable message.
 *
 * Returns `null` when the text carries no stream-error condition, so callers can
 * keep their existing (transport-level) message unchanged.
 */
export function humanizeStreamError(text: string): string | null {
  const condition = extractStreamErrorCondition(text)
  if (!condition) return null
  const detail = STREAM_ERROR_MESSAGES[condition]
  return detail ? `${detail} (${condition})` : `The server closed the stream: ${condition}.`
}
