import { useState, memo } from 'react'
import { useTranslation } from 'react-i18next'
import { Music, Film, FileText, Archive, File, Download, BookOpen, Loader2, ImageOff, FileX, Image as ImageIcon } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { ImageLightbox } from './ImageLightbox'
import { ImageContextMenu } from './ImageContextMenu'
import { formatBytes, useAttachmentUrl } from '@/hooks'
import { DeferredMediaPlaceholder } from './DeferredMediaPlaceholder'
import { useDeferredMedia } from '@/hooks/useDeferredMedia'
import { useContextMenu } from '@/hooks/useContextMenu'
import { isPdfMimeType, isDocumentMimeType, isArchiveMimeType, isEbookMimeType, getFileTypeLabel } from '@/utils/thumbnail'
import type { FileAttachment } from '@fluux/sdk'

/**
 * Shared file attachment components used by both ChatView and RoomView
 */

/**
 * Cache of URLs that failed to load. Prevents repeated retry attempts
 * when components are unmounted/remounted (e.g., during scrolling).
 * Uses a Set for O(1) lookup.
 */
const failedUrlCache = new Set<string>()

interface AttachmentProps {
  attachment: FileAttachment
  /** Called when image/video loads - useful for scroll adjustment */
  onLoad?: () => void
}

/**
 * Image attachment preview with clickable link to full image
 * Falls back to main URL when no thumbnail is provided (e.g., from other XMPP clients)
 * Uses direct media URLs for browser/WebView loading.
 */
