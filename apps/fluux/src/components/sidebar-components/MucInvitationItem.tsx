import { useTranslation } from 'react-i18next'
import { getLocalPart, type RoomInvitation } from '@fluux/sdk'
import { DoorOpen } from 'lucide-react'
import { RequestActions } from './RequestActions'

interface MucInvitationItemProps {
  invitation: RoomInvitation
  onAccept: () => void
  onDecline: () => void
}

export function MucInvitationItem({ invitation, onAccept, onDecline }: MucInvitationItemProps) {
  const { t } = useTranslation()
  const roomName = getLocalPart(invitation.roomJid)
  const inviterName = getLocalPart(invitation.from)

  return (
    <div className="px-2 py-2 rounded hover:bg-fluux-hover transition-colors">
      <div className="flex items-center gap-3">
        {/* Room icon */}
        <div className="size-10 bg-fluux-brand rounded-lg flex items-center justify-center flex-shrink-0">
          <DoorOpen className="size-5 text-white" />
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-fluux-text truncate">{roomName}</p>
          <p className="text-xs text-fluux-muted truncate">
            {t('events.invitedBy', { name: inviterName })}
          </p>
          {invitation.reason && (
            <p className="text-xs text-fluux-muted truncate mt-0.5 italic">
              "{invitation.reason}"
            </p>
          )}
        </div>
      </div>

      <RequestActions
        acceptLabel={t('events.join')}
        onAccept={onAccept}
        dismissLabel={t('events.decline')}
        onDismiss={onDecline}
      />
    </div>
  )
}
