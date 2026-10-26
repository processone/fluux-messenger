import { useTranslation } from 'react-i18next'
import { RefreshCw } from 'lucide-react'
import { useConnectionStore } from '@fluux/sdk/react'
import type { ConnectionState } from '@fluux/sdk/stores'
import { useEffect, useRef, type ReactNode } from 'react'
import { Tooltip } from './Tooltip'

type Scope = keyof ConnectionState['updates']

/** Observe announcements, not the owner's historical snapshot at mount. */
function UpdateAnnouncement({ update, target }: {
  update: ConnectionState['updates'][Scope]
  target: string
}) {
  const { t } = useTranslation()
  const startedAt = update?.startedAt
  const announcement = update?.announcement
  const observed = useRef({ startedAt, announcement, message: '' })
  const previous = observed.current
  let message = previous.message
  if (startedAt !== previous.startedAt || announcement !== previous.announcement) {
    const endedObservedWork = announcement === 'ended'
      && startedAt === previous.startedAt && previous.announcement === 'started'
    message = announcement === 'started' || endedObservedWork
      ? t(announcement === 'started' ? 'status.retrievingFor' : 'status.retrievalEndedFor', { target })
      : ''
  }
  useEffect(() => {
    observed.current = { startedAt, announcement, message }
  }, [startedAt, announcement, message])
  return <span role="status" data-testid="update-announcement" className="sr-only">{message}</span>
}

/** Read-only projection of the SDK owner's phase. No view owns update time or state. */
export function UpdateStatus({ scope, target, list = false, children }: {
  scope?: Scope
  target: string
  list?: boolean
  children: ReactNode
}) {
  const { t, i18n } = useTranslation()
  const update = useConnectionStore(s => scope ? s.updates?.[scope] : undefined)
  const healthy = useConnectionStore(s => s.status === 'online' && !s.isVerifying)
  const visible = healthy && update && (update.phase === 'brief' || update.phase === 'icon')
  const text = visible && !list && update.phase === 'brief'
  const explanation = t('status.retrievingFor', { target })
  return (
    <div className={`flex min-w-0 items-center gap-1 ${list ? '' : 'text-xs text-fluux-muted'}`}>
      <div className="min-w-0 truncate" data-testid={text ? 'update-text' : undefined}>
        {text ? t('status.retrievingMessages') : children}
      </div>
      {visible && !text && (
        <Tooltip content={explanation} position="bottom" showOnMobile triggerMode="click" className="inline-flex shrink-0 rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-fluux-brand">
          <span title={explanation} className="inline-flex text-fluux-muted" data-testid="update-icon">
            <RefreshCw className="size-3" aria-hidden="true" />
            <span className="sr-only">{explanation}</span>
          </span>
        </Tooltip>
      )}
      <UpdateAnnouncement
        key={JSON.stringify([scope, healthy, target, i18n?.resolvedLanguage])}
        update={healthy ? update : undefined}
        target={target}
      />
    </div>
  )
}
