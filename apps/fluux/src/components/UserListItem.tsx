import { useEffect, useRef, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { type AdminUser, type LastActivityEntry } from '@fluux/sdk'
import { useAdminStore } from '@fluux/sdk/react'
import { formatRelativeTime, formatDateTime } from '../utils/format'

interface UserListItemProps {
  user: AdminUser
  onSelect: (user: AdminUser) => void
  /** Passed down from AdminView (not via useAdmin here) to avoid per-row list subscriptions. */
  requestLastActivity: (jid: string, lang?: string) => void
}

function UserListItemImpl({ user, onSelect, requestLastActivity }: UserListItemProps) {
  const { t, i18n } = useTranslation()
  // Per-key subscriptions only (never the whole map): render-perf rule.
  const entry = useAdminStore((s) => s.lastActivity.get(user.jid)) as LastActivityEntry | undefined
  const supported = useAdminStore((s) => s.lastActivitySupported)
  const rowRef = useRef<HTMLButtonElement>(null)
  const requested = useRef(false)

  const isOnline = user.isOnline
  const showDot = isOnline !== undefined

  // Fire one lazy last-activity request when the row first becomes visible.
  useEffect(() => {
    if (isOnline === true || !supported || requested.current) return
    const el = rowRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !requested.current) {
          requested.current = true
          requestLastActivity(user.jid, i18n.language)
          observer.disconnect()
        }
      },
      { threshold: 0.1 }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [user.jid, isOnline, supported, requestLastActivity, i18n.language])

  const renderCell = () => {
    if (isOnline === true) {
      return (
        <span className="text-xs text-fluux-green">{t('admin.users.onlineNow')}</span>
      )
    }
    if (!supported) return null
    if (!entry || entry.state === 'loading') {
      return (
        <span className="inline-block h-3 w-12 rounded bg-fluux-hover animate-pulse" aria-hidden="true" />
      )
    }
    if (entry.seconds == null) {
      if (entry.raw) {
        return (
          <span className="text-xs text-fluux-muted truncate max-w-[8rem]" title={entry.raw}>
            {entry.raw}
          </span>
        )
      }
      return null
    }
    const absolute = formatDateTime(Date.now() - entry.seconds * 1000)
    return (
      <span className="text-xs text-fluux-muted" title={absolute}>
        {formatRelativeTime(entry.seconds, i18n.language, t('admin.users.justNow'))}
      </span>
    )
  }

  return (
    <button
      ref={rowRef}
      onClick={() => onSelect(user)}
      className="w-full flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-fluux-hover
                 transition-colors text-start"
    >
      {showDot && (
        <span
          className={`size-2 rounded-full shrink-0 ${isOnline ? 'bg-fluux-green' : 'bg-fluux-muted'}`}
          aria-label={isOnline ? t('admin.users.online') : t('admin.users.offline')}
        />
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm text-fluux-text truncate">{user.jid}</p>
      </div>
      <div className="shrink-0">{renderCell()}</div>
    </button>
  )
}

export const UserListItem = memo(UserListItemImpl)
