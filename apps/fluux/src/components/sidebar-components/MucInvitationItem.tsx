import { useTranslation } from 'react-i18next'
import { type MucInvitation } from '@fluux/sdk'
import { Check, X, DoorOpen } from 'lucide-react'

interface MucInvitationItemProps {
  invitation: MucInvitation
  onAccept: () => void
  onDecline: () => void
}

export function MucInvitationItem({ invitation, onAccept, onDecline }: MucInvitationItemProps) {
  const { t } = useTranslation()
  const roomName = invitation.roomJid.split('@')[0]
  const inviterName = invitation.from.split('@')[0]

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

      {/* Actions */}
      <div className="flex gap-2 mt-2 ms-13">
        <button
          onClick={onAccept}
          className="flex-1 px-3 py-1.5 bg-fluux-green text-white text-sm font-medium rounded hover:bg-fluux-green/80 transition-colors flex items-center justify-center gap-1"
        >
          <Check className="size-4" />
          {t('events.join')}
        </button>
        <button
          onClick={onDecline}
          className="flex-1 px-3 py-1.5 bg-fluux-red text-white text-sm font-medium rounded hover:bg-fluux-red/80 transition-colors flex items-center justify-center gap-1"
        >
          <X className="size-4" />
          {t('events.decline')}
        </button>
      </div>
    </div>
  )
}
