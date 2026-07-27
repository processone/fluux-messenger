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
 * `count`: the canonical unread count (Read-state PR B, Task 12) — the divider is a real
 * numeric surface, not just a positional line. When provided it labels the count (e.g. "2 new
 * messages"), through the same shared `formatUnreadCount` every other unread surface uses.
 * Undefined keeps the generic "New messages" label (the caller — MessageList — only ever omits
 * it when it has no count to report; a defined `count` always drives the counted copy, even at
 * 0, which callers avoid by not rendering the marker at all in that case).
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
