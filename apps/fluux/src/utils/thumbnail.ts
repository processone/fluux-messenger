/**
 * Thumbnail and preview generation utilities for file uploads.
 * Generates smaller preview images for XEP-0264 thumbnails.
 * Supports images, videos, and audio files.
 */

export interface ThumbnailResult {
  blob: Blob
  width: number
  height: number
  mediaType: string
}

/** Maximum dimension for thumbnails (width or height) */
const THUMBNAIL_MAX_SIZE = 512

/** JPEG quality for thumbnails (0-1) */
const THUMBNAIL_QUALITY = 0.7

/**
 * Get file extension from filename (lowercase).
 */
function getFileExtension(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  return ext || ''
}

/**
 * MIME type map for common media file extensions.
 * Used as fallback when browser doesn't detect MIME type correctly.
 */
const MIME_TYPE_MAP: Record<string, string> = {
  // Audio
  'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'ogg': 'audio/ogg',
  'oga': 'audio/ogg', 'flac': 'audio/flac', 'm4a': 'audio/mp4',
  'aac': 'audio/aac', 'wma': 'audio/x-ms-wma', 'opus': 'audio/opus',
  'weba': 'audio/webm', 'aif': 'audio/aiff', 'aiff': 'audio/aiff',
  'mid': 'audio/midi', 'midi': 'audio/midi', 'caf': 'audio/x-caf',
  // Video
  'mp4': 'video/mp4', 'webm': 'video/webm', 'mov': 'video/quicktime',
  'avi': 'video/x-msvideo', 'mkv': 'video/x-matroska', 'm4v': 'video/mp4',
  'wmv': 'video/x-ms-wmv', '3gp': 'video/3gpp', 'ogv': 'video/ogg',
  // Images
  'jpg': 'image/jpeg', 'jpeg': 'image/jpeg', 'png': 'image/png',
  'gif': 'image/gif', 'webp': 'image/webp', 'bmp': 'image/bmp',
  'svg': 'image/svg+xml',
  // Documents
  'pdf': 'application/pdf',
  'doc': 'application/msword',
  'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'xls': 'application/vnd.ms-excel',
  'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'ppt': 'application/vnd.ms-powerpoint',
  'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'rtf': 'application/rtf',
  // Ebooks
  'epub': 'application/epub+zip',
  // Archives
  'zip': 'application/zip',
  'rar': 'application/vnd.rar',
  '7z': 'application/x-7z-compressed',
  'tar': 'application/x-tar',
  'gz': 'application/gzip',
  // Text/Code files
  'txt': 'text/plain',
  'md': 'text/markdown',
  'json': 'application/json',
  'xml': 'application/xml',
  'csv': 'text/csv',
  'log': 'text/plain',
  'yml': 'text/yaml',
  'yaml': 'text/yaml',
  'ini': 'text/plain',
  'cfg': 'text/plain',
  'conf': 'text/plain',
  'sh': 'text/x-shellscript',
  'bash': 'text/x-shellscript',
  'zsh': 'text/x-shellscript',
  'js': 'text/javascript',
  'ts': 'text/typescript',
  'jsx': 'text/javascript',
  'tsx': 'text/typescript',
  'css': 'text/css',
  'html': 'text/html',
  'htm': 'text/html',
  'py': 'text/x-python',
  'rb': 'text/x-ruby',
  'rs': 'text/x-rust',
  'go': 'text/x-go',
  'java': 'text/x-java',
  'c': 'text/x-c',
  'cpp': 'text/x-c++',
  'h': 'text/x-c',
  'hpp': 'text/x-c++',
  'swift': 'text/x-swift',
  'kt': 'text/x-kotlin',
  'sql': 'text/x-sql',
  'toml': 'text/x-toml',
}

/**
 * Get effective MIME type for a file.
 * Uses browser-detected type if valid, otherwise falls back to extension lookup.
 */
export function getEffectiveMimeType(file: File): string {
  // Browser detected type takes priority if it's specific (not application/octet-stream)
  if (file.type && file.type !== 'application/octet-stream' && !file.type.startsWith('application/')) {
    return file.type
  }

  // Fall back to extension-based detection
  const ext = getFileExtension(file.name)
  return MIME_TYPE_MAP[ext] || file.type || 'application/octet-stream'
}

/**
 * Check if a file is an image based on MIME type.
 */
export function isImageFile(file: File): boolean {
  return getEffectiveMimeType(file).startsWith('image/')
}

/**
 * Generate a thumbnail from an image file.
 * Resizes to max 512px on longest side, converts to JPEG.
 *
 * @param file - The image file to generate thumbnail from
 * @returns Thumbnail blob with dimensions, or null if generation fails
 */
