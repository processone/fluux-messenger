/**
 * PollCheckpointCard — Displays a snapshot of poll results sent by the poll creator
 * without closing the poll. Compact version of PollClosedCard.
 */
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { BarChart3, Flag } from 'lucide-react'
import { generateConsistentColorHexSync, type PollCheckpointData } from '@fluux/sdk'
import { scrollToMessage } from './messageGrouping'

export interface PollCheckpointCardProps {
  pollCheckpoint: PollCheckpointData
}

function getResultColor(label: string, emoji: string): string {
  return generateConsistentColorHexSync(label || emoji, { saturation: 80, lightness: 50 })
}

export function PollCheckpointCard({ pollCheckpoint }: PollCheckpointCardProps) {
  const { t } = useTranslation()

  const totalVotes = useMemo(
    () => pollCheckpoint.results.reduce((sum, r) => sum + r.count, 0),
    [pollCheckpoint.results]
  )

  const resultColors = useMemo(
    () => pollCheckpoint.results.map((r) => getResultColor(r.label, r.emoji)),
    [pollCheckpoint.results],
  )

  const maxCount = useMemo(
    () => Math.max(0, ...pollCheckpoint.results.map((r) => r.count)),
    [pollCheckpoint.results],
  )

  return (
    <div className="mt-1 rounded-lg border border-fluux-border bg-fluux-surface p-3 flex flex-col gap-2">
      {/* Header — title links to the original poll message */}
      <div className="flex items-center gap-2">
        <BarChart3 className="w-4 h-4 text-fluux-muted flex-shrink-0" />
        <button
          onClick={() => scrollToMessage(pollCheckpoint.pollMessageId)}
          className="font-medium text-fluux-text text-sm hover:text-fluux-brand transition-colors text-left truncate"
          title={t('poll.scrollToOriginal', 'Scroll to original poll')}
        >
          {pollCheckpoint.title}
        </button>
        <Flag className="w-3.5 h-3.5 text-fluux-muted flex-shrink-0" />
      </div>

      <span className="text-xs text-fluux-muted">{t('poll.checkpoint', 'Checkpoint')}</span>

      {/* Snapshot results with colored bars */}
      <div className="flex flex-col gap-1.5">
        {pollCheckpoint.results.map((result, index) => {
          const percentage = totalVotes > 0 ? Math.round((result.count / totalVotes) * 100) : 0
          const isWinner = result.count === maxCount && maxCount > 0
          return (
            <div
              key={result.emoji}
              className="relative flex items-center gap-2 px-3 py-1.5 rounded-md border border-fluux-border"
            >
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
                <span className="text-xs text-fluux-muted ml-auto flex-shrink-0">({result.count})</span>
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
