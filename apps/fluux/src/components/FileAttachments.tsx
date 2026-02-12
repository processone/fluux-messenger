import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Music, Film, FileText, Archive, File, Download, BookOpen, Loader2, ImageOff, FileX } from 'lucide-react'
import { Tooltip } from './Tooltip'
import { formatBytes, useProxiedUrl } from '@/hooks'
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
 * Uses Tauri HTTP plugin to bypass CORS in desktop app.
 */
export function ImageAttachment({ attachment, onLoad }: AttachmentProps) {
  const { t } = useTranslation()
  const isImage = attachment.mediaType?.startsWith('image/') ?? false

  // Use thumbnail if available, otherwise fall back to main URL
  const originalImageSrc = attachment.thumbnail?.uri || attachment.url

  // Check if this URL previously failed - initialize state from cache
  const [loadError, setLoadError] = useState(() => failedUrlCache.has(originalImageSrc))

  // Fetch via Tauri HTTP plugin to bypass CORS (only when it's an image)
  const { url: proxiedImageSrc, isLoading, error } = useProxiedUrl(originalImageSrc, isImage)

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

  // Show loading placeholder while fetching
  if (isLoading) {
    return (
      <div
        className="pt-2 rounded-lg bg-fluux-hover/60 border border-fluux-muted/10 flex items-center justify-center"
        style={{ aspectRatio, maxWidth: `${maxWidthPx}px`, maxHeight: '300px', minHeight: '100px' }}
      >
        <Loader2 className="w-6 h-6 text-fluux-muted animate-spin" />
      </div>
    )
  }

  // Show error state if fetch failed or image failed to load (404, etc.)
  if (error || !proxiedImageSrc || loadError) {
    return (
      <div
        className="pt-2 rounded-lg bg-fluux-hover/60 border border-fluux-muted/10 flex flex-col items-center justify-center text-fluux-muted text-sm gap-2"
        style={{ aspectRatio, maxWidth: `${maxWidthPx}px`, maxHeight: '300px', minHeight: '100px' }}
      >
        <ImageOff className="w-8 h-8" />
        <span>{t('chat.imageUnavailable')}</span>
      </div>
    )
  }

  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block pt-2 rounded-lg overflow-hidden hover:opacity-90 transition-opacity"
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
          // Always reserve space using aspect ratio to prevent layout shift
          aspectRatio: aspectRatio,
          // Max height for reasonable sizing
          maxHeight: '300px',
        }}
        loading="lazy"
        onLoad={onLoad}
        onError={() => {
          failedUrlCache.add(originalImageSrc)
          setLoadError(true)
        }}
      />
    </a>
  )
}

/**
 * Video attachment with inline player and info bar
 * Uses Tauri HTTP plugin to bypass CORS in desktop app.
 */
