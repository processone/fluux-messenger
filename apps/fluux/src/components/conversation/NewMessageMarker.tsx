import { useTranslation } from 'react-i18next'

/**
 * Displays an accent horizontal line with "New Messages" label.
 * Used to indicate where unread messages begin in the conversation.
 */
export function NewMessageMarker() {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-4 h-12">
      <div className="flex-1 h-px" style={{ backgroundColor: 'var(--fluux-text-self)' }} />
      <span className="text-xs font-semibold" style={{ color: 'var(--fluux-text-self)' }}>
        {t('chat.newMessages')}
      </span>
      <div className="flex-1 h-px" style={{ backgroundColor: 'var(--fluux-text-self)' }} />
    </div>
  )
}
