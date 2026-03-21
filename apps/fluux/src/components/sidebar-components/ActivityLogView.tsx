import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useActivityLog,
  useEvents,
  type ActivityEvent,
  type ActivityEventType,
  type ReactionReceivedPayload,
  getBareJid,
} from '@fluux/sdk'
import { Avatar } from '../Avatar'
import { Tooltip } from '../Tooltip'
import {
  UserPlus,
  UserCheck,
  UserX,
  DoorOpen,
  Heart,
  AlertTriangle,
  MessageCircle,
  CheckCircle,
  XCircle,
  MinusCircle,
  BellOff,
  Bell,
  Eye,
} from 'lucide-react'

/** Group events by date (Today, Yesterday, or date string) */
function groupEventsByDate(events: ActivityEvent[]): Map<string, ActivityEvent[]> {
  const groups = new Map<string, ActivityEvent[]>()
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(yesterday.getDate() - 1)

  const formatDate = (d: Date) => d.toISOString().slice(0, 10)
  const todayStr = formatDate(today)
  const yesterdayStr = formatDate(yesterday)

  for (const event of events) {
    const dateStr = formatDate(event.timestamp)
    let label: string
    if (dateStr === todayStr) label = 'today'
    else if (dateStr === yesterdayStr) label = 'yesterday'
    else label = event.timestamp.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

    if (!groups.has(label)) groups.set(label, [])
    groups.get(label)!.push(event)
  }
  return groups
}

function getEventIcon(type: ActivityEventType) {
  switch (type) {
    case 'subscription-request': return UserPlus
    case 'subscription-accepted': return UserCheck
    case 'subscription-denied': return UserX
    case 'muc-invitation': return DoorOpen
    case 'reaction-received': return Heart
    case 'resource-conflict':
    case 'auth-error':
    case 'connection-error': return AlertTriangle
    case 'stranger-message': return MessageCircle
    default: return Bell
  }
}

function getResolutionIcon(resolution: string) {
  switch (resolution) {
    case 'accepted': return CheckCircle
    case 'rejected': return XCircle
    case 'dismissed': return MinusCircle
    default: return null
  }
}

function getResolutionColor(resolution: string) {
  switch (resolution) {
    case 'accepted': return 'text-fluux-green'
    case 'rejected': return 'text-fluux-red'
    case 'dismissed': return 'text-fluux-muted'
    default: return ''
  }
}

