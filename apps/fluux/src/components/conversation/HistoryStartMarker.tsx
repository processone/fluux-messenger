import { useTranslation } from 'react-i18next'
import { Clock } from 'lucide-react'

/**
 * Displays a marker indicating the beginning of conversation history.
 * Shown when all server-side message history has been loaded (MAM complete).
 */
export function HistoryStartMarker() {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-3 py-4 px-2">
      <div className="flex-1 h-px bg-fluux-hover" />
      <div className="flex items-center gap-2 text-xs text-fluux-muted">
        <Clock className="size-3.5" />
        <span>{t('chat.historyStart')}</span>
      </div>
      <div className="flex-1 h-px bg-fluux-hover" />
    </div>
  )
}
