/**
 * PollCard — Renders a poll within a message bubble.
 *
 * Shows the title, options with colored progress bars and vote counts,
 * and allows voting by clicking options.
 *
 * Each option gets a consistent color derived from its label text
 * (using XEP-0392 consistent color generation), making polls visually
 * distinctive and easy to read at a glance.
 *
 * When `hideResultsBeforeVote` is enabled, results (progress bars,
 * percentages, counts) are hidden until the user has cast a vote.
 */
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, BarChart3, Clock, Square } from 'lucide-react'
import { tallyPollResults, getTotalVoters, isPollExpired, generateConsistentColorHexSync, type PollData, type PollTally } from '@fluux/sdk'

export interface PollCardProps {
  poll: PollData
  reactions: Record<string, string[]>
  myReactions: string[]
  onVote?: (emoji: string) => void
  onClosePoll?: () => Promise<string | null>
  isClosed?: boolean
  getReactorName: (reactor: string) => string
}

/**
 * Generate a consistent bar color from an option label.
 * Uses XEP-0392 with moderate saturation for a pleasant, distinct look.
 */
function getOptionColor(label: string): string {
  return generateConsistentColorHexSync(label, { saturation: 80, lightness: 50 })
}

export function PollCard({ poll, reactions, myReactions, onVote, onClosePoll, isClosed, getReactorName }: PollCardProps) {
  const { t } = useTranslation()
  const [closing, setClosing] = useState(false)

  const tally = useMemo(() => tallyPollResults(poll, reactions), [poll, reactions])
  const totalVoters = useMemo(() => getTotalVoters(poll, reactions), [poll, reactions])

  // Pre-compute consistent colors for each option
  const optionColors = useMemo(
    () => poll.options.map((opt) => getOptionColor(opt.label)),
    [poll.options],
  )

  const myVotedEmojis = useMemo(() => {
    const pollEmojis = new Set(poll.options.map((o) => o.emoji))
    return new Set(myReactions.filter((e) => pollEmojis.has(e)))
  }, [poll.options, myReactions])

  const hasVoted = myVotedEmojis.size > 0
  const expired = useMemo(() => isPollExpired(poll), [poll])

  // When hideResultsBeforeVote is enabled and the user hasn't voted yet,
  // suppress all result indicators (progress bars, percentages, counts)
  const showResults = !poll.settings.hideResultsBeforeVote || hasVoted

  // Disable voting when expired or closed (onVote becomes undefined)
  const effectiveOnVote = (expired || isClosed) ? undefined : onVote

  return (
    <div className="mt-1 rounded-lg border border-fluux-border bg-fluux-surface p-3 flex flex-col gap-2">
      {/* Title header */}
      <div className="flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-fluux-brand flex-shrink-0" />
        <span className="font-medium text-fluux-text text-sm">{poll.title}</span>
      </div>

      {/* Optional description */}
      {poll.description && (
        <span className="text-xs text-fluux-muted">{poll.description}</span>
      )}

      {/* Voting mode indicator */}
      {poll.settings.allowMultiple && (
        <span className="text-xs text-fluux-muted">{t('poll.multipleAllowed', 'Select multiple options')}</span>
      )}

      {/* Options */}
      <div className="flex flex-col gap-1.5">
        {tally.map((option, index) => (
          <PollOption
            key={option.emoji}
            option={option}
            color={optionColors[index]}
            totalVoters={totalVoters}
            isMyVote={myVotedEmojis.has(option.emoji)}
            hasVoted={hasVoted}
            showResults={showResults}
            allowMultiple={poll.settings.allowMultiple}
            onVote={effectiveOnVote}
            getReactorName={getReactorName}
          />
        ))}
      </div>

      {/* Footer: total votes + deadline + hints + close */}
      <div className="flex items-center justify-between pt-0.5">
        <span className="text-xs text-fluux-muted">
          {isClosed
            ? t('poll.closed', 'Poll closed')
            : expired
              ? t('poll.expired', 'Poll ended')
              : !showResults
                ? t('poll.voteToSeeResults', 'Vote to see results')
                : totalVoters === 0
                  ? t('poll.noVotes', 'No votes yet')
                  : t('poll.totalVotes', '{{count}} vote(s)', { count: totalVoters })}
        </span>
        <div className="flex items-center gap-2">
          {poll.deadline && !expired && !isClosed && (
            <span className="flex items-center gap-1 text-xs text-fluux-muted">
              <Clock className="w-3 h-3" />
              {t('poll.deadlineDisplay', 'Ends {{date}}', {
                date: new Date(poll.deadline).toLocaleString(undefined, {
                  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                }),
              })}
            </span>
          )}
          {hasVoted && !poll.settings.allowMultiple && effectiveOnVote && (
            <span className="text-xs text-fluux-muted italic">
              {t('poll.tapToChange', 'Tap to change vote')}
            </span>
          )}
          {onClosePoll && !expired && !isClosed && (
            <button
              onClick={async () => {
                setClosing(true)
                try {
                  await onClosePoll()
                } finally {
                  setClosing(false)
                }
              }}
              disabled={closing}
              className="flex items-center gap-1 text-xs text-fluux-muted hover:text-fluux-text transition-colors disabled:opacity-50"
            >
              <Square className="w-3 h-3" />
              {t('poll.close', 'Close poll')}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

interface PollOptionProps {
  option: PollTally
  color: string
  totalVoters: number
  isMyVote: boolean
  hasVoted: boolean
  showResults: boolean
  allowMultiple: boolean
  onVote?: (emoji: string) => void
  getReactorName: (reactor: string) => string
}

function PollOption({ option, color, totalVoters, isMyVote, hasVoted, showResults, allowMultiple, onVote, getReactorName }: PollOptionProps) {
  const percentage = totalVoters > 0 ? Math.round((option.count / totalVoters) * 100) : 0

  const voterNames = useMemo(() => {
    if (option.voters.length === 0) return ''
    return option.voters.map(getReactorName).join(', ')
  }, [option.voters, getReactorName])

  // In single-vote mode after voting: show results but still allow changing vote
  // Visual cue: non-voted options are subtler to indicate "results mode"
  const isSingleVoteResultMode = hasVoted && !allowMultiple

  // Bar opacity: stronger for user's vote, softer for others
  const barOpacity = isMyVote ? 0.25 : 0.15

  return (
    <button
      onClick={onVote ? () => onVote(option.emoji) : undefined}
      disabled={!onVote}
      className={`
        relative flex items-center gap-2 px-3 py-2 rounded-md border text-start transition-colors
        ${isMyVote
          ? 'border-fluux-brand'
          : isSingleVoteResultMode
            ? 'border-fluux-border hover:border-fluux-muted'
            : 'border-fluux-border hover:bg-fluux-hover'
        }
        ${onVote ? 'cursor-pointer' : 'cursor-default'}
      `}
      title={showResults ? (voterNames || undefined) : undefined}
    >
      {/* Colored progress bar — only when results are visible */}
      {showResults && hasVoted && totalVoters > 0 && (
        <div
          className="absolute inset-0 rounded-md transition-all"
          style={{
            width: `${percentage}%`,
            backgroundColor: color,
            opacity: barOpacity,
          }}
        />
      )}

      {/* Content (above progress bar) */}
      <div className="relative flex items-center gap-2 w-full">
        {/* Emoji */}
        <span className="text-sm flex-shrink-0">{option.emoji}</span>

        {/* Label */}
        <span className={`text-sm flex-1 truncate ${
          isSingleVoteResultMode && !isMyVote ? 'text-fluux-muted' : 'text-fluux-text'
        }`}>{option.label}</span>

        {/* Vote count + check — only when results are visible */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {showResults && hasVoted && (
            <span className="text-xs font-medium text-fluux-muted">
              {percentage}%
            </span>
          )}
          {showResults && option.count > 0 && (
            <span className="text-xs text-fluux-muted">
              ({option.count})
            </span>
          )}
          {isMyVote && (
            <Check className="w-3.5 h-3.5 text-fluux-brand" />
          )}
        </div>
      </div>
    </button>
  )
}
