import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { downloadAttachment } from '@/utils/download'
import { platform } from '@/platform'
import type { FileAttachment } from '@fluux/sdk'

interface Props {
  attachment: Pick<FileAttachment, 'url' | 'name' | 'encryption'>
  /** Classes for the interactive element (anchor or button). */
  className?: string
  /** Classes for the icon glyph. */
  iconClassName?: string
  /** Optional visible text next to the glyph, for a call-to-action variant. */
  label?: string
}

/**
 * A download control that decrypts XEP-0454 (aesgcm) attachments before saving.
 *
 * Plaintext web → a plain `<a href download>` so the browser handles it
 * directly (and cross-client `file_share` URLs are preserved verbatim).
 * Tauri or encrypted → a `<button>` that resolves the bytes on click and saves
 * them through the platform download path; a spinner shows while resolving.
 * Ciphertext URLs are never exposed as an href.
 */
export function AttachmentDownloadButton({ attachment, className, iconClassName, label }: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const glyph = busy
    ? <Loader2 className={`${iconClassName ?? ''} animate-spin`} />
    : <Download className={iconClassName} />
  const content = label
    ? <>{glyph}<span>{label}</span></>
    : glyph

  if (!attachment.encryption && !platform().nativeDownloads) {
    return (
      <a
        href={attachment.url}
        download={attachment.name || 'download'}
        className={className}
        aria-label={t('common.download')}
        tabIndex={-1}
      >
        {content}
      </a>
    )
  }

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          await downloadAttachment(attachment, { errorMessage: t('common.downloadFailed') })
        } finally {
          setBusy(false)
        }
      }}
      className={className}
      aria-label={t('common.download')}
      tabIndex={-1}
    >
      {content}
    </button>
  )
}
