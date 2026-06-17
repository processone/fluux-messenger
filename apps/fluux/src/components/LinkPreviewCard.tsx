/**
 * LinkPreviewCard - Displays a link preview with OGP metadata
 */

import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Image as ImageIcon } from 'lucide-react'
import type { LinkPreview } from '@fluux/sdk'
import { useDeferredMedia } from '@/hooks/useDeferredMedia'

/**
 * Preview images are often served with `cache-control: max-age=0` (e.g. GitHub's
 * OG card service), so every mount revalidates against the host — which may answer
 * 429 when rate-limited even though the cached copy is fine. One delayed retry
 * recovers those transient failures without hammering a rate-limited host.
 */
export const IMAGE_RETRY_DELAY_MS = 3000
const MAX_IMAGE_ATTEMPTS = 2

interface LinkPreviewCardProps {
  preview: LinkPreview
  onLoad?: () => void
}

export function LinkPreviewCard({ preview, onLoad }: LinkPreviewCardProps) {
  const [attempt, setAttempt] = useState(0)
  const [imagePhase, setImagePhase] = useState<'showing' | 'waiting' | 'gone'>('showing')
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { t } = useTranslation()
  const { shouldLoad: showImage, approve: approveImage } = useDeferredMedia(preview.image ?? '')

  useEffect(() => () => {
    if (retryTimer.current) clearTimeout(retryTimer.current)
  }, [])

  // Reset the retry state when the image URL changes: this component instance
  // can be reused (React reconciliation) for a message whose preview image
  // differs, so a stale 'gone' / spent-attempt from the previous URL would
  // otherwise suppress a new, valid image.
  useEffect(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
    setAttempt(0)
    setImagePhase('showing')
  }, [preview.image])

  const handleImageError = () => {
    if (attempt + 1 >= MAX_IMAGE_ATTEMPTS) {
      setImagePhase('gone')
      return
    }
    setImagePhase('waiting')
    retryTimer.current = setTimeout(() => {
      setAttempt((a) => a + 1)
      setImagePhase('showing')
    }, IMAGE_RETRY_DELAY_MS)
  }

  // Extract domain from URL for display
  let domain: string
  try {
    const url = new URL(preview.url)
    domain = url.hostname.replace(/^www\./, '')
  } catch {
    domain = preview.siteName || ''
  }

  return (
    <a
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block mt-2 max-w-md border border-fluux-border rounded-lg overflow-hidden bg-fluux-bg/60 hover:bg-fluux-hover/60 transition-colors"
    >
      {/* Image preview - retried once on error, hidden entirely when it keeps failing */}
      {preview.image && showImage && imagePhase !== 'gone' && (
        <div className="aspect-video bg-fluux-bg/80 overflow-hidden">
          {imagePhase === 'showing' && (
            <img
              // A fresh element per attempt makes the browser re-request the same URL
              key={attempt}
              src={preview.image}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
              onLoad={onLoad}
              onError={handleImageError}
            />
          )}
        </div>
      )}
      {preview.image && !showImage && (
        <div
          role="button"
          tabIndex={0}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); approveImage() }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); approveImage() } }}
          className="aspect-video bg-fluux-hover/60 hover:bg-fluux-hover flex flex-col items-center justify-center gap-1.5 px-4 text-center text-fluux-muted transition-colors cursor-pointer"
        >
          <ImageIcon className="size-6" aria-hidden="true" />
          <span className="text-sm font-medium">{t('chat.showLinkImage')}</span>
          {preview.title && (
            <span className="text-xs line-clamp-2">{preview.title}</span>
          )}
        </div>
      )}

      {/* Content */}
      <div className="p-3 space-y-1">
        {/* Site name / domain */}
        <div className="flex items-center gap-1.5 text-xs text-fluux-muted">
          <ExternalLink className="size-3 flex-shrink-0" />
          <span className="truncate">{preview.siteName || domain}</span>
        </div>

        {/* Title */}
        {preview.title && (
          <h4 className="font-medium text-fluux-text text-sm line-clamp-2">
            {preview.title}
          </h4>
        )}

        {/* Description */}
        {preview.description && (
          <p className="text-sm text-fluux-muted line-clamp-2">
            {preview.description}
          </p>
        )}
      </div>
    </a>
  )
}
