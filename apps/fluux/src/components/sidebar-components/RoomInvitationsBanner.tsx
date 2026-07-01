import { useTranslation } from 'react-i18next'
import { useEvents } from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { useRouteSync } from '@/hooks'
import { useRoomJoinWarning } from '@/hooks/useRoomJoinWarning'
import { MucInvitationItem } from './MucInvitationItem'

export function RoomInvitationsBanner() {
  const { t } = useTranslation()
  const { mucInvitations, acceptInvitation, declineInvitation } = useEvents()
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const { navigateToRooms } = useRouteSync()
  const { confirmJoin, warningDialog } = useRoomJoinWarning()

  if (mucInvitations.length === 0) return null

  // Issue #37: the join happens inside acceptInvitation; warn before joining a
  // room that would expose the user's real JID.
  const handleAccept = async (roomJid: string, password?: string) => {
    if (!(await confirmJoin(roomJid))) return
    await acceptInvitation(roomJid, password)
    void setActiveConversation(null)
    void setActiveRoom(roomJid)
    navigateToRooms(roomJid)
  }

  return (
    <div className="mb-3">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2">
        {t('rooms.invitationsHeading')} · {mucInvitations.length}
      </h3>
      <div className="space-y-0.5">
        {mucInvitations.map((invitation) => (
          <MucInvitationItem
            key={invitation.id}
            invitation={invitation}
            onAccept={() => handleAccept(invitation.roomJid, invitation.password)}
            onDecline={() => declineInvitation(invitation.roomJid)}
          />
        ))}
      </div>
      {warningDialog}
    </div>
  )
}
