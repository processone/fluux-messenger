import { useTranslation } from 'react-i18next'
import { formatDateHeader } from '@/utils/dateFormat'

export interface DateSeparatorProps {
  /** Date string in yyyy-MM-dd format */
  date: string
}

/**
 * Displays a leading-aligned date label followed by a horizontal rule.
 * Used to separate messages by day in conversation views.
 *
 * Layout leans on flex flow + logical properties so it mirrors correctly
 * under RTL: the label always sits on the reading-start edge and the rule
 * extends toward the trailing edge.
 */
export function DateSeparator({ date }: DateSeparatorProps) {
  const { t, i18n } = useTranslation()
  const currentLang = i18n.language.split('-')[0]

  return (
    <div className="flex items-center gap-3 h-12">
      <span className="text-xs font-semibold text-fluux-muted whitespace-nowrap">
        {formatDateHeader(date, t, currentLang)}
      </span>
      <div className="flex-1 h-px bg-fluux-hover" />
    </div>
  )
}
