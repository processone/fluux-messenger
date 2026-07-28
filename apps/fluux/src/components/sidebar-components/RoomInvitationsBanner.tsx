import { useTranslation } from 'react-i18next'
import { useEvents } from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { useRouteSync } from '@/hooks'
import { useRoomJoinWarning } from '@/hooks/useRoomJoinWarning'
import { useRoomPasswordPrompt } from '@/hooks/useRoomPasswordPrompt'
import { useToastStore } from '@/stores/toastStore'
import { getRoomJoinErrorMessage } from '@/utils/roomJoinError'
import { MucInvitationItem } from './MucInvitationItem'

export function RoomInvitationsBanner() {
  const { t } = useTranslation()
  const { mucInvitations, acceptInvitation, declineInvitation } = useEvents()
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const { navigateToRooms } = useRouteSync()
  const { confirmJoin, warningDialog } = useRoomJoinWarning()
  const { withPasswordPrompt, passwordDialog } = useRoomPasswordPrompt()
  const addToast = useToastStore((s) => s.addToast)

  if (mucInvitations.length === 0) return null

  // Issue #37: the join happens inside acceptInvitation; warn before joining a
  // room that would expose the user's real JID.
  const handleAccept = async (roomJid: string, password?: string) => {
    if (!(await confirmJoin(roomJid))) return
    try {
      // Issue #1126: an invitation to a password-protected room carries no
      // password unless the inviter added one. Ask for it rather than failing.
      // acceptInvitation keeps the invitation when the join is refused, so a
      // cancelled prompt (or any other error) leaves the banner intact to retry.
      const joined = await withPasswordPrompt((typed) => acceptInvitation(roomJid, typed ?? password))
      if (!joined) return
    } catch (err) {
      addToast('error', getRoomJoinErrorMessage(t, err))
      return
    }
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
      {passwordDialog}
    </div>
  )
}
