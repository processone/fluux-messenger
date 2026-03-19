/**
 * PollClosedCard — Displays frozen poll results when a poll is closed by its creator.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, Lock } from 'lucide-react'
import type { PollClosedData } from '@fluux/sdk'

export interface PollClosedCardProps {
  pollClosed: PollClosedData
}

export function PollClosedCard({ pollClosed }: PollClosedCardProps) {
  const { t } = useTranslation()

  const totalVotes = useMemo(
    () => pollClosed.results.reduce((sum, r) => sum + r.count, 0),
    [pollClosed.results]
  )

  return (
    <div className="mt-1 rounded-lg border border-fluux-border bg-fluux-surface p-3 flex flex-col gap-2">
      {/* Header */}
      <div className="flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-fluux-muted flex-shrink-0" />
        <span className="font-medium text-fluux-text text-sm">{pollClosed.title}</span>
        <Lock className="w-3.5 h-3.5 text-fluux-muted flex-shrink-0" />
      </div>

      {/* Optional description */}
      {pollClosed.description && (
        <span className="text-xs text-fluux-muted">{pollClosed.description}</span>
      )}

      <span className="text-xs text-fluux-muted">{t('poll.closed', 'Poll closed')}</span>

      {/* Frozen results */}
      <div className="flex flex-col gap-1.5">
        {pollClosed.results.map((result) => {
          const percentage = totalVotes > 0 ? Math.round((result.count / totalVotes) * 100) : 0
          return (
            <div
              key={result.emoji}
              className="relative flex items-center gap-2 px-3 py-2 rounded-md border border-fluux-border bg-fluux-bg"
            >
              {/* Progress bar */}
              {totalVotes > 0 && (
                <div
                  className="absolute inset-0 rounded-md bg-fluux-hover/50"
                  style={{ width: `${percentage}%` }}
                />
              )}
              <div className="relative flex items-center gap-2 w-full">
                <span className="text-sm flex-shrink-0">{result.emoji}</span>
                <span className="text-sm text-fluux-text flex-1">{percentage}%</span>
                <span className="text-xs text-fluux-muted">({result.count})</span>
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