export async function generateThumbnail(file: File): Promise<ThumbnailResult | null> {
  if (!isImageFile(file)) {
    return null
  }

  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)

      // Calculate thumbnail dimensions maintaining aspect ratio
      let width = img.width
      let height = img.height

      if (width > height) {
        if (width > THUMBNAIL_MAX_SIZE) {
          height = Math.round((height * THUMBNAIL_MAX_SIZE) / width)
          width = THUMBNAIL_MAX_SIZE
        }
      } else {
        if (height > THUMBNAIL_MAX_SIZE) {
          width = Math.round((width * THUMBNAIL_MAX_SIZE) / height)
          height = THUMBNAIL_MAX_SIZE
        }
      }

      // Create canvas and draw resized image
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        resolve(null)
        return
      }

      // Use better quality scaling
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, width, height)

      // Convert to JPEG blob
      canvas.toBlob(
        (blob) => {
          if (blob) {
            resolve({
              blob,
              width,
              height,
              mediaType: 'image/jpeg',
            })
          } else {
            resolve(null)
          }
        },
        'image/jpeg',
        THUMBNAIL_QUALITY
      )
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }

    img.src = url
  })
}

/**
 * Get image dimensions from a file without loading the full image.
 *
 * @param file - The image file
 * @returns Dimensions object or null if not an image
 */
export async function getImageDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (!isImageFile(file)) {
    return null
  }

  return new Promise((resolve) => {
    const img = new Image()
    const url = URL.createObjectURL(file)

    img.onload = () => {
      URL.revokeObjectURL(url)
      resolve({ width: img.width, height: img.height })
    }

    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }

    img.src = url
  })
}

/**
 * Check if a file is a video based on MIME type.
 */
export function isVideoFile(file: File): boolean {
  return getEffectiveMimeType(file).startsWith('video/')
}

/**
 * Check if a file is audio based on MIME type.
 */
export function isAudioFile(file: File): boolean {
  return getEffectiveMimeType(file).startsWith('audio/')
}

/**
 * Check if a file is a media file (image, video, or audio).
 */
export function isMediaFile(file: File): boolean {
  return isImageFile(file) || isVideoFile(file) || isAudioFile(file)
}

/**
 * Generate a thumbnail from a video file.
 * Captures a frame at 1 second (or 10% of duration for short videos).
 *
 * @param file - The video file to generate thumbnail from
 * @returns Thumbnail blob with dimensions, or null if generation fails
 */
export async function generateVideoThumbnail(file: File): Promise<ThumbnailResult | null> {
  if (!isVideoFile(file)) {
    return null
  }

  return new Promise((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)

    video.preload = 'metadata'
    video.muted = true
    video.playsInline = true

    video.onloadedmetadata = () => {
      // Seek to 1 second or 10% of duration, whichever is smaller
      const seekTime = Math.min(1, video.duration * 0.1)
      video.currentTime = seekTime
    }

    video.onseeked = () => {
      // Calculate thumbnail dimensions maintaining aspect ratio
      let width = video.videoWidth
      let height = video.videoHeight

      if (width > height) {
        if (width > THUMBNAIL_MAX_SIZE) {
          height = Math.round((height * THUMBNAIL_MAX_SIZE) / width)
          width = THUMBNAIL_MAX_SIZE
        }
      } else {
        if (height > THUMBNAIL_MAX_SIZE) {
          width = Math.round((width * THUMBNAIL_MAX_SIZE) / height)
          height = THUMBNAIL_MAX_SIZE
        }
      }

      // Create canvas and draw video frame
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height

      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        resolve(null)
        return
      }

      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(video, 0, 0, width, height)

      // Convert to JPEG blob
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url)
          if (blob) {
            resolve({
              blob,
              width,
              height,
              mediaType: 'image/jpeg',
            })
          } else {
            resolve(null)
          }
        },
        'image/jpeg',
        THUMBNAIL_QUALITY
      )
    }

    video.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }

    video.src = url
  })
}

/**
 * Get video duration in seconds.
 *
 * @param file - The video file
 * @returns Duration in seconds, or null if not a video
 */
export async function getVideoDuration(file: File): Promise<number | null> {
  if (!isVideoFile(file)) {
    return null
  }

  return new Promise((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)

    video.preload = 'metadata'
    video.muted = true

    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve(video.duration)
    }

    video.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }

    video.src = url
  })
}

/**
 * Get video dimensions (width and height).
 *
 * @param file - The video file
 * @returns Dimensions object or null if not a video
 */
export async function getVideoDimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (!isVideoFile(file)) {
    return null
  }

  return new Promise((resolve) => {
    const video = document.createElement('video')
    const url = URL.createObjectURL(file)

    video.preload = 'metadata'
    video.muted = true

    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve({ width: video.videoWidth, height: video.videoHeight })
    }

    video.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }

    video.src = url
  })
}

/**
 * Get audio duration in seconds.
 *
 * @param file - The audio file
 * @returns Duration in seconds, or null if not an audio file
 */
