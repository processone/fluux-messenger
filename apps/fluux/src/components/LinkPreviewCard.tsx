/**
 * LinkPreviewCard - Displays a link preview with OGP metadata
 */

import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import type { LinkPreview } from '@fluux/sdk'

interface LinkPreviewCardProps {
  preview: LinkPreview
  onLoad?: () => void
}

export function LinkPreviewCard({ preview, onLoad }: LinkPreviewCardProps) {
  const [imageError, setImageError] = useState(false)

  // Extract domain from URL for display
  let domain = ''
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
      {/* Image preview - hidden entirely on error */}
      {preview.image && !imageError && (
        <div className="aspect-video bg-fluux-bg/80 overflow-hidden">
          <img
            src={preview.image}
            alt=""
            className="w-full h-full object-cover"
            loading="lazy"
            onLoad={onLoad}
            onError={() => setImageError(true)}
          />
        </div>
      )}

      {/* Content */}
      <div className="p-3 space-y-1">
        {/* Site name / domain */}
        <div className="flex items-center gap-1.5 text-xs text-fluux-muted">
          <ExternalLink className="w-3 h-3 flex-shrink-0" />
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
