import { useTranslation } from 'react-i18next'

/**
 * Displays a red horizontal line with "New Messages" label.
 * Used to indicate where unread messages begin in the conversation.
 */
export function NewMessageMarker() {
  const { t } = useTranslation()

  return (
    <div className="flex items-center gap-4 h-12">
      <div className="flex-1 h-px bg-fluux-red" />
      <span className="text-xs font-semibold text-fluux-error">
        {t('chat.newMessages')}
      </span>
      <div className="flex-1 h-px bg-fluux-red" />
    </div>
  )
}
