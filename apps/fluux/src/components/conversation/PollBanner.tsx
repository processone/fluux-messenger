/**
 * PollBanner — Sticky banner shown above the message list when there are
 * unanswered polls (polls the user hasn't voted on yet).
 *
 * Clicking the banner scrolls to the most recent unanswered poll.
 * The dismiss button hides the banner for that poll (persisted to localStorage).
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, X, ChevronDown } from 'lucide-react'
import { hasVotedOnPoll, isPollExpired, type RoomMessage } from '@fluux/sdk'
import { scrollToMessage } from './messageGrouping'

export interface PollBannerProps {
  /** All messages in the room */
  messages: RoomMessage[]
  /** The user's nickname in the room (used to check reactions) */
  myNick: string | undefined
  /** Set of poll message IDs the user has locally voted on (persisted safety net) */
  votedPollIds: Set<string>
  /** Set of poll message IDs the user has dismissed (persisted) */
  dismissedPollIds: Set<string>
  /** Callback to dismiss a poll from the banner */
  onDismiss: (messageId: string) => void
}

export function PollBanner({ messages, myNick, votedPollIds, dismissedPollIds, onDismiss }: PollBannerProps) {
  const { t } = useTranslation()

  // Build the set of poll message IDs that have been closed
  const closedPollIds = useMemo(() => {
    const ids = new Set<string>()
    for (const msg of messages) {
      if (msg.pollClosed?.pollMessageId) {
        ids.add(msg.pollClosed.pollMessageId)
      }
    }
    return ids
  }, [messages])

  // Find unanswered, non-expired, non-dismissed, non-closed polls (most recent first)
  const unansweredPolls = useMemo(() => {
    if (!myNick) return []
    const polls: RoomMessage[] = []
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (
        msg.poll &&
        !msg.isRetracted &&
        !isPollExpired(msg.poll) &&
        !closedPollIds.has(msg.id) &&
        !hasVotedOnPoll(msg.poll, msg.reactions, myNick) &&
        !votedPollIds.has(msg.id) &&
        !dismissedPollIds.has(msg.id)
      ) {
        polls.push(msg)
      }
    }
    return polls
  }, [messages, myNick, votedPollIds, dismissedPollIds, closedPollIds])

  if (unansweredPolls.length === 0) return null

  const latestPoll = unansweredPolls[0]
  const count = unansweredPolls.length

  return (
    <div className="mx-2 mb-1 flex items-center gap-2 rounded-lg border border-fluux-brand/30 bg-fluux-brand/5 px-3 py-2 text-sm">
      <BarChart3 className="w-4 h-4 text-fluux-brand flex-shrink-0" />

      <button
        onClick={() => scrollToMessage(latestPoll.id)}
        className="flex-1 min-w-0 text-start text-fluux-text hover:text-fluux-brand transition-colors truncate"
      >
        {count === 1
          ? t('poll.bannerSingle', '📊 {{title}} — tap to vote', { title: latestPoll.poll!.title })
          : t('poll.bannerMultiple', '📊 {{count}} unanswered polls — tap to see latest', { count })
        }
      </button>

      <ChevronDown className="w-4 h-4 text-fluux-muted flex-shrink-0" />

      <button
        onClick={(e) => {
          e.stopPropagation()
          onDismiss(latestPoll.id)
        }}
        className="p-0.5 text-fluux-muted hover:text-fluux-text transition-colors flex-shrink-0"
        aria-label={t('poll.dismissBanner', 'Dismiss')}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