export const ImageAttachment = memo(function ImageAttachment({ attachment, onLoad }: AttachmentProps) {
  const { t } = useTranslation()
  const isImage = attachment.mediaType?.startsWith('image/') ?? false
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const imageMenu = useContextMenu()

  // Use thumbnail if available, otherwise fall back to main URL. Encryption
  // params track the chosen source: if we picked the thumbnail URL we need
  // the thumbnail's encryption params (they use distinct keys from the main
  // file), not the main file's.
  const hasThumbnail = Boolean(attachment.thumbnail?.uri)
  const originalImageSrc = attachment.thumbnail?.uri || attachment.url
  const originalEncryption = hasThumbnail
    ? attachment.thumbnail?.encryption
    : attachment.encryption

  // Check if this URL previously failed - initialize state from cache
  const [loadError, setLoadError] = useState(() => failedUrlCache.has(originalImageSrc))

  // Media-autoload gating: defer fetch unless policy allows or user tapped
  const { shouldLoad, approve } = useDeferredMedia(originalImageSrc)

  // Fetch + decrypt if encrypted (XEP-0454), or proxy through the platform
  // cache for plaintext. Branches internal to the hook; renderer is
  // unaware.
  const { url: proxiedImageSrc, isLoading, error } = useAttachmentUrl(
    originalImageSrc,
    originalEncryption,
    isImage && shouldLoad,
  )

  // Early return after hooks
  if (!isImage) {
    return null
  }

  // Prefer XEP-0446 original dimensions, fall back to thumbnail dimensions
  const width = attachment.width ?? attachment.thumbnail?.width
  const height = attachment.height ?? attachment.thumbnail?.height
  const hasKnownDimensions = width !== undefined && height !== undefined

  // Calculate aspect ratio to reserve space and prevent layout shift
  // Use 4:3 as default for unknown dimensions (common photo ratio)
  const DEFAULT_ASPECT_RATIO = 4 / 3
  const aspectRatio = hasKnownDimensions
    ? width / height
    : DEFAULT_ASPECT_RATIO

  // For very wide images (aspect ratio > 3), limit max-width to prevent thin strips
  // spanning the full container width. This makes them more compact thumbnails.
  // The wider the aspect ratio, the more we constrain the width.
  const DEFAULT_MAX_WIDTH = 384 // max-w-sm
  const maxWidthPx = hasKnownDimensions && aspectRatio > 3
    // Scale down: 3:1 → 300px, 4:1 → 280px, 5:1 → 260px, 8:1 → 200px
    ? Math.max(200, Math.round(340 - (aspectRatio - 3) * 20))
    : DEFAULT_MAX_WIDTH

  // Show tap-to-load placeholder when media autoload is deferred
  if (isImage && !shouldLoad) {
    return (
      <DeferredMediaPlaceholder
        variant="box"
        icon={ImageIcon}
        label={t('chat.loadImage')}
        sizeLabel={attachment.size ? formatBytes(attachment.size) : undefined}
        aspectRatio={aspectRatio}
        maxWidthPx={maxWidthPx}
        onLoad={approve}
      />
    )
  }

  // Show loading placeholder while fetching
  if (isLoading) {
    return (
      <div
        className="pt-2 rounded-lg bg-fluux-hover/60 flex items-center justify-center"
        style={{ aspectRatio, maxWidth: `${maxWidthPx}px`, maxHeight: '300px', minHeight: '100px' }}
      >
        <Loader2 className="size-6 text-fluux-muted animate-spin" />
      </div>
    )
  }

  // Show error state if fetch failed or image failed to load (404, etc.).
  // Reserve the SAME aspect-ratio box the loading/loaded image uses: an image
  // whose blob URL is invalidated after it was displayed (sleep/wake, WebKit
  // blob reclaim) must not collapse to a compact card, or every row below it
  // shifts — and a burst of such invalidations feeds the message-list
  // ResizeObserver scroll-correction loop on WebKitGTK.
  if (error || !proxiedImageSrc || loadError) {
    return (
      <a
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
        className="block pt-2 group/file"
        style={{ maxWidth: `${maxWidthPx}px` }}
        tabIndex={-1}
      >
        <div
          className="flex flex-col items-center justify-center gap-2 px-3 rounded-lg bg-fluux-bg/60 border border-fluux-border hover:bg-fluux-hover/60 transition-colors text-fluux-muted"
          style={{ aspectRatio, maxHeight: '300px', minHeight: '100px' }}
        >
          <ImageOff className="size-6 flex-shrink-0" />
          <p className="text-sm font-medium truncate max-w-full">
            {attachment.name || t('chat.imageUnavailable')}
          </p>
          <p className="text-xs">
            {t('chat.imageUnavailable')}
            {attachment.size ? ` • ${formatBytes(attachment.size)}` : ''}
          </p>
          <Download className="size-4 opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0" />
        </div>
      </a>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (imageMenu.isOpen || imageMenu.longPressTriggered.current) return
          setLightboxOpen(true)
        }}
        onContextMenu={imageMenu.handleContextMenu}
        onTouchStart={imageMenu.handleTouchStart}
        onTouchEnd={imageMenu.handleTouchEnd}
        onTouchMove={imageMenu.handleTouchEnd}
        className="block pt-2 rounded-lg overflow-hidden hover:opacity-90 transition-opacity cursor-pointer text-start"
        style={{ maxWidth: `${maxWidthPx}px` }}
        tabIndex={-1}
      >
        <img
          src={proxiedImageSrc}
          alt={attachment.name || 'Image attachment'}
          width={width}
          height={height}
          className="max-w-full rounded-lg object-contain"
          style={{
            aspectRatio: aspectRatio,
            maxHeight: '300px',
          }}
          loading="lazy"
          onLoad={onLoad}
          onError={() => {
            failedUrlCache.add(originalImageSrc)
            setLoadError(true)
          }}
        />
      </button>
      <ImageContextMenu
        originalUrl={attachment.url}
        proxiedUrl={proxiedImageSrc}
        filename={attachment.name}
        menu={imageMenu}
      />
      {lightboxOpen && (
        <ImageLightbox
          src={attachment.url}
          placeholderSrc={proxiedImageSrc ?? undefined}
          alt={attachment.name || 'Image attachment'}
          downloadUrl={attachment.url}
          encryption={attachment.encryption}
          filename={attachment.name}
          onClose={() => setLightboxOpen(false)}
        />
      )}
    </>
  )
})

