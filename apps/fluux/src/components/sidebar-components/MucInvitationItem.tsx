import { useTranslation } from 'react-i18next'
import { getLocalPart, type MucInvitation } from '@fluux/sdk'
import { Check, X, DoorOpen } from 'lucide-react'
import { Tooltip } from '../Tooltip'

interface MucInvitationItemProps {
  invitation: MucInvitation
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

      {/* Join keeps its label (primary action); decline is a compact icon
          button so the row never overflows the narrow sidebar. */}
      <div className="flex items-stretch gap-1.5 mt-2">
        <button
          type="button"
          onClick={onAccept}
          className="flex-1 min-w-0 px-2 py-1.5 bg-fluux-green text-white text-sm font-medium rounded hover:bg-fluux-green/80 transition-colors flex items-center justify-center gap-1"
        >
          <Check className="size-4 flex-shrink-0" />
          <span className="truncate">{t('events.join')}</span>
        </button>
        <Tooltip content={t('events.decline')} position="top">
          <button
            type="button"
            onClick={onDecline}
            className="flex-shrink-0 px-2.5 py-1.5 bg-fluux-muted/20 text-fluux-text rounded hover:bg-fluux-muted/30 transition-colors flex items-center justify-center"
            aria-label={t('events.decline')}
          >
            <X className="size-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
