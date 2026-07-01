import { useTranslation } from 'react-i18next'
import { useRouteSync } from '@/hooks'
import { useRoomJoinWarning } from '@/hooks/useRoomJoinWarning'
import {
  useEvents,
  useBlocking,
  getBareJid,
  type SystemNotification,
} from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { Tooltip } from '../Tooltip'
import {
  X,
  AlertTriangle,
} from 'lucide-react'
import { MucInvitationItem } from './MucInvitationItem'
import { StrangerMessageItem } from './StrangerMessageItem'

export function EventsView() {
  const { t } = useTranslation()
  const { navigateToMessages, navigateToRooms } = useRouteSync()
  // NOTE: Use direct store subscriptions to avoid re-renders from activeMessages changes
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const { blockJid } = useBlocking()
  const { confirmJoin, warningDialog } = useRoomJoinWarning()
  const {
    strangerConversations,
    mucInvitations,
    systemNotifications,
    acceptStranger,
    ignoreStranger,
    acceptInvitation,
    declineInvitation,
    dismissNotification,
  } = useEvents()

  // Block stranger: ignore and block the JID
  const handleBlockStranger = async (jid: string) => {
    await ignoreStranger(jid)
    await blockJid(jid)
  }

  // Accept stranger and navigate to the new conversation
  const handleAcceptStranger = async (jid: string) => {
    await acceptStranger(jid)
    const bareJid = getBareJid(jid)
    void setActiveConversation(bareJid)
    navigateToMessages(bareJid)
  }

  // Accept invitation and navigate to the room.
  // Issue #37: the join happens inside acceptInvitation (client.muc.joinRoom), so
  // the app-level join guard doesn't otherwise cover it — warn here before joining
  // a room that would expose the user's real JID.
  const handleAcceptInvitation = async (roomJid: string, password?: string) => {
    if (!(await confirmJoin(roomJid))) return
    await acceptInvitation(roomJid, password)
    void setActiveRoom(roomJid)
    navigateToRooms(roomJid)
  }

  const strangerJids = Object.keys(strangerConversations)
  const hasContent = strangerJids.length > 0 || mucInvitations.length > 0 || systemNotifications.length > 0

  if (!hasContent) {
    return null
  }

  return (
    <div className="px-2 py-2">
      {systemNotifications.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2">
            {t('events.systemNotifications')}
          </h3>
          {systemNotifications.map((notification) => (
            <SystemNotificationItem
              key={notification.id}
              notification={notification}
              onDismiss={() => dismissNotification(notification.id)}
            />
          ))}
        </>
      )}
      {strangerJids.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2 mt-4">
            {t('events.messagesFromStrangers')} — {strangerJids.length}
          </h3>
          {strangerJids.map((jid) => (
            <StrangerMessageItem
              key={jid}
              jid={jid}
              messages={strangerConversations[jid]}
              onAccept={() => handleAcceptStranger(jid)}
              onIgnore={() => ignoreStranger(jid)}
              onBlock={() => handleBlockStranger(jid)}
            />
          ))}
        </>
      )}
      {mucInvitations.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2 mt-4">
            {t('events.roomInvitations')} — {mucInvitations.length}
          </h3>
          {mucInvitations.map((invitation) => (
            <MucInvitationItem
              key={invitation.id}
              invitation={invitation}
              onAccept={() => handleAcceptInvitation(invitation.roomJid, invitation.password)}
              onDecline={() => declineInvitation(invitation.roomJid)}
            />
          ))}
        </>
      )}
      {warningDialog}
    </div>
  )
}

interface SystemNotificationItemProps {
  notification: SystemNotification
  onDismiss: () => void
}

function SystemNotificationItem({ notification, onDismiss }: SystemNotificationItemProps) {
  const { t } = useTranslation()

  // Choose icon and color based on notification type
  const getTypeStyles = () => {
    switch (notification.type) {
      case 'resource-conflict':
        return { bgColor: 'bg-fluux-yellow/20', borderColor: 'border-fluux-yellow', iconColor: 'text-fluux-yellow' }
      case 'auth-error':
        return { bgColor: 'bg-fluux-red/20', borderColor: 'border-fluux-red', iconColor: 'text-fluux-error' }
      default:
        return { bgColor: 'bg-fluux-brand/20', borderColor: 'border-fluux-brand', iconColor: 'text-fluux-brand' }
    }
  }

  const { bgColor, borderColor, iconColor } = getTypeStyles()

  return (
    <div className={`px-3 py-3 rounded-lg ${bgColor} border ${borderColor} mb-2`}>
      <div className="flex items-start gap-3">
        {/* Icon */}
        <AlertTriangle className={`size-5 ${iconColor} flex-shrink-0 mt-0.5`} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-fluux-text">{notification.title}</p>
          <p className="text-sm text-fluux-muted mt-1">{notification.message}</p>
        </div>

        {/* Dismiss button */}
        <Tooltip content={t('sidebar.dismiss')} position="left">
          <button
            onClick={onDismiss}
            className="text-fluux-muted hover:text-fluux-text transition-colors tap-target"
            aria-label={t('sidebar.dismiss')}
          >
            <X className="size-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
