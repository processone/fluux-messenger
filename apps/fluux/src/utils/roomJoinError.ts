import { RoomJoinError, type RoomJoinReason } from '@fluux/sdk'

// Matches the TranslateFn convention in messagePreviewText.ts.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

/**
 * Map a room-join reason to its localized, user-facing message.
 *
 * Takes the reason rather than the error object so the SDK's
 * `room:autojoin-error` event, which carries plain data, resolves its wording
 * through the same table as a thrown {@link RoomJoinError}.
 *
 * @param text - Server-supplied text, shown when the reason is `unknown`.
 */
export function getRoomJoinReasonMessage(
  t: TranslateFn,
  reason: RoomJoinReason,
  text?: string,
): string {
  switch (reason) {
    case 'password-required':
      return t('rooms.passwordRequired')
    case 'wrong-password':
      return t('rooms.incorrectPassword')
    case 'nickname-taken':
      return t('rooms.nicknameInUse')
    case 'members-only':
      return t('rooms.membersOnly')
    case 'banned':
      return t('rooms.bannedFromRoom')
    case 'room-full':
      return t('rooms.roomFull')
    case 'registered-nickname-required':
      return t('rooms.registeredNicknameRequired')
    case 'room-not-found':
      return t('rooms.roomNotFound')
    // `not-in-room`, `timed-out` and `unknown` carry nothing an app-specific
    // wording would add, so they read the server's own text when there is one.
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
 */
export function getRoomJoinErrorMessage(t: TranslateFn, err: unknown): string {
  if (err instanceof RoomJoinError) {
    return getRoomJoinReasonMessage(t, err.reason, err.text)
  }
  return err instanceof Error ? err.message : t('rooms.failedToJoinRoom')
}
