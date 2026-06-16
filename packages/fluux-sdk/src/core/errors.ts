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
