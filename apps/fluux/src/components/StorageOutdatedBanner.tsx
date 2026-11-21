import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { RefreshCw, X } from 'lucide-react'
import { useXMPP } from '@fluux/sdk'

type BannerState = 'hidden' | 'shown' | 'dismissed'

/**
 * Asks the user to reload after a newer Fluux, usually in another tab,
 * upgraded the local cache. This tab keeps working without that cache, so
 * the banner can be dismissed for the rest of the session.
 */
export function StorageOutdatedBanner() {
  const { t } = useTranslation()
  const { client } = useXMPP()
  const [state, setState] = useState<BannerState>('hidden')

  useEffect(() => client.subscribe('storage:outdated', () => {
    setState((current) => (current === 'hidden' ? 'shown' : current))
  }), [client])

  if (state !== 'shown') return null

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-[9000] flex justify-center px-4"
      style={{ top: 'calc(var(--fluux-window-titlebar-height, 0px) + 0.75rem)' }}
    >
      <div
        role="status"
        className="fluux-popover pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-lg p-3"
      >
        <RefreshCw className="mt-0.5 size-4 shrink-0 text-fluux-muted" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fluux-text">{t('storageOutdated.title')}</p>
          <p className="mt-0.5 text-xs text-fluux-muted">{t('storageOutdated.description')}</p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="shrink-0 rounded-md bg-fluux-brand px-3 py-1.5 text-xs font-medium text-fluux-text-on-accent hover:bg-fluux-brand/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-fluux-brand"
        >
          {t('storageOutdated.reload')}
        </button>
        <button
          type="button"
          onClick={() => setState('dismissed')}
          aria-label={t('common.dismiss')}
          className="shrink-0 rounded-md p-1 text-fluux-muted hover:bg-fluux-hover hover:text-fluux-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-fluux-brand"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}
