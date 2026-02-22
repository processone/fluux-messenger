import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import {
  useEvents,
  useBlocking,
  getBareJid,
  type SubscriptionRequest,
  type MucInvitation,
  type SystemNotification,
} from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { Avatar } from '../Avatar'
import { Tooltip } from '../Tooltip'
import {
  X,
  Check,
  AlertTriangle,
  DoorOpen,
  Ban,
} from 'lucide-react'

export function EventsView() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // NOTE: Use direct store subscriptions to avoid re-renders from activeMessages changes
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const { blockJid } = useBlocking()
  const {
    subscriptionRequests,
    strangerConversations,
    mucInvitations,
    systemNotifications,
    acceptSubscription,
    rejectSubscription,
    acceptStranger,
    ignoreStranger,
    acceptInvitation,
    declineInvitation,
    dismissNotification,
  } = useEvents()

  // Block subscription request: reject and block the JID
  const handleBlockSubscription = async (jid: string) => {
    await rejectSubscription(jid)
    await blockJid(jid)
  }

  // Block stranger: ignore and block the JID
  const handleBlockStranger = async (jid: string) => {
    await ignoreStranger(jid)
    await blockJid(jid)
  }

  // Accept stranger and navigate to the new conversation
  const handleAcceptStranger = async (jid: string) => {
    await acceptStranger(jid)
    const bareJid = getBareJid(jid)
    void navigate(`/messages/${encodeURIComponent(bareJid)}`)
    void setActiveConversation(bareJid)
  }

  // Accept invitation and navigate to the room
  const handleAcceptInvitation = async (roomJid: string, password?: string) => {
    await acceptInvitation(roomJid, password)
    void navigate(`/rooms/${encodeURIComponent(roomJid)}`)
    void setActiveRoom(roomJid)
  }

  const strangerJids = Object.keys(strangerConversations)
  const hasContent = subscriptionRequests.length > 0 || strangerJids.length > 0 || mucInvitations.length > 0 || systemNotifications.length > 0

  if (!hasContent) {
    return (
      <div className="px-3 py-4 text-fluux-muted text-sm text-center">
        {t('events.noPendingEvents')}
      </div>
    )
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
      {subscriptionRequests.length > 0 && (
        <>
          <h3 className="text-xs font-semibold text-fluux-muted uppercase px-2 mb-2 mt-4">
            {t('events.subscriptionRequests')} — {subscriptionRequests.length}
          </h3>
          {subscriptionRequests.map((request) => (
            <SubscriptionRequestItem
              key={request.id}
              request={request}
              onAccept={() => acceptSubscription(request.from)}
              onReject={() => rejectSubscription(request.from)}
              onBlock={() => handleBlockSubscription(request.from)}
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
        return { bgColor: 'bg-fluux-red/20', borderColor: 'border-fluux-red', iconColor: 'text-fluux-red' }
      default:
        return { bgColor: 'bg-fluux-brand/20', borderColor: 'border-fluux-brand', iconColor: 'text-fluux-brand' }
    }
  }

  const { bgColor, borderColor, iconColor } = getTypeStyles()

  return (
    <div className={`px-3 py-3 rounded-lg ${bgColor} border ${borderColor} mb-2`}>
      <div className="flex items-start gap-3">
        {/* Icon */}
        <AlertTriangle className={`w-5 h-5 ${iconColor} flex-shrink-0 mt-0.5`} />

        {/* Content */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-fluux-text">{notification.title}</p>
          <p className="text-sm text-fluux-muted mt-1">{notification.message}</p>
        </div>

        {/* Dismiss button */}
        <Tooltip content={t('sidebar.dismiss')} position="left">
          <button
            onClick={onDismiss}
            className="text-fluux-muted hover:text-fluux-text transition-colors"
            aria-label={t('sidebar.dismiss')}
          >
            <X className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

interface SubscriptionRequestItemProps {
  request: SubscriptionRequest
  onAccept: () => void
  onReject: () => void
  onBlock: () => void
}

function SubscriptionRequestItem({ request, onAccept, onReject, onBlock }: SubscriptionRequestItemProps) {
  const { t } = useTranslation()
  const displayName = request.from.split('@')[0]

  return (
    <div className="px-2 py-2 rounded hover:bg-fluux-hover transition-colors">
      <div className="flex items-center gap-3">
        {/* Avatar */}
        <Avatar
          identifier={request.from}
          name={displayName}
          size="md"
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="font-medium text-fluux-text truncate">{displayName}</p>
          <p className="text-xs text-fluux-muted truncate">{request.from}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-2 ml-13">
        <button
          onClick={onAccept}
          className="flex-1 px-3 py-1.5 bg-fluux-green text-white text-sm font-medium rounded hover:bg-fluux-green/80 transition-colors flex items-center justify-center gap-1"
        >
          <Check className="w-4 h-4" />
          {t('common.accept')}
        </button>
        <button
          onClick={onReject}
          className="flex-1 px-3 py-1.5 bg-fluux-muted/20 text-fluux-text text-sm font-medium rounded hover:bg-fluux-muted/30 transition-colors flex items-center justify-center gap-1"
        >
          <X className="w-4 h-4" />
          {t('common.reject')}
        </button>
        <Tooltip content={t('common.block')} position="top">
          <button
            onClick={onBlock}
            className="px-3 py-1.5 bg-fluux-red text-white text-sm font-medium rounded hover:bg-fluux-red/80 transition-colors flex items-center justify-center gap-1"
            aria-label={t('common.block')}
          >
            <Ban className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

interface MucInvitationItemProps {
  invitation: MucInvitation
  onAccept: () => void
  onDecline: () => void
}

function MucInvitationItem({ invitation, onAccept, onDecline }: MucInvitationItemProps) {
  const { t } = useTranslation()
  const roomName = invitation.roomJid.split('@')[0]
  const inviterName = invitation.from.split('@')[0]

  return (
    <div className="px-2 py-2 rounded hover:bg-fluux-hover transition-colors">
      <div className="flex items-center gap-3">
        {/* Room icon */}
        <div className="w-10 h-10 bg-fluux-brand rounded-lg flex items-center justify-center flex-shrink-0">
          <DoorOpen className="w-5 h-5 text-white" />
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
      <div className="flex gap-2 mt-2 ml-13">
        <button
          onClick={onAccept}
          className="flex-1 px-3 py-1.5 bg-fluux-green text-white text-sm font-medium rounded hover:bg-fluux-green/80 transition-colors flex items-center justify-center gap-1"
        >
          <Check className="w-4 h-4" />
          {t('events.join')}
        </button>
        <button
          onClick={onDecline}
          className="flex-1 px-3 py-1.5 bg-fluux-red text-white text-sm font-medium rounded hover:bg-fluux-red/80 transition-colors flex items-center justify-center gap-1"
        >
          <X className="w-4 h-4" />
          {t('events.decline')}
        </button>
      </div>
    </div>
  )
}

interface StrangerMessageItemProps {
  jid: string
  messages: { id: string; from: string; body: string; timestamp: Date }[]
  onAccept: () => void
  onIgnore: () => void
  onBlock: () => void
}

function StrangerMessageItem({ jid, messages, onAccept, onIgnore, onBlock }: StrangerMessageItemProps) {
  const { t } = useTranslation()
  const displayName = jid.split('@')[0]
  const latestMessage = messages[messages.length - 1]
  const messageCount = messages.length

  return (
    <div className="px-2 py-2 rounded hover:bg-fluux-hover transition-colors">
      <div className="flex items-center gap-3">
        {/* Avatar */}
        <Avatar
          identifier={jid}
          name={displayName}
          size="md"
        />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="font-medium text-fluux-text truncate">{displayName}</p>
            {messageCount > 1 && (
              <span className="text-xs bg-fluux-brand/20 text-fluux-brand px-1.5 py-0.5 rounded">
                {messageCount}
              </span>
            )}
          </div>
          <p className="text-xs text-fluux-muted truncate">{latestMessage?.body}</p>
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-2 ml-13">
        <button
          onClick={onAccept}
          className="flex-1 px-3 py-1.5 bg-fluux-brand text-white text-sm font-medium rounded hover:bg-fluux-brand-hover transition-colors flex items-center justify-center gap-1"
        >
          <Check className="w-4 h-4" />
          {t('common.accept')}
        </button>
        <button
          onClick={onIgnore}
          className="flex-1 px-3 py-1.5 bg-fluux-muted/20 text-fluux-text text-sm font-medium rounded hover:bg-fluux-muted/30 transition-colors flex items-center justify-center gap-1"
        >
          <X className="w-4 h-4" />
          {t('common.ignore')}
        </button>
        <Tooltip content={t('common.block')} position="top">
          <button
            onClick={onBlock}
            className="px-3 py-1.5 bg-fluux-red text-white text-sm font-medium rounded hover:bg-fluux-red/80 transition-colors flex items-center justify-center gap-1"
            aria-label={t('common.block')}
          >
            <Ban className="w-4 h-4" />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
