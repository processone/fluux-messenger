import { CalendarDays } from 'lucide-react'
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

/** The interaction target surrounds a compact pill and grows to 44px on touch. */
export const DATE_PILL_BUTTON_CLASSES = 'group inline-flex items-center justify-center rounded-full cursor-pointer tap-target focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fluux-brand'

/** A date pill: a button opening jump to date at its day when `onSelect` is given, plain text otherwise. */
export function DatePill({ date, label, className = '', onSelect, tabIndex }: {
  date: string
  label: string
  className?: string
  onSelect?: (date: string) => void
  tabIndex?: number
}) {
  const { t } = useTranslation()
  if (!onSelect) return <span className={`${DATE_PILL_CLASSES} ${className}`}>{label}</span>
  return (
    <button
      type="button"
      data-date-pill
      onClick={(event) => { event.currentTarget.focus({ preventScroll: true }); onSelect(date) }}
      onKeyDown={(event) => {
        // Enter must not select a message, and Space must not trigger type-to-focus.
        if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
      }}
      tabIndex={tabIndex}
      aria-haspopup="dialog"
      aria-label={t('chat.jumpToDate.fromPill', { date: label })}
      className={DATE_PILL_BUTTON_CLASSES}
    >
      <span className={`${DATE_PILL_CLASSES} gap-1.5 transition-colors group-hover:text-fluux-text group-hover:border-fluux-muted group-active:bg-fluux-hover ${className}`}>
        <CalendarDays aria-hidden="true" className="size-3 shrink-0" />
        {label}
      </span>
    </button>
  )
}

export interface DateSeparatorProps {
  /** Date string in yyyy-MM-dd format */
  date: string
  /** Opens jump to date at this day. */
  onSelect?: (date: string) => void
}

/**
 * Displays a centered date pill between days in conversation views. Centering matches the
 * floating date pill shown while scrolled into history, so both share one horizontal anchor.
 */
export function DateSeparator({ date, onSelect }: DateSeparatorProps) {
  const { t, i18n } = useTranslation()
  const currentLang = i18n.language.split('-')[0]

  // Re-render when the local day rolls over, so the relative label below does not
  // stay frozen on "Today" / "Yesterday" after midnight.
  useDayChange()

  return (
    // pt-5 + the 26px pill + pb-0.5 keep the row at the 48px the virtualizer estimates for a
    // date row before one has been measured (useRowMetrics FALLBACK_CHROME.date).
    // On touch, index.css uses 2px above and below the 44px target for the same row height.
    <div className="date-separator flex justify-center pt-5 pb-0.5">
      <DatePill date={date} label={formatDateHeader(date, t, currentLang)} onSelect={onSelect} />
    </div>
  )
}
