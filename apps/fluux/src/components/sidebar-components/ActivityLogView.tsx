import { useState, useRef, useEffect, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useActivityLog,
  useEvents,
  type ActivityEvent,
  type ActivityEventType,
  type ReactionReceivedPayload,
  getBareJid,
} from '@fluux/sdk'
import { roomStore } from '@fluux/sdk'
import { useNavigateToTarget } from '@/hooks/useNavigateToTarget'
import { getNavigationTarget } from './activityNavigation'
import { Avatar } from '../Avatar'
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
  const {
    events,
    mutedReactionConversations, mutedReactionMessages,
    muteReactionsForConversation, unmuteReactionsForConversation,
    muteReactionsForMessage, unmuteReactionsForMessage,
    setPreviewEvent,
  } = useActivityLog()
  const { pendingCount } = useEvents()
  const { navigateToConversation, navigateToRoom } = useNavigateToTarget()
  // Read room existence imperatively — subscribing via selector would return
  // a new closure on every store update, causing an infinite render loop.
  const hasRoom = useCallback((jid: string) => roomStore.getState().rooms.has(jid), [])

  const handleNavigate = useCallback((event: ActivityEvent) => {
    // For reaction events, show inline context preview instead of navigating away
    if (event.type === 'reaction-received') {
      setPreviewEvent(event)
      return
    }

    const target = getNavigationTarget(event)
    if (!target) return

    if (target.type === 'room') {
      navigateToRoom(target.jid, target.messageId)
    } else if (target.type === 'conversation') {
      navigateToConversation(target.jid, target.messageId)
    } else {
      // 'auto' — check if it's a room or conversation
      if (hasRoom(target.jid)) {
        navigateToRoom(target.jid, target.messageId)
      } else {
        navigateToConversation(target.jid, target.messageId)
      }
    }
  }, [navigateToConversation, navigateToRoom, hasRoom, setPreviewEvent])

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
      {/* Header */}
      <div className="flex items-center justify-between px-2 mb-3">
        <h3 className="text-xs font-semibold text-fluux-muted uppercase">
          {t('activityLog.title')}
        </h3>
      </div>

      {/* Grouped event list */}
      {Array.from(groupedEvents.entries()).map(([dateLabel, dayEvents]) => (
        <div key={dateLabel} className="mb-3">
          <div className="text-[10px] font-semibold text-fluux-muted uppercase px-2 mb-1">
            {dateLabel === 'today' ? t('activityLog.today')
              : dateLabel === 'yesterday' ? t('activityLog.yesterday')
              : dateLabel}
          </div>
          {dayEvents.map((event) => {
            const reactionMuteProps = event.type === 'reaction-received'
              ? {
                  isConversationMuted: mutedReactionConversations.has(
                    (event.payload as ReactionReceivedPayload).conversationId
                  ),
                  isMessageMuted: mutedReactionMessages.has(
                    (event.payload as ReactionReceivedPayload).messageId
                  ),
                  onMuteConversation: () => muteReactionsForConversation(
                    (event.payload as ReactionReceivedPayload).conversationId
                  ),
                  onUnmuteConversation: () => unmuteReactionsForConversation(
                    (event.payload as ReactionReceivedPayload).conversationId
                  ),
                  onMuteMessage: () => muteReactionsForMessage(
                    (event.payload as ReactionReceivedPayload).messageId
                  ),
                  onUnmuteMessage: () => unmuteReactionsForMessage(
                    (event.payload as ReactionReceivedPayload).messageId
                  ),
                }
              : {}
            return (
              <ActivityEventItem
                key={event.id}
                event={event}
                onNavigate={() => handleNavigate(event)}
                isNavigable={getNavigationTarget(event) !== null}
                {...reactionMuteProps}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

interface ActivityEventItemProps {
  event: ActivityEvent
  onNavigate: () => void
  isNavigable: boolean
  // Reaction muting (only for reaction-received events)
  isConversationMuted?: boolean
  isMessageMuted?: boolean
  onMuteConversation?: () => void
  onUnmuteConversation?: () => void
  onMuteMessage?: () => void
  onUnmuteMessage?: () => void
}

function ActivityEventItem({
  event, onNavigate, isNavigable,
  isConversationMuted, isMessageMuted,
  onMuteConversation, onUnmuteConversation,
  onMuteMessage, onUnmuteMessage,
}: ActivityEventItemProps) {
  const { t } = useTranslation()
  const Icon = getEventIcon(event.type)
  const ResolutionIcon = event.resolution && event.resolution !== 'pending'
    ? getResolutionIcon(event.resolution)
    : null

  const description = getEventDescription(event, t)
  const timeStr = event.timestamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const avatarId = getEventAvatarId(event)
  const isReaction = event.type === 'reaction-received'

  const handleClick = () => {
    if (isNavigable) onNavigate()
  }

  return (
    <div
      className={`group flex items-start gap-2 px-2 py-1.5 rounded transition-colors
        ${isNavigable ? 'cursor-pointer hover:bg-fluux-hover' : 'cursor-default'}
        ${event.muted ? 'opacity-50' : ''}`}
      onClick={handleClick}
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
        <p className="text-xs leading-tight text-fluux-muted">
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
        </div>
      </div>

      {/* Reaction mute dropdown (only for reaction-received events) */}
      {isReaction && (
        <ReactionMuteDropdown
          isConversationMuted={isConversationMuted ?? false}
          isMessageMuted={isMessageMuted ?? false}
          onMuteConversation={onMuteConversation}
          onUnmuteConversation={onUnmuteConversation}
          onMuteMessage={onMuteMessage}
          onUnmuteMessage={onUnmuteMessage}
        />
      )}
    </div>
  )
}

interface ReactionMuteDropdownProps {
  isConversationMuted: boolean
  isMessageMuted: boolean
  onMuteConversation?: () => void
  onUnmuteConversation?: () => void
  onMuteMessage?: () => void
  onUnmuteMessage?: () => void
}

function ReactionMuteDropdown({
  isConversationMuted, isMessageMuted,
  onMuteConversation, onUnmuteConversation,
  onMuteMessage, onUnmuteMessage,
}: ReactionMuteDropdownProps) {
  const { t } = useTranslation()
  const [isOpen, setIsOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const anyMuted = isConversationMuted || isMessageMuted

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false)
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [isOpen])

  return (
    <div ref={dropdownRef} className="relative flex-shrink-0 mt-0.5">
      <button
        onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen) }}
        className={`${isOpen ? 'opacity-100' : 'opacity-0'} group-hover:opacity-100 text-fluux-muted hover:text-fluux-text transition-all`}
        aria-label={t('activityLog.muteReactions')}
      >
        {anyMuted ? <Bell className="w-3.5 h-3.5" /> : <BellOff className="w-3.5 h-3.5" />}
      </button>

      {isOpen && (
        <div className="absolute end-0 top-full mt-1 z-50 bg-fluux-surface border border-fluux-border rounded-md shadow-lg py-1 min-w-[200px]">
          <button
            className="w-full text-start px-3 py-1.5 text-xs text-fluux-text hover:bg-fluux-hover transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              if (isConversationMuted) onUnmuteConversation?.()
              else onMuteConversation?.()
              setIsOpen(false)
            }}
          >
            {isConversationMuted
              ? t('activityLog.unmuteConversationReactions')
              : t('activityLog.muteConversationReactions')}
          </button>
          <button
            className="w-full text-start px-3 py-1.5 text-xs text-fluux-text hover:bg-fluux-hover transition-colors"
            onClick={(e) => {
              e.stopPropagation()
              if (isMessageMuted) onUnmuteMessage?.()
              else onMuteMessage?.()
              setIsOpen(false)
            }}
          >
            {isMessageMuted
              ? t('activityLog.unmuteMessageReactions')
              : t('activityLog.muteMessageReactions')}
          </button>
        </div>
      )}
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
      const conversationName = rp.conversationId.split('@')[0]
      let desc: string
      if (rp.pollTitle) {
        // Poll vote: "nick voted on poll "Title": 1️⃣ in conversation"
        const title = rp.pollTitle.length > 30 ? rp.pollTitle.substring(0, 30) + '…' : rp.pollTitle
        desc = t('activityLog.pollVoteReceived', { name: nameStr, emojis: allEmojis, title })
        desc += t('activityLog.inConversation', { conversation: conversationName })
      } else {
        desc = t('activityLog.reactionReceived', { name: nameStr, emojis: allEmojis })
        if (rp.messagePreview) {
          const preview = rp.messagePreview.length > 40 ? rp.messagePreview.substring(0, 40) + '…' : rp.messagePreview
          desc += t('activityLog.reactionReceivedTo', { preview })
        }
        desc += t('activityLog.inConversation', { conversation: conversationName })
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
