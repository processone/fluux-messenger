import { useTranslation } from 'react-i18next'
import { Download, RefreshCw, CheckCircle, Loader2 } from 'lucide-react'
import { useAutoUpdate } from '@/hooks'

export function UpdatesSettings() {
  const { t } = useTranslation()
  const update = useAutoUpdate()

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.updates')}
      </h3>

      <div className="space-y-3">
        <div className="flex items-center justify-between p-4 rounded-lg border-2 border-fluux-hover bg-fluux-bg">
          <div className="flex items-center gap-3">
            {update.downloaded ? (
              <CheckCircle className="w-5 h-5 text-fluux-green" />
            ) : update.available ? (
              <Download className="w-5 h-5 text-fluux-brand" />
            ) : update.checking ? (
              <Loader2 className="w-5 h-5 text-fluux-muted animate-spin" />
            ) : (
              <CheckCircle className="w-5 h-5 text-fluux-green" />
            )}
            <div>
              <p className="text-sm font-medium text-fluux-text">
                {t('about.version', { version: __APP_VERSION__ })}
              </p>
              <p className="text-xs text-fluux-muted">
                {update.downloaded && t('update.readyToInstall')}
                {update.available && !update.downloading && !update.downloaded && t('update.newVersionAvailable')}
                {update.downloading && t('update.downloading')}
                {update.checking && t('update.checking')}
                {!update.available && !update.checking && !update.downloaded && t('update.upToDate')}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {update.available && (
              <span className="px-2 py-0.5 text-xs font-medium bg-fluux-brand/20 text-fluux-brand rounded-full">
                {update.version}
              </span>
            )}
            {update.downloaded ? (
              <button
                onClick={update.relaunchApp}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-text-on-accent
                           bg-fluux-brand hover:bg-fluux-brand/90 rounded-md transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                {t('update.restart')}
              </button>
            ) : update.available && !update.downloading ? (
              <button
                onClick={update.downloadAndInstall}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-text-on-accent
                           bg-fluux-brand hover:bg-fluux-brand/90 rounded-md transition-colors"
              >
                <Download className="w-4 h-4" />
                {t('update.install')}
              </button>
            ) : update.downloading ? (
              <span className="text-sm text-fluux-muted">
                {Math.round(update.progress)}%
              </span>
            ) : !update.checking ? (
              <button
                onClick={update.checkForUpdate}
                className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-fluux-brand hover:text-fluux-text
                           bg-fluux-brand/10 hover:bg-fluux-brand/20 rounded-md transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                {t('update.checkForUpdates')}
              </button>
            ) : null}
          </div>
        </div>

        {/* Download progress bar */}
        {update.downloading && (
          <div className="h-1.5 bg-fluux-bg rounded-full overflow-hidden">
            <div
              className="h-full bg-fluux-brand transition-all duration-300"
              style={{ width: `${update.progress}%` }}
            />
          </div>
        )}

        {/* Error message */}
        {update.error && (
          <p className="text-xs text-fluux-red">{t(update.error)}</p>
        )}
      </div>
    </section>
  )
}
