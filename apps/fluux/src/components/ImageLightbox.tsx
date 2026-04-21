/**
 * Full-screen lightbox overlay for viewing image attachments.
 * Triggered by clicking on an image attachment in chat/room views.
 */
import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { X, Download, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProxiedUrl } from '@/hooks'

interface ImageLightboxProps {
  /** Original full-resolution image URL (proxied internally for display) */
  src: string
  /** Alt text for the image */
  alt?: string
  /** Original URL for downloading */
  downloadUrl: string
  /** Original filename */
  filename?: string
  /** Optional preview URL (e.g. already-proxied thumbnail) shown while the full-size image loads */
  placeholderSrc?: string
  /** Close handler */
  onClose: () => void
}

export function ImageLightbox({ src, alt, downloadUrl, filename, placeholderSrc, onClose }: ImageLightboxProps) {
  const { t } = useTranslation()
  const mouseDownTargetRef = useRef<EventTarget | null>(null)
  const { url: proxiedSrc, isLoading } = useProxiedUrl(src)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const displaySrc = proxiedSrc ?? placeholderSrc

  return createPortal(
    <div
      className="fixed inset-0 bg-black/90 flex flex-col items-center justify-center z-50"
      onMouseDown={(e) => { mouseDownTargetRef.current = e.target }}
      onClick={(e) => {
        if (e.target === e.currentTarget && mouseDownTargetRef.current === e.currentTarget) onClose()
      }}
    >
      {/* Top-right controls */}
      <div className="absolute top-4 end-4 flex items-center gap-2">
        <a
          href={downloadUrl}
          download={filename || 'image'}
          className="p-2 text-white/70 hover:text-white rounded-full hover:bg-white/10 transition-colors"
          title={t('common.download')}
        >
          <Download className="w-6 h-6" />
        </a>
        <button
          onClick={onClose}
          className="p-2 text-white/70 hover:text-white rounded-full hover:bg-white/10 transition-colors"
          title={t('common.close')}
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      {/* Image */}
      {displaySrc ? (
        <img
          src={displaySrc}
          alt={alt || 'Image'}
          className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg select-none"
          draggable={false}
        />
      ) : (
        isLoading && <Loader2 className="w-8 h-8 text-white/70 animate-spin" />
      )}

      {/* Filename label */}
      {filename && (
        <div className="mt-3 text-white/70 text-sm truncate max-w-[90vw]">
          {filename}
        </div>
      )}
    </div>,
    document.body
  )
}
