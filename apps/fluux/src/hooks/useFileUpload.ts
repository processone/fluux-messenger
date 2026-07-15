import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  useXMPP,
  encryptFile,
  type FileAttachment,
  type FileEncryption,
  type ThumbnailInfo,
  type UploadSlot,
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
import { isTauri } from '@/utils/tauri'
import { uploadFileTauri } from '@/utils/tauriUpload'
import { createUploadProgressReporter } from './uploadProgressReporter'

/** WebCrypto/aes-gcm append a 128-bit auth tag, so ciphertext = plaintext + 16. */
const GCM_TAG_BYTES = 16

interface UploadState {
  isUploading: boolean
  progress: number  // 0-100
  error: string | null
}

export type { FileAttachment, ThumbnailInfo }

type RequestSlot = (filename: string, size: number, contentType: string) => Promise<UploadSlot>

interface SlotUploadOutcome {
  /** Plain HTTPS URL of the uploaded (cipher)text. */
  getUrl: string
  /** AES-GCM params when the blob was encrypted before upload. */
  encryption?: FileEncryption
}

/**
 * Upload one blob through an XEP-0363 slot, optionally AES-256-GCM-encrypted
 * (XEP-0454). Shared by the main file and its thumbnail.
 *
 * Encrypted uploads never leak the original filename/mimetype to the upload
 * server — the real ones ride inside the encrypted `<file-metadata/>` — and
 * the slot is requested with the CIPHERTEXT size (plaintext + GCM tag) so
 * the server's size limit applies to what actually goes on the wire.
 *
 * Transport is platform-split:
 * - Desktop: the Rust `upload_file` command receives the plaintext bytes as
 *   Tauri's raw IPC body and does encryption + PUT natively. Do NOT use
 *   `@tauri-apps/plugin-http` here — its JS shim turns the body into a
 *   number array and JSON-serializes it, which blocks the main thread ~1s
 *   for a 40MB file (the `[MainThreadStall]` class).
 * - Web: WebCrypto encryption + XHR PUT; the browser streams the body off
 *   the main thread.
 */
async function uploadBlobViaSlot(
  blob: Blob,
  filename: string,
  mimeType: string,
  encrypt: boolean,
  requestSlot: RequestSlot,
  onProgress: (percent: number) => void,
): Promise<SlotUploadOutcome> {
  const uploadFilename = encrypt ? `${crypto.randomUUID()}.bin` : filename
  const uploadMimeType = encrypt ? 'application/octet-stream' : mimeType
  const uploadSize = encrypt ? blob.size + GCM_TAG_BYTES : blob.size

  const slot = await requestSlot(uploadFilename, uploadSize, uploadMimeType)

  if (isTauri()) {
    const encryption = await uploadFileTauri({
      bytes: await blob.arrayBuffer(),
      putUrl: slot.putUrl,
      contentType: uploadMimeType,
      headers: slot.headers,
      encrypt,
      onProgress,
    })
    return { getUrl: slot.getUrl, encryption }
  }

  let uploadBlob = blob
  let encryption: FileEncryption | undefined
  if (encrypt) {
    // Each call generates a fresh key + IV; reuse would be catastrophic
    // for GCM.
    const enc = await encryptFile(new Uint8Array(await blob.arrayBuffer()))
    encryption = { cipher: 'aes-256-gcm', key: enc.key, iv: enc.iv }
    uploadBlob = new Blob([enc.ciphertext as BlobPart], { type: uploadMimeType })
  }
  await uploadWithXHR(
    slot.putUrl,
    new File([uploadBlob], uploadFilename, { type: uploadMimeType }),
    uploadMimeType,
    slot.headers,
    onProgress,
  )
  return { getUrl: slot.getUrl, encryption }
}

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
  // Get requestUploadSlot from client. Memoized on `client` (stable React
  // context value) so it doesn't churn the `uploadFile` callback below.
  const requestUploadSlot = useCallback(
    (filename: string, size: number, contentType: string) => {
      return client.discovery.requestUploadSlot(filename, size, contentType)
    },
    [client],
  )
  const [state, setState] = useState<UploadState>({
    isUploading: false,
    progress: 0,
    error: null,
  })

  // `setState` from useState is stable, so no deps are needed here.
  const clearError = useCallback(() => {
    setState(s => ({ ...s, error: null }))
  }, [])

  /**
   * Upload a file with optional thumbnail and duration extraction.
   * - Images: generates and uploads thumbnail
   * - Videos: generates thumbnail and extracts duration
   * - Audio: extracts duration
   *
   * When `encrypt` is true the file bytes (and thumbnail bytes, if any)
   * are AES-256-GCM-encrypted before HTTP Upload. The returned
   * `FileAttachment.url` is the HTTPS URL of the ciphertext, and
   * `encryption` carries the per-file key/IV — the SDK's Chat module then
   * embeds an `aesgcm://` URI inside the E2EE `<payload/>` so the XMPP
   * server never sees the key.
   *
   * Returns FileAttachment with URL, thumbnail info, duration, and
   * optional encryption metadata, or null on failure.
   */
  const uploadFile = useCallback(async (file: File, options?: { encrypt?: boolean }): Promise<FileAttachment | null> => {
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

      // Combine main-file + optional-thumbnail progress into one size-weighted
      // percent. The reporter only fires when the rounded percent changes, so a
      // fast upload can't re-render the conversation pane once per progress
      // event (same render-storm class as issue #994).
      const thumbnailSize = thumbnailResult?.blob.size || 0
      const progressReporter = createUploadProgressReporter(
        file.size,
        thumbnailSize,
        overall => setState(s => ({ ...s, progress: overall })),
      )

      const effectiveMimeType = getEffectiveMimeType(file)
      const main = await uploadBlobViaSlot(
        file,
        file.name,
        effectiveMimeType,
        shouldEncrypt,
        requestUploadSlot,
        (progress) => progressReporter.setMain(progress),
      )

      // Upload thumbnail if generated. Encrypted attachments get an
      // encrypted thumbnail too — a plaintext thumbnail would leak a
      // preview of the very file we just protected.
      let thumbnailInfo: ThumbnailInfo | undefined
      if (thumbnailResult) {
        const thumbFilename = `thumb_${file.name.replace(/\.[^.]+$/, '')}.jpg`
        const thumb = await uploadBlobViaSlot(
          thumbnailResult.blob,
          thumbFilename,
          thumbnailResult.mediaType,
          shouldEncrypt,
          requestUploadSlot,
          (progress) => progressReporter.setThumbnail(progress),
        )

        // Store plain HTTPS URL locally; encryption params ride in a
        // separate field. Chat.ts converts to `aesgcm://` only when
        // building the outgoing stanza's OOB thumbnail attribute.
        thumbnailInfo = {
          uri: thumb.getUrl,
          mediaType: thumbnailResult.mediaType,
          width: thumbnailResult.width,
          height: thumbnailResult.height,
          ...(thumb.encryption && { encryption: thumb.encryption }),
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
        url: main.getUrl,
        name: file.name,
        size: file.size,
        mediaType: effectiveMimeType,
        width,
        height,
        thumbnail: thumbnailInfo,
        duration,
        ...(main.encryption && { encryption: main.encryption }),
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : t('upload.failed')
      setState({ isUploading: false, progress: 0, error: message })
      return null
    }
  }, [httpUploadService, t, requestUploadSlot])

  return {
    ...state,
    uploadFile,
    clearError,
    isSupported: !!httpUploadService,
    maxFileSize: httpUploadService?.maxFileSize,
  }
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
 * Format bytes to human readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}