/**
 * Video attachment with inline player and info bar
 * Uses direct media URLs for browser/WebView loading.
 */
export const VideoAttachment = memo(function VideoAttachment({ attachment, onLoad }: AttachmentProps) {
  const { t } = useTranslation()
  const isVideo = attachment.mediaType?.startsWith('video/') ?? false

  // Check if this URL previously failed - initialize state from cache
  const [loadError, setLoadError] = useState(() => failedUrlCache.has(attachment.url))

  // Media-autoload gating: defer fetch unless policy allows or user tapped
  const { shouldLoad, approve } = useDeferredMedia(attachment.url)

  // Resolve URL for video playback (only when it's a video). Both main
  // file and poster/thumbnail go through useAttachmentUrl so the
  // encrypted path is handled transparently.
  const { url: proxiedVideoUrl, isLoading, error } = useAttachmentUrl(
    attachment.url,
    attachment.encryption,
    isVideo && shouldLoad,
  )
  const { url: proxiedPosterUrl } = useAttachmentUrl(
    attachment.thumbnail?.uri,
    attachment.thumbnail?.encryption,
    isVideo && shouldLoad && !!attachment.thumbnail?.uri,
  )

  // Early return after hooks
  if (!isVideo) {
    return null
  }

  // Compute stable aspect ratio from XEP-0446 dimensions or thumbnail dimensions.
  // Fall back to 16:9 (most common video ratio) when dimensions are unknown.
  // Applied to all render paths (loading, error, video) to prevent layout shifts
  // that trigger ResizeObserver → scroll correction feedback loops (especially on
  // Linux/KDE with WebKitGTK where video controls cause continuous height changes).
  const width = attachment.width ?? attachment.thumbnail?.width
  const height = attachment.height ?? attachment.thumbnail?.height
  const aspectRatio = (width && height) ? width / height : 16 / 9

  // Shared container style: stable dimensions + layout containment to isolate
  // video control visibility changes from affecting parent layout measurements
  const containerStyle = { aspectRatio, contain: 'layout' as const }

  // Show tap-to-load placeholder when media autoload is deferred
  if (isVideo && !shouldLoad) {
    return (
      <DeferredMediaPlaceholder
        variant="box"
        icon={Film}
        label={t('chat.loadVideo')}
        sizeLabel={attachment.size ? formatBytes(attachment.size) : undefined}
        aspectRatio={aspectRatio}
        maxWidthPx={448}
        onLoad={approve}
      />
    )
  }

  // Show loading state
  if (isLoading) {
    return (
      <div className="pt-2 max-w-md rounded-lg overflow-hidden bg-black flex items-center justify-center" style={containerStyle}>
        <Loader2 className="size-8 text-fluux-muted animate-spin" />
      </div>
    )
  }

  // Show error/fallback if fetch failed or video failed to load (404, etc.)
  if (error || !proxiedVideoUrl || loadError) {
    return (
      <div className="pt-2 max-w-md rounded-lg overflow-hidden bg-fluux-hover/60 border border-fluux-border" style={containerStyle}>
        <div className="flex flex-col items-center justify-center text-fluux-muted text-sm py-8 gap-2">
          <FileX className="size-8" />
          <span>{t('chat.videoUnavailable')}</span>
        </div>
        <div className="flex items-center gap-2 px-3 py-2 bg-fluux-bg/40">
          {attachment.name && (
            <div className="flex items-center gap-2 min-w-0">
            <Film className="size-4 text-fluux-muted flex-shrink-0" />
            <span className="text-sm text-fluux-muted truncate">{attachment.name}</span>
            </div>
          )}
          <Tooltip content={t('common.download')} position="top">
            <a
              href={attachment.url}
              download={attachment.name || 'video'}
              className="ms-auto p-1 rounded hover:bg-fluux-bg transition-colors flex-shrink-0"
              aria-label={t('common.download')}
              tabIndex={-1}
            >
              <Download className="size-4 text-fluux-muted hover:text-fluux-text" />
            </a>
          </Tooltip>
        </div>
      </div>
    )
  }

  return (
    <div className="pt-2 max-w-md rounded-lg overflow-hidden bg-black">
      {/* Height-locked video region: the box height is fixed by aspect-ratio and
          the <video> is absolutely positioned to fill it, so native controls
          render as an overlay and can never change the box height. On WebKitGTK
          that height oscillation is what drives the message-list ResizeObserver
          scroll-correction feedback loop. */}
      <div className="relative w-full" style={containerStyle}>
        <video
          src={proxiedVideoUrl}
          controls
          preload="metadata"
          poster={proxiedPosterUrl || undefined}
          className="absolute inset-0 h-full w-full object-contain"
          tabIndex={-1}
          onLoadedMetadata={onLoad}
          onError={() => {
            failedUrlCache.add(attachment.url)
            setLoadError(true)
          }}
        />
      </div>
      {/* Video info bar */}
      {attachment.name && (
        <div className="flex items-center gap-2 px-3 py-2 bg-fluux-bg/60 border-t border-fluux-border">
          <Film className="size-4 text-fluux-muted flex-shrink-0" />
          <span className="text-sm text-fluux-text truncate">{attachment.name}</span>
          {attachment.duration !== undefined && (
            <span className="text-xs text-fluux-muted ms-auto flex-shrink-0">
              {formatDuration(attachment.duration)}
            </span>
          )}
          <Tooltip content={t('common.download')} position="top">
            <a
              href={attachment.url}
              download={attachment.name}
              className="p-1 rounded hover:bg-fluux-bg transition-colors flex-shrink-0"
              aria-label={t('common.download')}
              tabIndex={-1}
            >
              <Download className="size-4 text-fluux-muted hover:text-fluux-text" />
            </a>
          </Tooltip>
        </div>
      )}
    </div>
  )
})

