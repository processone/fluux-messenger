import { useTranslation } from 'react-i18next'
import { CloudOff } from 'lucide-react'

/**
 * Says that older messages could not be fetched from the server.
 *
 * It sits where the history would have continued, above the button that
 * retries, because a failed archive query is a state of the conversation and
 * not a passing event: a toast would be gone by the time the reader scrolls up
 * and wonders why the thread starts where it does.
 *
 * Distinct from {@link HistoryGapMarker}, which reports a forward catch-up that
 * never reached the live edge and carries its own retry. This one reports the
 * backward query at the top of the list, whose retry is the adjacent
 * "load earlier messages" button.
 *
 * Deliberately quiet. The messages already on screen are intact, so this warns
 * that the view may be incomplete rather than announcing a failure. Mirrors the
 * flanked-rule layout of its sibling markers so it shares their anchor and
 * mirrors correctly under RTL.
 */
export function HistoryUnavailableMarker() {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-3 py-2 px-2 w-full">
      <div className="flex-1 h-px bg-fluux-hover" />
      <div className="flex items-center gap-2 text-xs text-fluux-muted whitespace-nowrap">
        <CloudOff className="size-3.5" />
        <span>{t('chat.historyUnavailable')}</span>
      </div>
      <div className="flex-1 h-px bg-fluux-hover" />
    </div>
  )
}
