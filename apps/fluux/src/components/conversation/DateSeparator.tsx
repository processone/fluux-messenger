import { useTranslation } from 'react-i18next'
import { formatDateHeader } from '@/utils/dateFormat'
import { useDayChange } from '@/hooks/useDayChange'

/**
 * The day label's pill, shared with the floating date pill so the floating one reads as this
 * separator lifted off the list. It sits on the chat surface, where the muted label keeps the
 * contrast the theme guarantees for it.
 */
export const DATE_PILL_CLASSES =
  'inline-flex items-center px-3 py-1 rounded-full border border-fluux-border bg-fluux-chat text-xs font-semibold text-fluux-muted whitespace-nowrap'

export interface DateSeparatorProps {
  /** Date string in yyyy-MM-dd format */
  date: string
}

/**
 * Displays a centered date pill between days in conversation views. Centering matches the
 * floating date pill shown while scrolled into history, so both share one horizontal anchor.
 */
export function DateSeparator({ date }: DateSeparatorProps) {
  const { t, i18n } = useTranslation()
  const currentLang = i18n.language.split('-')[0]

  // Re-render when the local day rolls over, so the relative label below does not
  // stay frozen on "Today" / "Yesterday" after midnight.
  useDayChange()

  return (
    // pt-5 + the 26px pill + pb-0.5 keep the row at the 48px the virtualizer estimates for a
    // date row before one has been measured (useRowMetrics FALLBACK_CHROME.date).
    <div className="flex justify-center pt-5 pb-0.5">
      <span className={DATE_PILL_CLASSES}>
        {formatDateHeader(date, t, currentLang)}
      </span>
    </div>
  )
}
