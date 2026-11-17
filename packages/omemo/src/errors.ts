/**
 * Why an OMEMO operation failed, so callers can tell a genuinely broken
 * session (worth repairing) from failures that must never reset one.
 *
 * - `duplicate`: the message was already consumed (a replay or double delivery).
 * - `not-addressed`: the message carries no key for this device and account.
 * - `malformed`: the wire data or payload is unreadable or fails its own check.
 * - `session-broken`: there is no usable session, or the session's ratchet
 *   cannot authenticate the message (a real desynchronisation).
 */
export type OmemoErrorCode = 'duplicate' | 'not-addressed' | 'malformed' | 'session-broken'

export class OmemoError extends Error {
  readonly code: OmemoErrorCode
  constructor(code: OmemoErrorCode, message: string) {
    super(message)
    this.name = 'OmemoError'
    this.code = code
  }
}
