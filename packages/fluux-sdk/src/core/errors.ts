import type { XMPPErrorType } from '../utils/xmppError'

/**
 * Error surfaced by {@link MUC.joinResult} when joining a MUC room fails.
 *
 * Carries the RFC 6120 §8.3 error condition so callers can react specifically:
 * prompt for a password on `not-authorized`, re-prompt the nickname on
 * `conflict`, explain `registration-required` / `forbidden`, etc.
 *
 * The synthetic condition `'timeout'` is used when the join receives no
 * response after the retry budget is exhausted (no server condition available).
 */
export class RoomJoinError extends Error {
  readonly roomJid: string
  /** RFC 6120 defined condition, e.g. 'not-authorized', 'conflict', or the synthetic 'timeout'. */
  readonly condition: string
  /** RFC 6120 error type, e.g. 'auth' | 'cancel' | 'modify' | 'wait', when available. */
  readonly errorType?: XMPPErrorType
  /** Optional human-readable server text. */
  readonly text?: string

  constructor(roomJid: string, condition: string, errorType?: XMPPErrorType, text?: string) {
    super(text || `Room join failed: ${condition}`)
    this.name = 'RoomJoinError'
    this.roomJid = roomJid
    this.condition = condition
    this.errorType = errorType
    this.text = text
    // Preserve the prototype chain so `instanceof RoomJoinError` works after
    // transpilation (TS targets that down-level class extends of Error).
    Object.setPrototypeOf(this, RoomJoinError.prototype)
  }
}

/**
 * Thrown by the whisper operation send path (correction/reaction/retraction)
 * when the target occupant is no longer present in the room — left, or the nick
 * has been recycled by a different occupant-id. The operation must NEVER fall
 * back to a public room broadcast, so the send path throws this instead.
 */
export class WhisperCounterpartGoneError extends Error {
  readonly roomJid: string
  readonly nick: string

  constructor(roomJid: string, nick: string) {
    super(`Whisper counterpart "${nick}" is no longer present in ${roomJid}`)
    this.name = 'WhisperCounterpartGoneError'
    this.roomJid = roomJid
    this.nick = nick
    Object.setPrototypeOf(this, WhisperCounterpartGoneError.prototype)
  }
}

/**
 * Thrown when an IQ request passed an explicit `timeoutMs` receives no reply
 * within that budget.
 *
 * The message is unchanged from the plain `Error` it replaces, so callers that
 * only inspect `err.message` keep working; the class exists so callers that
 * care can tell "the server never answered" apart from "the server said no".
 */
export class IQTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`IQ timeout after ${timeoutMs}ms`)
    this.name = 'IQTimeoutError'
    this.timeoutMs = timeoutMs
    Object.setPrototypeOf(this, IQTimeoutError.prototype)
  }
}

/**
 * Thrown by the XEP-0050 ad-hoc command path used for XEP-0317 hat management
 * (create / destroy / assign / unassign / list) when the command does not
 * succeed.
 *
 * Carries the reason so the UI can tell the user *why* the command failed
 * instead of showing a fixed "operation failed" string:
 *
 * - `condition` is the RFC 6120 §8.3 defined condition returned by the server
 *   (`forbidden`, `item-not-found`, `bad-request`, …), or the synthetic
 *   `'timeout'` when the server never replied, or `'undefined-condition'` when
 *   the failure carries no usable condition at all.
 * - `text` is the server's human-readable `<text/>`, when it sent one.
 */
export class HatCommandError extends Error {
  readonly roomJid: string
  /** Command node, e.g. `urn:xmpp:hats:commands:destroy`. */
  readonly node: string
  /** RFC 6120 defined condition, or the synthetic `'timeout'`. */
  readonly condition: string
  /** RFC 6120 error type, when the failure came from a server error reply. */
  readonly errorType?: XMPPErrorType
  /** Optional human-readable server text. */
  readonly text?: string

  constructor(
    roomJid: string,
    node: string,
    condition: string,
    options: { errorType?: XMPPErrorType; text?: string; cause?: unknown; message?: string } = {},
  ) {
    // `message` lets the classifier preserve the underlying failure's own wording
    // when there is no condition to report, so nothing is lost by wrapping.
    super(options.message || options.text || `Hat command "${node}" failed on ${roomJid}: ${condition}`)
    this.name = 'HatCommandError'
    this.roomJid = roomJid
    this.node = node
    this.condition = condition
    this.errorType = options.errorType
    this.text = options.text
    if (options.cause !== undefined) this.cause = options.cause
    Object.setPrototypeOf(this, HatCommandError.prototype)
  }
}
