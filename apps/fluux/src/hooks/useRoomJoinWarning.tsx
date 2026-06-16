import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useRoomActions, type RoomFeatures } from '@fluux/sdk'
import { ConfirmDialog } from '@/components/ConfirmDialog'

interface PendingWarning {
  roomName: string
  resolve: (confirmed: boolean) => void
}

/**
 * Guards joining a MUC room that would expose the user's real JID (issue #37).
 *
 * `confirmJoin(roomJid)` inspects the room via disco#info and, if it is
 * non-anonymous and not deliberately private (members-only/hidden), shows a
 * one-time warning before the caller joins. It resolves to `true` when the join
 * should proceed (room is safe, already acknowledged, or the user accepted the
 * warning) and `false` when the user declined. Accepting records the
 * acknowledgement so the room is not warned about again.
 *
 * Render the returned `warningDialog` somewhere in the component so the prompt
 * can appear; it is `null` when no warning is pending.
 *
 * @example
 * const { confirmJoin, warningDialog } = useRoomJoinWarning()
 * // in a handler:
 * if (!(await confirmJoin(roomJid))) return
 * await joinRoom(roomJid, nickname)
 * // in JSX:
 * {warningDialog}
 */
export function useRoomJoinWarning() {
  const { t } = useTranslation()
  const { getRoomInfo, acknowledgeNonAnonymousRoom, isNonAnonymousRoomAcknowledged } = useRoomActions()
  const [pending, setPending] = useState<PendingWarning | null>(null)

  const confirmJoin = useCallback(
    async (roomJid: string): Promise<boolean> => {
      const features: RoomFeatures | null = await getRoomInfo(roomJid).catch(() => null)

      // Real-JID exposure = non-anonymous AND not deliberately private. A missing
      // public/access flag never silences the warning (fail-safe); only a positive
      // private signal (members-only/hidden) suppresses it.
      const exposesRealJid = features ? features.isNonAnonymous && !features.isPrivate : false
      if (!exposesRealJid || isNonAnonymousRoomAcknowledged(roomJid)) {
        return true
      }

      const roomName = features?.name || roomJid.split('@')[0]
      const confirmed = await new Promise<boolean>((resolve) => {
        setPending({ roomName, resolve })
      })
      setPending(null)

      if (confirmed) {
        acknowledgeNonAnonymousRoom(roomJid)
      }
      return confirmed
    },
    [getRoomInfo, acknowledgeNonAnonymousRoom, isNonAnonymousRoomAcknowledged]
  )

  const warningDialog = pending ? (
    <ConfirmDialog
      title={t('rooms.nonAnonWarningTitle')}
      message={t('rooms.nonAnonWarningMessage', { room: pending.roomName })}
      confirmLabel={t('rooms.nonAnonWarningConfirm')}
      variant="warning"
      onConfirm={() => pending.resolve(true)}
      onCancel={() => pending.resolve(false)}
    />
  ) : null

  return { confirmJoin, warningDialog }
}
