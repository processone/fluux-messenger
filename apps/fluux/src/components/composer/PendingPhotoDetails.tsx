import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import type { PendingPhoto } from '@/hooks/usePendingAttachment'
import { fitsUpload } from '@/utils/photoReduction'

/**
 * The part of the attachment banner that describes a large photo: its weights
 * and dimensions, the Reduced/Original choice, and what each shares.
 */
export function PendingPhotoDetails({ photo, file, encrypted, disabled, onChoose, formatSize }: {
  photo: PendingPhoto
  /** What Send uploads. */
  file: File
  encrypted: boolean
  disabled: boolean
  onChoose?: (mode: 'reduced' | 'original') => void
  formatSize: (bytes: number) => string
}) {
  const { t } = useTranslation()
  if (photo.status === 'preparing') {
    return (
      <p role="status" className="flex items-center gap-1 text-xs text-fluux-muted">
        <Loader2 className="size-3 animate-spin" aria-hidden />
        {t('chat.photo.preparing')}
      </p>
    )
  }
  if (photo.status === 'failed') {
    return (
      <>
        <p className="text-xs text-fluux-muted">{formatSize(photo.size)}</p>
        <p role="alert" className="text-xs text-fluux-error">{t('chat.photo.failed')}</p>
        <button type="button" disabled={disabled} onClick={() => onChoose?.('original')}
          className="text-xs font-medium text-fluux-brand hover:underline disabled:opacity-50">
          {t('chat.photo.sendOriginal')}
        </button>
      </>
    )
  }
  const reduced = photo.mode === 'reduced' && photo.reduced
  const dimensions = reduced ? photo.reduced : photo.width && photo.height ? photo : undefined
  const tooLarge = !fitsUpload(file.size, photo.limit, encrypted)
  return (
    <>
      <p className="text-xs text-fluux-muted">
        {reduced ? `${formatSize(photo.size)} → ${formatSize(file.size)}` : formatSize(file.size)}
        {dimensions && ` · ${dimensions.width} × ${dimensions.height}`}
      </p>
      {photo.reduced && (
        <div role="group" aria-label={t('chat.photo.choice')}
          className="mt-1 inline-flex overflow-hidden rounded border border-fluux-border text-xs">
          {(['reduced', 'original'] as const).map(mode => (
            <button key={mode} type="button" aria-pressed={photo.mode === mode} disabled={disabled}
              onClick={() => onChoose?.(mode)}
              className={`px-2 py-0.5 transition-colors disabled:opacity-50 ${photo.mode === mode
                ? 'bg-fluux-brand/15 text-fluux-text font-medium'
                : 'text-fluux-muted hover:bg-fluux-hover'}`}>
              {t(`chat.photo.${mode}`)}
            </button>
          ))}
        </div>
      )}
      {photo.unchanged === 'no-gain' && <p className="text-xs text-fluux-muted">{t('chat.photo.noGain')}</p>}
      <p className="text-xs text-fluux-muted">{t(reduced ? 'chat.photo.reducedNote' : 'chat.photo.originalNote')}</p>
      {tooLarge && photo.limit && (
        <p role="alert" className="text-xs text-fluux-error">
          {t('upload.fileTooLarge', { max: Math.round(photo.limit / 1024 / 1024) })}
        </p>
      )}
    </>
  )
}
