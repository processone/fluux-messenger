/**
 * PollClosedCard — Displays frozen poll results when a poll is closed by its creator.
 *
 * Each option gets a consistent color derived from its emoji (since closed polls
 * don't carry option labels, the emoji is used as the color seed).
 * The title links to the original poll message for context.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, Lock } from 'lucide-react'
import { generateConsistentColorHexSync, type PollClosedData } from '@fluux/sdk'
import { scrollToMessage } from './messageGrouping'

export interface PollClosedCardProps {
  pollClosed: PollClosedData
  closedAt?: Date
}

function getResultColor(label: string, emoji: string): string {
  return generateConsistentColorHexSync(label || emoji, { saturation: 80, lightness: 50 })
}

export function PollClosedCard({ pollClosed, closedAt }: PollClosedCardProps) {
  const { t } = useTranslation()

  const totalVotes = useMemo(
    () => pollClosed.results.reduce((sum, r) => sum + r.count, 0),
    [pollClosed.results]
  )

  const resultColors = useMemo(
    () => pollClosed.results.map((r) => getResultColor(r.label, r.emoji)),
    [pollClosed.results],
  )

  // Find the winning option(s) — highest count
  const maxCount = useMemo(
    () => Math.max(0, ...pollClosed.results.map((r) => r.count)),
    [pollClosed.results],
  )

  return (
    <div className="mt-1 rounded-lg border border-fluux-border bg-fluux-surface p-3 flex flex-col gap-2">
      {/* Header — title links to the original poll message */}
      <div className="flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-fluux-muted flex-shrink-0" />
        <button
          onClick={() => scrollToMessage(pollClosed.pollMessageId)}
          className="font-medium text-fluux-text text-sm hover:text-fluux-brand transition-colors text-start truncate"
          title={t('poll.scrollToOriginal', 'Scroll to original poll')}
        >
          {pollClosed.title}
        </button>
        <Lock className="w-3.5 h-3.5 text-fluux-muted flex-shrink-0" />
      </div>

      {/* Optional description */}
      {pollClosed.description && (
        <span className="text-xs text-fluux-muted">{pollClosed.description}</span>
      )}

      <span className="text-xs text-fluux-muted">
        {t('poll.closed', 'Poll closed')}
        {closedAt && (
          <> — {closedAt.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</>
        )}
      </span>

      {/* Frozen results with colored bars */}
      <div className="flex flex-col gap-1.5">
        {pollClosed.results.map((result, index) => {
          const percentage = totalVotes > 0 ? Math.round((result.count / totalVotes) * 100) : 0
          const isWinner = result.count === maxCount && maxCount > 0
          return (
            <div
              key={result.emoji}
              className="relative flex items-center gap-2 px-3 py-2 rounded-md border border-fluux-border"
            >
              {/* Colored progress bar */}
              {totalVotes > 0 && (
                <div
                  className="absolute inset-0 rounded-md transition-all"
                  style={{
                    width: `${percentage}%`,
                    backgroundColor: resultColors[index],
                    opacity: isWinner ? 0.25 : 0.15,
                  }}
                />
              )}
              <div className="relative flex items-center gap-2 w-full">
                <span className="text-sm flex-shrink-0">{result.emoji}</span>
                {result.label && (
                  <span className={`text-sm truncate ${isWinner ? 'font-medium text-fluux-text' : 'text-fluux-muted'}`}>
                    {result.label}
                  </span>
                )}
                <span className={`text-sm ${isWinner ? 'font-medium text-fluux-text' : 'text-fluux-muted'}`}>
                  {percentage}%
                </span>
                <span className="text-xs text-fluux-muted ms-auto flex-shrink-0">({result.count})</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Total */}
      <div className="text-xs text-fluux-muted pt-0.5">
        {t('poll.totalVotes', '{{count}} vote(s)', { count: totalVotes })}
      </div>
    </div>
  )
}
