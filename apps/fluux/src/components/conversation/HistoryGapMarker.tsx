import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2 } from 'lucide-react'

/**
 * Displays a marker indicating a gap in message history.
 * Shown when a forward MAM catch-up was incomplete (didn't reach live).
 * Includes a button to continue loading missing messages.
 */
export function HistoryGapMarker({ onLoadMore, isLoading }: { onLoadMore: () => void; isLoading: boolean }) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col items-center gap-2 py-4 px-2">
      <div className="flex items-center gap-3 w-full">
        <div className="flex-1 h-px bg-fluux-hover" />
        <div className="flex items-center gap-2 text-xs text-fluux-muted">
          <AlertTriangle className="w-3.5 h-3.5" />
          <span>{t('chat.historyGap')}</span>
        </div>
        <div className="flex-1 h-px bg-fluux-hover" />
      </div>
      <button
        onClick={onLoadMore}
        disabled={isLoading}
        className={`flex items-center gap-1 px-3 py-1.5 text-xs rounded-full transition-colors ${
          isLoading
            ? 'text-fluux-muted cursor-wait'
            : 'text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover'
        }`}
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <AlertTriangle className="w-4 h-4" />
        )}
        {t('chat.loadMissingMessages')}
      </button>
    </div>
  )
}
