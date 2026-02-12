import { useTranslation } from 'react-i18next'
import { FileText, Download, Loader2 } from 'lucide-react'
import { useTextPreview, formatBytes } from '@/hooks'
import { canPreviewAsText, getFileTypeLabel } from '@/utils/thumbnail'
import type { FileAttachment } from '@fluux/sdk'

interface TextFilePreviewProps {
  attachment: FileAttachment
  /** Whether the parent message is selected (for gradient adaptation) */
  isSelected?: boolean
  /** Whether the parent message is hovered (for gradient adaptation) */
  isHovered?: boolean
}

/**
 * Renders an inline text file preview with the file content displayed
 * in a code block, plus a download card below.
 */
export function TextFilePreview({ attachment, isSelected = false, isHovered = false }: TextFilePreviewProps) {
  const { t } = useTranslation()
  const canPreview = canPreviewAsText(attachment.mediaType, attachment.name)
  const { content, isLoading, error, isTruncated } = useTextPreview(
    attachment.url,
    canPreview
  )

  // Don't render anything if this isn't a text file
  if (!canPreview) return null

  return (
    <div className="mt-2 max-w-md">
      {/* Text content preview */}
      <div className="rounded-t-lg bg-fluux-bg/60 border border-fluux-border border-b-0 overflow-hidden">
        {isLoading ? (
          <div className="flex items-center justify-center p-4 text-fluux-muted">
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            <span className="text-sm">{t('chat.loadingPreview')}</span>
          </div>
        ) : error ? (
          <div className="p-3 text-sm text-fluux-muted italic">
            {t('chat.previewUnavailable')}
          </div>
        ) : content ? (
          <div className="relative">
            <pre className="p-3 text-xs font-mono text-fluux-text overflow-x-auto max-h-48 whitespace-pre-wrap break-words">
              {content}
            </pre>
            {isTruncated && (
              <div
                className="absolute bottom-0 left-0 right-0 h-8 pointer-events-none"
                style={{
                  // Adapt gradient to parent message highlight state (selected > hovered > default)
                  background: `linear-gradient(to top, var(${
                    isSelected ? '--fluux-selection' : isHovered ? '--fluux-hover' : '--fluux-bg'
                  }) 60%, transparent)`,
                }}
              />
            )}
          </div>
        ) : null}
      </div>

      {/* File info card / download link */}
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-3 p-3 rounded-b-lg bg-fluux-hover/60 hover:bg-fluux-bg/60 border border-fluux-border transition-colors group/file"
      >
        <div className="w-8 h-8 rounded-lg bg-fluux-muted/20 flex items-center justify-center flex-shrink-0">
          <FileText className="w-4 h-4 text-fluux-muted" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-fluux-text truncate">
            {attachment.name || t('chat.file')}
          </p>
          <p className="text-xs text-fluux-muted">
            {getFileTypeLabel(attachment.mediaType)}
            {attachment.size && ` • ${formatBytes(attachment.size)}`}
            {isTruncated && ` • ${t('chat.truncated')}`}
          </p>
        </div>
        <Download className="w-4 h-4 text-fluux-muted opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0" />
      </a>
    </div>
  )
}
