import { useTranslation } from 'react-i18next'
import type { LucideIcon } from 'lucide-react'
import { AttachmentDownloadButton } from './AttachmentDownloadButton'
import { formatBytes } from '@/hooks'
import type { FileAttachment } from '@fluux/sdk'

interface UnplayableMediaCardProps {
  attachment: FileAttachment
  /** 'box' reserves an aspect-ratio area (video); 'card' is a compact row (audio). */
  variant: 'box' | 'card'
  /** Glyph for the media kind, e.g. Film for video. */
  icon: LucideIcon
  /** Why nothing is playing, e.g. "This video format can't be played here". */
  message: string
  /** Box variant only: reserve the media's shape so the row height does not shift. */
  aspectRatio?: number
}

const DOWNLOAD_BUTTON_CLASS =
  'inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-fluux-border bg-fluux-bg/60 text-sm font-medium text-fluux-text hover:bg-fluux-hover transition-colors'

/**
 * Shown when the file is intact but this engine has no decoder for it, so the
 * only useful action is saving it and opening it elsewhere. Distinct from the
 * "no longer available" card, which means the bytes could not be retrieved.
 */
export function UnplayableMediaCard({ attachment, variant, icon: Icon, message, aspectRatio }: UnplayableMediaCardProps) {
  const { t } = useTranslation()

  if (variant === 'card') {
    return (
      <div className="pt-2 max-w-sm rounded-lg overflow-hidden border border-fluux-border">
        <div className="flex items-center gap-3 p-3 bg-fluux-hover/60">
          <div className="size-10 rounded-full bg-fluux-muted/30 flex items-center justify-center flex-shrink-0">
            <Icon className="size-5 text-fluux-muted" aria-hidden="true" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-fluux-text truncate" title={attachment.name}>
              {attachment.name || t('chat.audioFile')}
            </p>
            <p className="text-xs text-fluux-muted">{message}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-fluux-bg/40">
          <AttachmentDownloadButton
            attachment={attachment}
            label={t('common.download')}
            className={DOWNLOAD_BUTTON_CLASS}
            iconClassName="size-4"
          />
          {attachment.size !== undefined && (
            <span className="text-xs text-fluux-muted ms-auto flex-shrink-0">{formatBytes(attachment.size)}</span>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="pt-2 max-w-md rounded-lg overflow-hidden bg-fluux-hover/60 border border-fluux-border">
      <div
        className="flex flex-col items-center justify-center gap-3 px-4 text-center"
        style={{ aspectRatio, contain: 'layout' }}
      >
        <Icon className="size-8 text-fluux-muted" aria-hidden="true" />
        <span className="text-sm text-fluux-muted">{message}</span>
        <AttachmentDownloadButton
          attachment={attachment}
          label={t('common.download')}
          className={DOWNLOAD_BUTTON_CLASS}
          iconClassName="size-4"
        />
      </div>
      {attachment.name && (
        <div className="flex items-center gap-2 px-3 py-2 bg-fluux-bg/40">
          <Icon className="size-4 text-fluux-muted flex-shrink-0" aria-hidden="true" />
          <span className="text-sm text-fluux-muted truncate" title={attachment.name}>{attachment.name}</span>
          {attachment.size !== undefined && (
            <span className="text-xs text-fluux-muted ms-auto flex-shrink-0">{formatBytes(attachment.size)}</span>
          )}
        </div>
      )}
    </div>
  )
}
