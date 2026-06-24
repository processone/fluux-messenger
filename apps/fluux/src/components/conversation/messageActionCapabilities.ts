/**
 * Pure capability rules for a message's action surfaces (hover toolbar + touch
 * action sheet). Extracted so the whisper (XEP-0045 §7.5) gating is testable.
 *
 * Whisper parity with a 1:1 DM:
 * - own whisper: edit / delete (retract) / react / reply
 * - incoming whisper: react / reply (NO edit; NO moderation-delete)
 * - any whisper: disabled once the counterpart has left (counterpartGone)
 */
export interface MessageActionInputs {
  isOutgoing: boolean
  /** The message is a whisper (private MUC message). */
  isPrivate: boolean
  isLastOutgoing: boolean
  isLastMessage: boolean
  /** The message is rendered inside a whisper thread. */
  inThread: boolean
  /** Whisper counterpart has left the room (thread is read-only). */
  counterpartGone: boolean
  isIrcGateway: boolean
  canModerate: boolean
  /** The room exposes reactions (stable occupant identity available). */
  reactionsEnabled: boolean
}

export interface MessageActionCapabilities {
  canReply: boolean
  canEdit: boolean
  canDelete: boolean
  canReact: boolean
}

export function computeMessageActions(i: MessageActionInputs): MessageActionCapabilities {
  return {
    canReply: (!i.isLastMessage || i.inThread) && !i.counterpartGone,
    canEdit: i.isOutgoing && i.isLastOutgoing && !i.isIrcGateway && !i.counterpartGone,
    // XEP-0045 §7.5: a private whisper cannot be moderated (no server archive), so
    // the moderator path is suppressed for whispers; gate on counterpart presence.
    canDelete: (i.isOutgoing || (i.canModerate && !i.isPrivate)) && !i.isIrcGateway && !i.counterpartGone,
    canReact: i.reactionsEnabled && !i.counterpartGone,
  }
}
