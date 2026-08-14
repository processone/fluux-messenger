import type { XMPPErrorType } from '../utils/xmppError'

/**
 * Why a room join failed, in terms of what the user has to do about it.
 *
 * The wire condition alone does not answer that: `not-authorized` means "ask
 * for a password" or "that password was wrong" depending on whether one was
 * sent, and `not-acceptable` means "this room only admits your registered
 * nickname". Resolving that is the SDK's job, not each caller's.
 *
 * - `password-required` — the room is locked and no password was sent
 * - `wrong-password` — a password was sent and the room refused it
 * - `nickname-taken` — the nickname is in use by another occupant
 * - `members-only` — the room admits registered members only
 * - `banned` — this account is banned from the room
 * - `room-full` — the room reached its occupancy limit
 * - `registered-nickname-required` — the room only admits a reserved nickname
 * - `room-not-found` — no such room, and it was not created
 * - `not-in-room` — the operation needs an occupancy this client does not have
 * - `timed-out` — no response before the retry budget ran out
 * - `unknown` — the server gave a condition this list does not cover; read
 *   {@link RoomJoinError.condition} and {@link RoomJoinError.text} for detail
 */
export type RoomJoinReason =
  | 'password-required'
  | 'wrong-password'
  | 'nickname-taken'
  | 'members-only'
  | 'banned'
  | 'room-full'
  | 'registered-nickname-required'
  | 'room-not-found'
  | 'not-in-room'
  | 'timed-out'
  | 'unknown'

/**
 * Resolve an XEP-0045 §7.2 join failure to the reason a caller can act on.
 *
 * @param condition - RFC 6120 condition from the error presence, or one of the
 *   SDK's synthetic conditions (`'timeout'`, `'not-joined'`).
 * @param passwordSent - Whether the refused join carried a password. Only
 *   `not-authorized` reads it, to tell a missing password from a wrong one.
 */
export function roomJoinReasonFor(condition: string, passwordSent = false): RoomJoinReason {
  switch (condition) {
    case 'not-authorized':
      return passwordSent ? 'wrong-password' : 'password-required'
    case 'conflict':
      return 'nickname-taken'
    case 'registration-required':
      return 'members-only'
    case 'forbidden':
      return 'banned'
    case 'service-unavailable':
      return 'room-full'
    case 'not-acceptable':
      return 'registered-nickname-required'
    case 'item-not-found':
      return 'room-not-found'
    case 'not-joined':
      return 'not-in-room'
    case 'timeout':
      return 'timed-out'
    default:
      return 'unknown'
  }
}

/**
 * Error surfaced by {@link MUC.joinResult} when joining a MUC room fails.
 *
 * Read {@link RoomJoinError.reason} to decide what to do: it states the failure
 * in the application's terms and already resolves the cases the wire condition
 * leaves ambiguous. {@link RoomJoinError.condition} carries the underlying
 * RFC 6120 §8.3 condition for callers that want the protocol detail.
 */
export class RoomJoinError extends Error {
  readonly roomJid: string
  /** What the caller can act on. See {@link RoomJoinReason}. */
  readonly reason: RoomJoinReason
  /** RFC 6120 defined condition, e.g. 'not-authorized', 'conflict', or the synthetic 'timeout'. */
  readonly condition: string
  /** RFC 6120 error type, e.g. 'auth' | 'cancel' | 'modify' | 'wait', when available. */
  readonly errorType?: XMPPErrorType
  /** Optional human-readable server text. */
  readonly text?: string

  /**
   * @param options.passwordSent - Whether the refused join carried a password.
   *   Set by the join path so `not-authorized` resolves to `wrong-password`
   *   rather than `password-required`.
   */
  constructor(
    roomJid: string,
    condition: string,
    errorType?: XMPPErrorType,
    text?: string,
    options?: { passwordSent?: boolean },
  ) {
    super(text || `Room join failed: ${condition}`)
    this.name = 'RoomJoinError'
    this.roomJid = roomJid
    this.condition = condition
    this.reason = roomJoinReasonFor(condition, options?.passwordSent)
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
