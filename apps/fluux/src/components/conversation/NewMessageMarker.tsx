import { useTranslation } from 'react-i18next'

/**
 * Displays an accent horizontal line with "New Messages" label.
 * Used to indicate where unread messages begin in the conversation.
 *
 * `provisional`: the position was derived from the local read pointer while a
 * synced XEP-0490 read position is still unresolved — it may move or vanish
 * once the marker resolves, so it renders muted instead of the accent color.
 */
export function NewMessageMarker({ provisional = false }: { provisional?: boolean }) {
  const { t } = useTranslation()
  const color = provisional ? 'var(--fluux-text-muted)' : 'var(--fluux-text-self)'

  return (
    <div
      className="flex items-center gap-4 h-12"
      data-new-message-marker
      {...(provisional ? { 'data-provisional': 'true' } : {})}
    >
      <div className="flex-1 h-px" style={{ backgroundColor: color }} />
      <span className="text-xs font-semibold" style={{ color }}>
        {t('chat.newMessages')}
      </span>
      <div className="flex-1 h-px" style={{ backgroundColor: color }} />
    </div>
  )
}
