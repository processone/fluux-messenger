import { RoomJoinError } from '@fluux/sdk'

// Matches the TranslateFn convention in messagePreviewText.ts.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/**
 * Map an RFC 6120 condition from a room-join failure to a localized message.
 *
 * Takes the condition rather than the error object so the SDK's
 * `room:autojoin-error` event, which carries plain data, resolves its wording
 * through the same table as the thrown {@link RoomJoinError}.
 *
 * @param condition - Condition reported by the server, or the synthetic 'timeout'.
 * @param text - Server-supplied text, used when the condition is unrecognized.
 * @param opts.passwordWasSent see {@link getRoomJoinErrorMessage}
 */
export function getRoomJoinConditionMessage(
  t: TranslateFn,
  condition: string,
  text?: string,
  opts?: { passwordWasSent?: boolean },
): string {
  switch (condition) {
    case 'not-authorized':
      return t(opts?.passwordWasSent ? 'rooms.incorrectPassword' : 'rooms.passwordRequired')
    case 'conflict':
      return t('rooms.nicknameInUse')
    case 'registration-required':
      return t('rooms.membersOnly')
    case 'forbidden':
      return t('rooms.bannedFromRoom')
    case 'service-unavailable':
      return t('rooms.roomFull')
    case 'not-acceptable':
      return t('rooms.registeredNicknameRequired')
    case 'item-not-found':
      return t('rooms.roomNotFound')
    default:
      return text || t('rooms.failedToJoinRoom')
  }
}

/**
 * Map a room-join failure to a localized, user-facing message. Shared by
 * JoinRoomModal (inline error) and the secondary join paths (RoomView prompt,
 * RoomsList, BrowseRoomsModal, deep link) so the wording stays in sync. Field
 * side effects (revealing the password input, focusing the nickname) stay in
 * the modal — this resolves message text only.
 *
 * @param opts.passwordWasSent disambiguates the two `not-authorized` cases:
 *   false → "password required", true → "incorrect password". Secondary paths
 *   never send a password, so they omit it (defaults to false).
 */
export function getRoomJoinErrorMessage(
  t: TranslateFn,
  err: unknown,
  opts?: { passwordWasSent?: boolean },
): string {
  if (err instanceof RoomJoinError) {
    return getRoomJoinConditionMessage(t, err.condition, err.text, opts)
  }
  return err instanceof Error ? err.message : t('rooms.failedToJoinRoom')
}