export function VideoAttachment({ attachment, onLoad }: AttachmentProps) {
  const { t } = useTranslation()
  const isVideo = attachment.mediaType?.startsWith('video/') ?? false

  // Check if this URL previously failed - initialize state from cache
  const [loadError, setLoadError] = useState(() => failedUrlCache.has(attachment.url))

  // Fetch video via Tauri HTTP plugin to bypass CORS (only when it's a video)
  const { url: proxiedVideoUrl, isLoading, error } = useProxiedUrl(attachment.url, isVideo)
  // Also fetch poster/thumbnail if available
  const { url: proxiedPosterUrl } = useProxiedUrl(attachment.thumbnail?.uri, isVideo && !!attachment.thumbnail?.uri)

  // Early return after hooks
  if (!isVideo) {
    return null
  }

  // Show loading state
  if (isLoading) {
    return (
      <div className="pt-2 max-w-md rounded-lg overflow-hidden bg-black flex items-center justify-center" style={{ minHeight: '200px' }}>
        <Loader2 className="w-8 h-8 text-fluux-muted animate-spin" />
      </div>
    )
  }

  // Show error/fallback if fetch failed or video failed to load (404, etc.)
  if (error || !proxiedVideoUrl || loadError) {
    return (
      <div className="pt-2 max-w-md rounded-lg overflow-hidden bg-fluux-hover/60 border border-fluux-muted/10">
        <div className="flex flex-col items-center justify-center text-fluux-muted text-sm py-8 gap-2">
          <FileX className="w-8 h-8" />
          <span>{t('chat.videoUnavailable')}</span>
        </div>
        {attachment.name && (
          <div className="flex items-center gap-2 px-3 py-2 bg-fluux-bg/40">
            <Film className="w-4 h-4 text-fluux-muted flex-shrink-0" />
            <span className="text-sm text-fluux-muted truncate">{attachment.name}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="pt-2 max-w-md rounded-lg overflow-hidden bg-black">
      <video
        controls
        preload="metadata"
        poster={proxiedPosterUrl || undefined}
        className="w-full max-h-80"
        tabIndex={-1}
        onLoadedMetadata={onLoad}
        onError={() => {
          failedUrlCache.add(attachment.url)
          setLoadError(true)
        }}
      >
        <source src={proxiedVideoUrl} type={attachment.mediaType} />
      </video>
      {/* Video info bar */}
      {attachment.name && (
        <div className="flex items-center gap-2 px-3 py-2 bg-fluux-hover/80">
          <Film className="w-4 h-4 text-fluux-muted flex-shrink-0" />
          <span className="text-sm text-fluux-text truncate">{attachment.name}</span>
          {attachment.duration !== undefined && (
            <span className="text-xs text-fluux-muted ml-auto flex-shrink-0">
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
              <Download className="w-4 h-4 text-fluux-muted hover:text-fluux-text" />
            </a>
          </Tooltip>
        </div>
      )}
    </div>
  )
}

/**
 * Audio attachment with inline player
 * Uses Tauri HTTP plugin to bypass CORS in desktop app.
 */
export function AudioAttachment({ attachment }: AttachmentProps) {
  const { t } = useTranslation()
  const isAudio = (attachment.mediaType?.startsWith('audio/') ?? false) && !attachment.thumbnail

  // Check if this URL previously failed - initialize state from cache
  const [loadError, setLoadError] = useState(() => failedUrlCache.has(attachment.url))

  // Fetch audio via Tauri HTTP plugin to bypass CORS (only when it's audio)
  const { url: proxiedAudioUrl, isLoading, error } = useProxiedUrl(attachment.url, isAudio)

  // Early return after hooks
  if (!isAudio) {
    return null
  }

  const hasError = error || !proxiedAudioUrl || loadError

  return (
    <div className="pt-2 max-w-sm">
      <div className={`flex items-center gap-3 p-3 rounded-t-lg border border-b-0 border-fluux-muted/10 ${hasError ? 'bg-fluux-hover/40' : 'bg-fluux-hover/60'}`}>
        <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 ${hasError ? 'bg-fluux-muted/30' : 'bg-fluux-brand'}`}>
          {isLoading ? (
            <Loader2 className="w-5 h-5 text-white animate-spin" />
          ) : hasError ? (
            <FileX className="w-5 h-5 text-fluux-muted" />
          ) : (
            <Music className="w-5 h-5 text-white" />
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
              <Download className="w-4 h-4 text-fluux-muted hover:text-fluux-text" />
            </a>
          </Tooltip>
        )}
      </div>
      {hasError ? (
        <div className="w-full rounded-b-lg bg-fluux-bg/40 border border-t-0 border-fluux-muted/10 h-10" />
      ) : (
        <audio
          controls
          preload="metadata"
          className="w-full rounded-b-lg"
          style={{ height: '40px' }}
          tabIndex={-1}
          onError={() => {
            failedUrlCache.add(attachment.url)
            setLoadError(true)
          }}
        >
          <source src={proxiedAudioUrl} type={attachment.mediaType} />
        </audio>
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
      className="flex items-center gap-3 p-3 mt-2 max-w-sm rounded-lg bg-fluux-bg/60 border border-fluux-muted/10 hover:border-fluux-muted/20 hover:bg-fluux-hover/60 transition-colors group/file"
      tabIndex={-1}
    >
      {/* File type icon */}
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
        isPdfMimeType(attachment.mediaType) ? 'bg-red-500/20 text-red-500' :
        isEbookMimeType(attachment.mediaType) ? 'bg-purple-500/20 text-purple-500' :
        isDocumentMimeType(attachment.mediaType) ? 'bg-blue-500/20 text-blue-500' :
        isArchiveMimeType(attachment.mediaType) ? 'bg-yellow-500/20 text-yellow-500' :
        'bg-fluux-muted/20 text-fluux-muted'
      }`}>
        {isPdfMimeType(attachment.mediaType) ? <FileText className="w-5 h-5" /> :
         isEbookMimeType(attachment.mediaType) ? <BookOpen className="w-5 h-5" /> :
         isDocumentMimeType(attachment.mediaType) ? <FileText className="w-5 h-5" /> :
         isArchiveMimeType(attachment.mediaType) ? <Archive className="w-5 h-5" /> :
         <File className="w-5 h-5" />}
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
      <Download className="w-4 h-4 text-fluux-muted opacity-0 group-hover/file:opacity-100 transition-opacity flex-shrink-0" />
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
