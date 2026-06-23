import { RoomJoinError } from '@fluux/sdk'

// Matches the TranslateFn convention in messagePreviewText.ts.
type TranslateFn = (key: string, options?: Record<string, unknown>) => string

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
    switch (err.condition) {
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
        return err.text || t('rooms.failedToJoinRoom')
    }
  }
  return err instanceof Error ? err.message : t('rooms.failedToJoinRoom')
}