/**
 * Audio attachment with inline player
 * Uses direct media URLs for browser/WebView loading.
 */
export function AudioAttachment({ attachment }: AttachmentProps) {
  const { t } = useTranslation()
  const isAudio = (attachment.mediaType?.startsWith('audio/') ?? false) && !attachment.thumbnail

  // Check if this URL previously failed - initialize state from cache
  const [loadError, setLoadError] = useState(() => failedUrlCache.has(attachment.url))

  // Media-autoload gating: defer fetch unless policy allows or user tapped
  const { shouldLoad, approve } = useDeferredMedia(attachment.url)

  // Resolve URL for audio playback (only when it's audio). Encrypted
  // audio is transparently fetched + decrypted.
  const { url: proxiedAudioUrl, isLoading, error } = useAttachmentUrl(
    attachment.url,
    attachment.encryption,
    isAudio && shouldLoad,
  )

  // Early return after hooks
  if (!isAudio) {
    return null
  }

  // Show tap-to-load placeholder when media autoload is deferred
  if (isAudio && !shouldLoad) {
    return (
      <DeferredMediaPlaceholder
        variant="card"
        icon={Music}
        label={t('chat.loadAudio')}
        sizeLabel={attachment.size ? formatBytes(attachment.size) : undefined}
        onLoad={approve}
      />
    )
  }

  const hasError = error || !proxiedAudioUrl || loadError

  return (
    <div className="pt-2 max-w-sm">
      <div className={`flex items-center gap-3 p-3 rounded-t-lg border border-b-0 border-fluux-border ${hasError ? 'bg-fluux-hover/40' : 'bg-fluux-hover/60'}`}>
        <div className={`size-10 rounded-full flex items-center justify-center flex-shrink-0 ${hasError ? 'bg-fluux-muted/30' : 'bg-fluux-brand'}`}>
          {isLoading ? (
            <Loader2 className="size-5 text-fluux-text-on-accent animate-spin" />
          ) : hasError ? (
            <FileX className="size-5 text-fluux-muted" />
          ) : (
            <Music className="size-5 text-fluux-text-on-accent" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${hasError ? 'text-fluux-muted' : 'text-fluux-text'}`}>
            {attachment.name || t('chat.audioFile')}
          </p>
          <p className="text-xs text-fluux-muted">
            {hasError
              ? t('chat.audioUnavailable')
              : attachment.duration !== undefined
                ? formatDuration(attachment.duration)
                : t('chat.audio')}
          </p>
        </div>
        {!hasError && (
          <Tooltip content={t('common.download')} position="top">
            <a
              href={attachment.url}
              download={attachment.name || 'audio'}
              className="p-1 rounded hover:bg-fluux-bg transition-colors flex-shrink-0"
              aria-label={t('common.download')}
              tabIndex={-1}
            >
              <Download className="size-4 text-fluux-muted hover:text-fluux-text" />
            </a>
          </Tooltip>
        )}
      </div>
      {hasError ? (
        <div className="w-full rounded-b-lg bg-fluux-bg/40 border border-t-0 border-fluux-border h-10" />
      ) : (
        <audio
          src={proxiedAudioUrl}
          controls
          preload="metadata"
          className="w-full rounded-b-lg"
          style={{ height: '40px' }}
          tabIndex={-1}
          onError={() => {
            failedUrlCache.add(attachment.url)
            setLoadError(true)
          }}
        />
      )}
    </div>
  )
}

/**
 * File attachment card for documents, archives, and other non-media files
 * Shows file type icon with appropriate color, filename, type label, and size
 */
export function FileAttachmentCard({ attachment }: AttachmentProps) {
  const { t } = useTranslation()

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 p-3 mt-2 max-w-sm rounded-lg bg-fluux-bg/60 border border-fluux-border hover:bg-fluux-hover/60 transition-colors group/file"
      tabIndex={-1}
    >
      {/* File type icon */}
      <div className={`size-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
        isPdfMimeType(attachment.mediaType) ? 'bg-red-500/20 text-red-500' :
        isEbookMimeType(attachment.mediaType) ? 'bg-purple-500/20 text-purple-500' :
        isDocumentMimeType(attachment.mediaType) ? 'bg-blue-500/20 text-blue-500' :
        isArchiveMimeType(attachment.mediaType) ? 'bg-yellow-500/20 text-yellow-500' :
        'bg-fluux-muted/20 text-fluux-muted'
      }`}>
        {isPdfMimeType(attachment.mediaType) ? <FileText className="size-5" /> :
         isEbookMimeType(attachment.mediaType) ? <BookOpen className="size-5" /> :
         isDocumentMimeType(attachment.mediaType) ? <FileText className="size-5" /> :
         isArchiveMimeType(attachment.mediaType) ? <Archive className="size-5" /> :
         <File className="size-5" />}
      </div>
      {/* File info */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-fluux-text truncate">
          {attachment.name || t('chat.file')}
        </p>
        <p className="text-xs text-fluux-muted">
          {getFileTypeLabel(attachment.mediaType)}
          {attachment.size && ` • ${formatBytes(attachment.size)}`}
        </p>
      </div>
      {/* Download icon */}
      <Download className="size-4 text-fluux-muted opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0" />
    </a>
  )
}

/**
 * Determines if an attachment should be rendered as a file card
 * (non-media, non-text files like PDFs, documents, archives)
 */
export function shouldShowFileCard(attachment: FileAttachment | undefined, canPreviewAsText: boolean): boolean {
  if (!attachment) return false
  if (attachment.mediaType?.startsWith('image/')) return false
  if (attachment.mediaType?.startsWith('video/')) return false
  if (attachment.mediaType?.startsWith('audio/')) return false
  if (canPreviewAsText) return false
  return true
}

/**
 * Format duration in seconds to mm:ss or hh:mm:ss format.
 */
function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  const secs = Math.floor(seconds % 60)

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }
  return `${mins}:${secs.toString().padStart(2, '0')}`
}
