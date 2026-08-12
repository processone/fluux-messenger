import { useTranslation } from 'react-i18next'
import { formatUnreadCount } from '@/utils/formatUnreadCount'

/**
 * Displays an accent horizontal line with "New Messages" label.
 * Used to indicate where unread messages begin in the conversation.
 *
 * `provisional`: the position was derived from the local read pointer while a
 * synced XEP-0490 read position is still unresolved — it may move or vanish
 * once the marker resolves, so it renders muted instead of the accent color.
 *
 * `count`: the canonical unread count — the divider is a real
 * numeric surface, not just a positional line. When provided it labels the count (e.g. "2 new
 * messages"), through the same shared `formatUnreadCount` every other unread surface uses.
 * Undefined keeps the generic "New messages" label. MessageList deliberately uses that fallback
 * when the canonical count reaches 0 but the active visit's parked divider remains visible until
 * an explicit read-through / mark-read / deactivation path clears it.
 */
export function NewMessageMarker({ provisional = false, count }: { provisional?: boolean; count?: number }) {
  const { t } = useTranslation()
  const color = provisional ? 'var(--fluux-text-muted)' : 'var(--fluux-text-self)'
  const label =
    count === undefined
      ? t('chat.newMessages')
      : t('chat.newMessagesCount', { count, displayCount: formatUnreadCount(count) })

  return (
    <div
      className="flex items-center gap-4 h-12"
      data-new-message-marker
      {...(provisional ? { 'data-provisional': 'true' } : {})}
    >
      <div className="flex-1 h-px" style={{ backgroundColor: color }} />
      <span className="text-xs font-semibold" style={{ color }}>
        {label}
      </span>
      <div className="flex-1 h-px" style={{ backgroundColor: color }} />
    </div>
  )
}