export function ActivityLogView() {
  const { t } = useTranslation()
  const { events, unreadCount, markAllRead, muteType, unmuteType, mutedTypes, markRead } = useActivityLog()
  const { pendingCount } = useEvents()

  const groupedEvents = useMemo(() => groupEventsByDate(events), [events])

  // Show combined empty state only when both pending events and activity log are empty
  if (events.length === 0) {
    if (pendingCount === 0) {
      return (
        <div className="px-3 py-4 text-fluux-muted text-sm text-center">
          {t('events.noPendingEvents')}
        </div>
      )
    }
    return null
  }

  return (
    <div className="px-2 py-2">
      {/* Header with mark all read */}
      <div className="flex items-center justify-between px-2 mb-3">
        <h3 className="text-xs font-semibold text-fluux-muted uppercase">
          {t('activityLog.title')}
        </h3>
        {unreadCount > 0 && (
          <Tooltip content={t('activityLog.markAllRead')} position="left">
            <button
              onClick={markAllRead}
              className="text-fluux-muted hover:text-fluux-text transition-colors"
              aria-label={t('activityLog.markAllRead')}
            >
              <Eye className="w-4 h-4" />
            </button>
          </Tooltip>
        )}
      </div>

      {/* Grouped event list */}
      {Array.from(groupedEvents.entries()).map(([dateLabel, dayEvents]) => (
        <div key={dateLabel} className="mb-3">
          <div className="text-[10px] font-semibold text-fluux-muted uppercase px-2 mb-1">
            {dateLabel === 'today' ? t('activityLog.today')
              : dateLabel === 'yesterday' ? t('activityLog.yesterday')
              : dateLabel}
          </div>
          {dayEvents.map((event) => (
            <ActivityEventItem
              key={event.id}
              event={event}
              onMarkRead={() => markRead(event.id)}
              isMuted={mutedTypes.has(event.type)}
              onMuteType={() => muteType(event.type)}
              onUnmuteType={() => unmuteType(event.type)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

interface ActivityEventItemProps {
  event: ActivityEvent
  onMarkRead: () => void
  isMuted: boolean
  onMuteType: () => void
  onUnmuteType: () => void
}

function ActivityEventItem({ event, onMarkRead, isMuted, onMuteType, onUnmuteType }: ActivityEventItemProps) {
  const { t } = useTranslation()
  const Icon = getEventIcon(event.type)
  const ResolutionIcon = event.resolution && event.resolution !== 'pending'
    ? getResolutionIcon(event.resolution)
    : null

  const description = getEventDescription(event, t)
  const timeStr = event.timestamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const avatarId = getEventAvatarId(event)

  return (
    <div
      className={`group flex items-start gap-2 px-2 py-1.5 rounded transition-colors cursor-default
        ${!event.read ? 'bg-fluux-brand/5' : 'hover:bg-fluux-hover'}
        ${event.muted ? 'opacity-50' : ''}`}
      onClick={() => { if (!event.read) onMarkRead() }}
    >
      {/* Avatar or icon */}
      <div className="flex-shrink-0 mt-0.5">
        {avatarId ? (
          <Avatar identifier={avatarId} name={avatarId.split('@')[0]} size="sm" />
        ) : (
          <div className="w-7 h-7 rounded-full bg-fluux-hover flex items-center justify-center">
            <Icon className="w-3.5 h-3.5 text-fluux-muted" />
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className={`text-xs leading-tight ${!event.read ? 'text-fluux-text font-medium' : 'text-fluux-muted'}`}>
          {description}
        </p>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className="text-[10px] text-fluux-muted">{timeStr}</span>
          {ResolutionIcon && event.resolution && (
            <span className={`flex items-center gap-0.5 text-[10px] ${getResolutionColor(event.resolution)}`}>
              <ResolutionIcon className="w-3 h-3" />
              {t(`activityLog.${event.resolution}`)}
            </span>
          )}
          {!event.read && (
            <span className="w-1.5 h-1.5 rounded-full bg-fluux-brand flex-shrink-0" />
          )}
        </div>
      </div>

      {/* Mute toggle (visible on hover) */}
      <Tooltip content={isMuted ? t('activityLog.unmuteType') : t('activityLog.muteType')} position="left">
        <button
          onClick={(e) => { e.stopPropagation(); if (isMuted) { onUnmuteType() } else { onMuteType() } }}
          className="opacity-0 group-hover:opacity-100 text-fluux-muted hover:text-fluux-text transition-all flex-shrink-0 mt-0.5"
          aria-label={isMuted ? t('activityLog.unmuteType') : t('activityLog.muteType')}
        >
          {isMuted ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
        </button>
      </Tooltip>
    </div>
  )
}

/** Get the JID or identifier to use for the avatar */
function getEventAvatarId(event: ActivityEvent): string | null {
  switch (event.payload.type) {
    case 'subscription-request':
    case 'subscription-accepted':
    case 'subscription-denied':
      return event.payload.from
    case 'stranger-message':
      return event.payload.from
    case 'reaction-received':
      // Use first reactor for avatar
      return event.payload.reactors[0]?.reactorJid ?? null
    case 'muc-invitation':
      return event.payload.from
    default:
      return null
  }
}

/** Generate human-readable description for an event */
function getEventDescription(event: ActivityEvent, t: (key: string, opts?: Record<string, string>) => string): string {
  const p = event.payload
  switch (p.type) {
    case 'subscription-request':
      return t('activityLog.subscriptionRequest', { name: getBareJid(p.from).split('@')[0] })
    case 'subscription-accepted':
      return t('activityLog.subscriptionAccepted', { name: getBareJid(p.from).split('@')[0] })
    case 'subscription-denied':
      return t('activityLog.subscriptionDenied', { name: getBareJid(p.from).split('@')[0] })
    case 'muc-invitation':
      return t('activityLog.mucInvitation', { room: p.roomJid.split('@')[0] })
    case 'reaction-received': {
      const rp = p as ReactionReceivedPayload
      const allEmojis = [...new Set(rp.reactors.flatMap((r) => r.emojis))].join(' ')
      const names = rp.reactors.map((r) => r.reactorJid.split('@')[0])
      const nameStr = names.length <= 2
        ? names.join(' & ')
        : `${names[0]} +${names.length - 1}`
      let desc = t('activityLog.reactionReceived', { name: nameStr, emojis: allEmojis })
      if (rp.messagePreview) {
        const preview = rp.messagePreview.length > 40 ? rp.messagePreview.substring(0, 40) + '…' : rp.messagePreview
        desc += t('activityLog.reactionReceivedTo', { preview })
      }
      return desc
    }
    case 'stranger-message':
      return t('activityLog.strangerMessage', { name: getBareJid(p.from).split('@')[0] })
    case 'resource-conflict':
      return t('activityLog.resourceConflict')
    case 'auth-error':
      return t('activityLog.authError')
    case 'connection-error':
      return t('activityLog.connectionError')
    default:
      return event.type
  }
}
