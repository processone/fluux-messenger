/**
 * MessageSelectionBar — floating bar shown while a bulk-copy range is active. Centered at
 * the bottom of the message list (distinct from the end-aligned scroll-to-bottom FAB).
 */
import { useTranslation } from 'react-i18next'
import { Copy } from 'lucide-react'

interface Props {
  count: number
  onCopy: () => void
  onClear: () => void
}

export function MessageSelectionBar({ count, onCopy, onClear }: Props) {
  const { t } = useTranslation()
  if (count <= 0) return null
  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3 py-2 rounded-full bg-fluux-bg border border-fluux-border shadow-lg">
      <span className="text-sm text-fluux-text">{t('chat.selection.count', { num: count })}</span>
      <button
        onClick={onCopy}
        className="flex items-center gap-1 px-2.5 py-1 text-sm rounded-full text-fluux-text hover:bg-fluux-hover transition-colors"
      >
        <Copy className="size-4" />
        {t('chat.selection.copy')}
      </button>
      <button
        onClick={onClear}
        className="px-2.5 py-1 text-sm rounded-full text-fluux-muted hover:text-fluux-text hover:bg-fluux-hover transition-colors"
      >
        {t('chat.selection.done')}
      </button>
    </div>
  )
}
