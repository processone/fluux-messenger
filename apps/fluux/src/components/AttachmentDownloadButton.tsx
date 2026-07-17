import { useState } from 'react'
import { Download, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { downloadAttachment } from '@/utils/download'
import type { FileAttachment } from '@fluux/sdk'

interface Props {
  attachment: Pick<FileAttachment, 'url' | 'name' | 'encryption'>
  /** Classes for the interactive element (anchor or button). */
  className?: string
  /** Classes for the icon glyph. */
  iconClassName?: string
}

/**
 * A download control that decrypts XEP-0454 (aesgcm) attachments before saving.
 *
 * Plaintext → a plain `<a href download>` so the browser/webview handles it
 * directly (and cross-client `file_share` URLs are preserved verbatim).
 * Encrypted → a `<button>` that resolves the decrypted bytes on click and
 * saves those; a spinner shows while decrypting. The ciphertext URL is never
 * exposed as an href.
 */
export function AttachmentDownloadButton({ attachment, className, iconClassName }: Props) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const icon = busy
    ? <Loader2 className={`${iconClassName ?? ''} animate-spin`} />
    : <Download className={iconClassName} />

  if (!attachment.encryption) {
    return (
      <a
        href={attachment.url}
        download={attachment.name || 'download'}
        className={className}
        aria-label={t('common.download')}
        tabIndex={-1}
      >
        {icon}
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
      {icon}
    </button>
  )
}
