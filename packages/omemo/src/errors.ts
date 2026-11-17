/**
 * Why an OMEMO operation failed, so callers can tell a genuinely broken
 * session (worth repairing) from failures that must never reset one.
 *
 * - `duplicate`: the message was already consumed (a replay or double delivery).
 * - `not-addressed`: the message carries no key for this device and account.
 * - `malformed`: the wire data or payload is unreadable or fails its own check,
 *   including a message whose MAC does not verify and a key exchange naming a
 *   signed prekey we never published. Anyone able to inject a stanza can produce
 *   these, so they never trigger session repair.
 * - `session-broken`: there is no usable session, or the ratchet cannot follow
 *   the sender (a gap beyond the skipped-key limit): a real desynchronisation.
 */
export type OmemoErrorCode = 'duplicate' | 'not-addressed' | 'malformed' | 'session-broken'

export class OmemoError extends Error {
  readonly code: OmemoErrorCode
  /** For `duplicate`: the identity key the session recorded for the sender. */
  readonly senderIdentityKey?: Uint8Array
  constructor(code: OmemoErrorCode, message: string, senderIdentityKey?: Uint8Array) {
    super(message)
    this.name = 'OmemoError'
    this.code = code
    if (senderIdentityKey) this.senderIdentityKey = senderIdentityKey
  }
}
