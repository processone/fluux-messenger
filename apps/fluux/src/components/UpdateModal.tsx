import { useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Download, RefreshCw, CheckCircle, AlertCircle } from 'lucide-react'
import { Tooltip } from './Tooltip'
import type { UpdateState } from '@/hooks'

interface UpdateModalProps {
  state: UpdateState
  onDownload: () => void
  onRelaunch: () => void
  onDismiss: () => void
}

export function UpdateModal({ state, onDownload, onRelaunch, onDismiss }: UpdateModalProps) {
  const { t } = useTranslation()
  const modalRef = useRef<HTMLDivElement>(null)

  // Close on escape key (only if not downloading)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !state.downloading) onDismiss()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onDismiss, state.downloading])

  // Close when clicking backdrop (only if not downloading)
  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget && !state.downloading) onDismiss()
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={handleBackdropClick}
    >
      <div
        ref={modalRef}
        className="bg-fluux-sidebar rounded-lg shadow-xl border border-fluux-hover w-96 overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-fluux-hover">
          <h2 className="text-lg font-semibold text-fluux-text">{t('update.title')}</h2>
          {!state.downloading && (
            <Tooltip content={t('common.close')}>
              <button
                onClick={onDismiss}
                className="p-1 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover"
              >
                <X className="w-4 h-4" />
              </button>
            </Tooltip>
          )}
        </div>

        {/* Content */}
        <div className="p-6">
          {/* Version info */}
          <div className="text-center mb-4">
            <div className="w-12 h-12 mx-auto mb-3 rounded-full bg-fluux-brand/10 flex items-center justify-center">
              {state.downloaded ? (
                <CheckCircle className="w-6 h-6 text-fluux-green" />
              ) : state.error ? (
                <AlertCircle className="w-6 h-6 text-fluux-red" />
              ) : (
                <Download className="w-6 h-6 text-fluux-brand" />
              )}
            </div>
            <h3 className="text-lg font-semibold text-fluux-text mb-1">
              {state.downloaded
                ? t('update.readyToInstall')
                : t('update.newVersionAvailable')}
            </h3>
            {state.version && (
              <p className="text-fluux-muted text-sm">
                {t('update.version', { version: state.version })}
              </p>
            )}
          </div>

          {/* Release notes */}
          {state.releaseNotes && !state.downloading && !state.downloaded && (
            <div className="mb-4 max-h-32 overflow-y-auto rounded bg-fluux-bg p-3">
              <p className="text-sm text-fluux-text whitespace-pre-wrap">
                {state.releaseNotes}
              </p>
            </div>
          )}

          {/* Progress bar */}
          {state.downloading && (
            <div className="mb-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-fluux-muted">{t('update.downloading')}</span>
                <span className="text-sm text-fluux-muted">{Math.round(state.progress)}%</span>
              </div>
              <div className="h-2 bg-fluux-bg rounded-full overflow-hidden">
                <div
                  className="h-full bg-fluux-brand transition-all duration-300"
                  style={{ width: `${state.progress}%` }}
                />
              </div>
            </div>
          )}

          {/* Error message */}
          {state.error && (
            <div className="mb-4 p-3 rounded bg-fluux-red/10 border border-fluux-red/20">
              <p className="text-sm text-fluux-red">{state.error}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            {state.downloaded ? (
              <button
                onClick={onRelaunch}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-fluux-brand text-fluux-text-on-accent rounded-lg hover:bg-fluux-brand/90 transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                {t('update.restartNow')}
              </button>
            ) : state.downloading ? (
              <button
                disabled
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-fluux-muted/20 text-fluux-muted rounded-lg cursor-not-allowed"
              >
                <Download className="w-4 h-4 animate-bounce" />
                {t('update.downloading')}
              </button>
            ) : (
              <>
                <button
                  onClick={onDismiss}
                  className="flex-1 px-4 py-2 text-fluux-muted hover:text-fluux-text border border-fluux-hover rounded-lg hover:bg-fluux-hover transition-colors"
                >
                  {t('update.later')}
                </button>
                <button
                  onClick={onDownload}
                  className="flex-1 flex items-center justify-center gap-2 px-4 py-2 bg-fluux-brand text-fluux-text-on-accent rounded-lg hover:bg-fluux-brand/90 transition-colors"
                >
                  <Download className="w-4 h-4" />
                  {t('update.updateNow')}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
