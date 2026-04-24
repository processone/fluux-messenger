import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useXMPP,
  encryptFile,
  type FileAttachment,
  type FileEncryption,
  type ThumbnailInfo,
} from '@fluux/sdk'
import { useConnectionStore } from '@fluux/sdk/react'
import {
  generateThumbnail,
  generateVideoThumbnail,
  isImageFile,
  isVideoFile,
  isAudioFile,
  getVideoDuration,
  getAudioDuration,
  getImageDimensions,
  getVideoDimensions,
  getEffectiveMimeType,
  type ThumbnailResult,
} from '@/utils/thumbnail'

/**
 * Check if running in Tauri dynamically.
 * IMPORTANT: Must be checked at call time, not module load time,
 * because __TAURI_INTERNALS__ may not be available when the module first loads.
 */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

interface UploadState {
  isUploading: boolean
  progress: number  // 0-100
  error: string | null
}

export type { FileAttachment, ThumbnailInfo }

/**
 * Hook for uploading files via XEP-0363 HTTP File Upload.
 * Returns upload state and functions for file upload.
 */
export function useFileUpload() {
  const { t } = useTranslation()
  // Get client from context for methods (avoiding useConnection's 12+ subscriptions)
  const { client } = useXMPP()
  // Use focused selector for httpUploadService (only re-render when it changes)
  const httpUploadService = useConnectionStore((s) => s.httpUploadService)
  // Get requestUploadSlot from client
  const requestUploadSlot = (filename: string, size: number, contentType: string) => {
    return client.discovery.requestUploadSlot(filename, size, contentType)
  }
  const [state, setState] = useState<UploadState>({
    isUploading: false,
    progress: 0,
    error: null,
  })

  const clearError = () => {
    setState(s => ({ ...s, error: null }))
  }

  /**
   * Upload a file with optional thumbnail and duration extraction.
   * - Images: generates and uploads thumbnail
   * - Videos: generates thumbnail and extracts duration
   * - Audio: extracts duration
   *
   * When `encrypt` is true the file bytes (and thumbnail bytes, if any)
   * are AES-256-GCM-encrypted client-side before HTTP Upload. The returned
   * `FileAttachment.url` is the HTTPS URL of the ciphertext, and
   * `encryption` carries the per-file key/IV — the SDK's Chat module then
   * embeds an `aesgcm://` URI inside the E2EE `<payload/>` so the XMPP
   * server never sees the key. Each call generates fresh key + IV; reuse
   * would be catastrophic for GCM.
   *
   * Returns FileAttachment with URL, thumbnail info, duration, and
   * optional encryption metadata, or null on failure.
   */
  const uploadFile = async (file: File, options?: { encrypt?: boolean }): Promise<FileAttachment | null> => {
    const shouldEncrypt = options?.encrypt === true
    if (!httpUploadService) {
      setState(s => ({ ...s, error: t('upload.notSupported') }))
      return null
    }

    // Check file size
    if (httpUploadService.maxFileSize && file.size > httpUploadService.maxFileSize) {
      const maxMB = Math.round(httpUploadService.maxFileSize / 1024 / 1024)
      setState(s => ({ ...s, error: t('upload.fileTooLarge', { max: maxMB }) }))
      return null
    }

    setState({ isUploading: true, progress: 0, error: null })

    try {
      // Generate thumbnail for images and videos (non-blocking, can fail silently)
      // Also extract original dimensions for XEP-0446 file metadata
      let thumbnailResult: ThumbnailResult | null = null
      let duration: number | undefined
      let width: number | undefined
      let height: number | undefined

      if (isImageFile(file)) {
        // Extract thumbnail and original dimensions in parallel
        const [thumbResult, dimensions] = await Promise.all([
          generateThumbnail(file),
          getImageDimensions(file),
        ])
        thumbnailResult = thumbResult
        if (dimensions) {
          width = dimensions.width
          height = dimensions.height
        }
      } else if (isVideoFile(file)) {
        // Generate video thumbnail, extract duration and dimensions in parallel
        const [thumbResult, videoDuration, dimensions] = await Promise.all([
          generateVideoThumbnail(file),
          getVideoDuration(file),
          getVideoDimensions(file),
        ])
        thumbnailResult = thumbResult
        if (videoDuration !== null) {
          duration = videoDuration
        }
        if (dimensions) {
          width = dimensions.width
          height = dimensions.height
        }
      } else if (isAudioFile(file)) {
        // Extract audio duration
        const audioDuration = await getAudioDuration(file)
        if (audioDuration !== null) {
          duration = audioDuration
        }
      }

      // Calculate total upload size for progress (main file + optional thumbnail)
      const thumbnailSize = thumbnailResult?.blob.size || 0
      const totalSize = file.size + thumbnailSize
      let mainProgress = 0
      let thumbProgress = 0

      const updateProgress = () => {
        // Weight progress by size
        const mainWeight = file.size / totalSize
        const thumbWeight = thumbnailSize / totalSize
        const overall = Math.round(mainProgress * mainWeight + thumbProgress * thumbWeight)
        setState(s => ({ ...s, progress: overall }))
      }

      // 1. Prepare main file bytes — encrypted or plaintext depending on mode.
      // When encrypting we PUT the ciphertext (plaintext_len + 16-byte GCM
      // tag) and store the key/IV in `encryption` for the downstream stanza
      // assembly. The XEP-0363 slot is requested with the CIPHERTEXT size
      // so the server's size limit applies to what actually goes on the wire.
      const effectiveMimeType = getEffectiveMimeType(file)
      let mainEncryption: FileEncryption | undefined
      let mainUploadBlob: Blob = file
      let mainUploadMimeType = effectiveMimeType
      let mainUploadFilename = file.name
      let mainUploadSize = file.size
      if (shouldEncrypt) {
        const plaintextBytes = new Uint8Array(await file.arrayBuffer())
        const enc = await encryptFile(plaintextBytes)
        mainEncryption = { cipher: 'aes-256-gcm', key: enc.key, iv: enc.iv }
        mainUploadBlob = new Blob([enc.ciphertext as BlobPart], { type: 'application/octet-stream' })
        // Don't leak the original filename / mimetype via HTTP Upload — the
        // real name/mimetype ride inside the encrypted `<file-metadata/>`.
        mainUploadMimeType = 'application/octet-stream'
        mainUploadFilename = `${crypto.randomUUID()}.bin`
        mainUploadSize = enc.ciphertext.byteLength
      }
      const slot = await requestUploadSlot(
        mainUploadFilename,
        mainUploadSize,
        mainUploadMimeType,
      )

      // 2. Upload main file (ciphertext or plaintext) via HTTP PUT with progress.
      await uploadWithProgress(
        slot.putUrl,
        new File([mainUploadBlob], mainUploadFilename, { type: mainUploadMimeType }),
        mainUploadMimeType,
        slot.headers,
        (progress) => {
          mainProgress = progress
          updateProgress()
        },
      )

      // 3. Upload thumbnail if generated. Encrypted attachments get an
      // encrypted thumbnail too — a plaintext thumbnail would leak a
      // preview of the very file we just protected.
      let thumbnailInfo: ThumbnailInfo | undefined
      if (thumbnailResult) {
        let thumbBytes: Uint8Array
        let thumbUploadMime: string
        let thumbFilename: string
        let thumbEncryption: FileEncryption | undefined
        if (shouldEncrypt) {
          const thumbPlain = new Uint8Array(await thumbnailResult.blob.arrayBuffer())
          const enc = await encryptFile(thumbPlain)
          thumbBytes = enc.ciphertext
          thumbEncryption = { cipher: 'aes-256-gcm', key: enc.key, iv: enc.iv }
          thumbUploadMime = 'application/octet-stream'
          thumbFilename = `${crypto.randomUUID()}.bin`
        } else {
          thumbBytes = new Uint8Array(await thumbnailResult.blob.arrayBuffer())
          thumbUploadMime = thumbnailResult.mediaType
          thumbFilename = `thumb_${file.name.replace(/\.[^.]+$/, '')}.jpg`
        }

        const thumbSlot = await requestUploadSlot(
          thumbFilename,
          thumbBytes.byteLength,
          thumbUploadMime,
        )

        await uploadWithProgress(
          thumbSlot.putUrl,
          new File([thumbBytes as BlobPart], thumbFilename, { type: thumbUploadMime }),
          thumbUploadMime,
          thumbSlot.headers,
          (progress) => {
            thumbProgress = progress
            updateProgress()
          },
        )

        // Store plain HTTPS URL locally; encryption params ride in a
        // separate field. Chat.ts converts to `aesgcm://` only when
        // building the outgoing stanza's OOB thumbnail attribute.
        thumbnailInfo = {
          uri: thumbSlot.getUrl,
          mediaType: thumbnailResult.mediaType,
          width: thumbnailResult.width,
          height: thumbnailResult.height,
          ...(thumbEncryption && { encryption: thumbEncryption }),
        }
      }

      setState({ isUploading: false, progress: 100, error: null })

      // `url` is always the plain HTTPS URL of the (cipher)text on the
      // upload server. Encryption params ride in `encryption`. Chat.ts
      // converts this to an `aesgcm://` URI only at stanza-assembly time,
      // where the URI goes inside the OpenPGP `<payload/>`. Keeping the
      // local form separate means UI code can fetch the URL directly and
      // renderers reason about encryption as an explicit field.
      return {
        url: slot.getUrl,
        name: file.name,
        size: file.size,
        mediaType: effectiveMimeType,
        width,
        height,
        thumbnail: thumbnailInfo,
        duration,
        ...(mainEncryption && { encryption: mainEncryption }),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('upload.failed')
      setState({ isUploading: false, progress: 0, error: message })
      return null
    }
  }

  return {
    ...state,
    uploadFile,
    clearError,
    isSupported: !!httpUploadService,
    maxFileSize: httpUploadService?.maxFileSize,
  }
}

/**
 * Upload file using Tauri's HTTP plugin (bypasses CORS).
 * Progress tracking is not available with Tauri's fetch.
 */
async function uploadWithTauri(
  url: string,
  file: File,
  contentType: string,
  headers?: Record<string, string>,
  onProgress?: (progress: number) => void
): Promise<void> {
  // Dynamic import to avoid bundling Tauri code in web builds
  const { fetch } = await import('@tauri-apps/plugin-http')

  // Read file as Uint8Array for Tauri fetch
  // Note: Tauri's fetch expects Uint8Array, not ArrayBuffer
  const arrayBuffer = await file.arrayBuffer()
  const body = new Uint8Array(arrayBuffer)

  // Build headers
  const requestHeaders: Record<string, string> = {
    'Content-Type': contentType,
    ...headers,
  }

  // Tauri fetch doesn't support progress, simulate it
  onProgress?.(50)

  const response = await fetch(url, {
    method: 'PUT',
    headers: requestHeaders,
    body,
  })

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`)
  }

  onProgress?.(100)
}

/**
 * Upload file with XMLHttpRequest for progress tracking (web only).
 */
async function uploadWithXHR(
  url: string,
  file: File,
  contentType: string,
  headers?: Record<string, string>,
  onProgress?: (progress: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress?.(Math.round((e.loaded / e.total) * 100))
      }
    }

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(new Error(`Upload failed: ${xhr.status}`))
      }
    }

    xhr.onerror = () => {
      reject(new Error('Network error during upload'))
    }

    xhr.ontimeout = () => {
      reject(new Error('Upload timed out'))
    }

    xhr.open('PUT', url)

    // Set headers from upload slot
    if (headers) {
      Object.entries(headers).forEach(([key, value]) => {
        xhr.setRequestHeader(key, value)
      })
    }

    // Set content type
    xhr.setRequestHeader('Content-Type', contentType)

    xhr.send(file)
  })
}

/**
 * Upload file with progress tracking.
 * Uses Tauri HTTP plugin in desktop app (bypasses CORS),
 * falls back to XMLHttpRequest for web.
 */
async function uploadWithProgress(
  url: string,
  file: File,
  contentType: string,
  headers?: Record<string, string>,
  onProgress?: (progress: number) => void
): Promise<void> {
  if (isTauri()) {
    return uploadWithTauri(url, file, contentType, headers, onProgress)
  }
  return uploadWithXHR(url, file, contentType, headers, onProgress)
}

/**
 * Format bytes to human readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}