export async function getAudioDuration(file: File): Promise<number | null> {
  if (!isAudioFile(file)) {
    return null
  }

  return new Promise((resolve) => {
    const audio = document.createElement('audio')
    const url = URL.createObjectURL(file)

    audio.preload = 'metadata'

    audio.onloadedmetadata = () => {
      URL.revokeObjectURL(url)
      resolve(audio.duration)
    }

    audio.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }

    audio.src = url
  })
}

/**
 * Check if a file is a PDF based on MIME type.
 */
export function isPdfFile(file: File): boolean {
  return getEffectiveMimeType(file) === 'application/pdf'
}

/**
 * Check if a MIME type represents a PDF.
 */
export function isPdfMimeType(mimeType: string | undefined): boolean {
  return mimeType === 'application/pdf'
}

/**
 * Check if a MIME type represents any document type (PDF, Word, Excel, etc.).
 */
export function isDocumentMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  return mimeType === 'application/pdf' ||
    mimeType === 'application/msword' ||
    mimeType.includes('officedocument') ||
    mimeType === 'application/rtf' ||
    mimeType === 'text/plain'
}

/**
 * Check if a MIME type represents an archive file.
 */
export function isArchiveMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  return mimeType === 'application/zip' ||
    mimeType === 'application/vnd.rar' ||
    mimeType === 'application/x-7z-compressed' ||
    mimeType === 'application/x-tar' ||
    mimeType === 'application/gzip'
}

/**
 * Check if a MIME type represents an ebook file.
 */
export function isEbookMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  return mimeType === 'application/epub+zip'
}

/**
 * Get a human-readable file type label for display.
 */
export function getFileTypeLabel(mimeType: string | undefined): string {
  if (!mimeType) return 'File'

  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType === 'application/msword' || mimeType.includes('wordprocessingml')) return 'Word'
  if (mimeType === 'application/vnd.ms-excel' || mimeType.includes('spreadsheetml')) return 'Excel'
  if (mimeType === 'application/vnd.ms-powerpoint' || mimeType.includes('presentationml')) return 'PowerPoint'
  if (mimeType === 'text/plain') return 'Text'
  if (mimeType === 'application/rtf') return 'RTF'
  if (mimeType === 'application/zip') return 'ZIP'
  if (mimeType === 'application/vnd.rar') return 'RAR'
  if (mimeType === 'application/x-7z-compressed') return '7Z'
  if (mimeType === 'application/x-tar' || mimeType === 'application/gzip') return 'Archive'
  if (mimeType === 'application/epub+zip') return 'EPUB'

  return 'File'
}

/**
 * Text-based MIME types that can be previewed inline.
 */
const TEXT_MIME_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/css',
  'text/html',
  'text/xml',
  'text/yaml',
  'text/javascript',
  'text/typescript',
  'text/x-python',
  'text/x-ruby',
  'text/x-rust',
  'text/x-go',
  'text/x-java',
  'text/x-c',
  'text/x-c++',
  'text/x-swift',
  'text/x-kotlin',
  'text/x-sql',
  'text/x-toml',
  'text/x-shellscript',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
])

/**
 * File extensions that are text-based and can be previewed.
 */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'xml', 'csv', 'log',
  'yml', 'yaml', 'ini', 'cfg', 'conf', 'env',
  'sh', 'bash', 'zsh', 'fish',
  'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
  'css', 'scss', 'sass', 'less',
  'html', 'htm', 'svg',
  'py', 'pyw', 'rb', 'rs', 'go', 'java', 'kt', 'kts',
  'c', 'cpp', 'cc', 'cxx', 'h', 'hpp', 'hxx',
  'swift', 'm', 'mm',
  'erl', 'hrl', 'ex', 'exs',  // Erlang and Elixir
  'sql', 'toml', 'lock',
  'gitignore', 'dockerignore', 'editorconfig',
  'makefile', 'dockerfile',
])

/**
 * Check if a MIME type represents a text-based file that can be previewed.
 */
export function isTextMimeType(mimeType: string | undefined): boolean {
  if (!mimeType) return false
  // Check exact match first
  if (TEXT_MIME_TYPES.has(mimeType)) return true
  // Check if it starts with text/
  if (mimeType.startsWith('text/')) return true
  return false
}

/**
 * Check if a filename has a text-based extension that can be previewed.
 */
export function isTextFileByExtension(filename: string | undefined): boolean {
  if (!filename) return false
  const ext = filename.split('.').pop()?.toLowerCase()
  if (!ext) {
    // Handle extensionless files like Makefile, Dockerfile
    const basename = filename.split('/').pop()?.toLowerCase() || ''
    return TEXT_EXTENSIONS.has(basename)
  }
  return TEXT_EXTENSIONS.has(ext)
}

/**
 * Check if a file attachment can be previewed as text.
 * Uses both MIME type and extension for detection.
 */
export function canPreviewAsText(mimeType: string | undefined, filename: string | undefined): boolean {
  return isTextMimeType(mimeType) || isTextFileByExtension(filename)
}
