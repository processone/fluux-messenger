import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useXMPP, type FileAttachment, type ThumbnailInfo } from '@fluux/sdk'
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
  const requestUploadSlot = useCallback(
    (filename: string, size: number, contentType: string) => {
      return client.discovery.requestUploadSlot(filename, size, contentType)
    },
    [client]
  )
  const [state, setState] = useState<UploadState>({
    isUploading: false,
    progress: 0,
    error: null,
  })

  const clearError = useCallback(() => {
    setState(s => ({ ...s, error: null }))
  }, [])

  /**
   * Upload a file with optional thumbnail and duration extraction.
   * - Images: generates and uploads thumbnail
   * - Videos: generates thumbnail and extracts duration
   * - Audio: extracts duration
   * Returns FileAttachment with URL, thumbnail info, and duration, or null on failure.
   */
  const uploadFile = useCallback(async (file: File): Promise<FileAttachment | null> => {
    console.log('[uploadFile] Starting upload for:', file.name, 'isTauri:', isTauri())

    if (!httpUploadService) {
      console.error('[uploadFile] HTTP upload not supported')
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

      // 1. Request upload slot for main file
      const effectiveMimeType = getEffectiveMimeType(file)
      const slot = await requestUploadSlot(
        file.name,
        file.size,
        effectiveMimeType
      )

      // 2. Upload main file via HTTP PUT with progress
      await uploadWithProgress(slot.putUrl, file, effectiveMimeType, slot.headers, (progress) => {
        mainProgress = progress
        updateProgress()
      })

      // 3. Upload thumbnail if generated
      let thumbnailInfo: ThumbnailInfo | undefined
      if (thumbnailResult) {
        const thumbFilename = `thumb_${file.name.replace(/\.[^.]+$/, '')}.jpg`
        const thumbSlot = await requestUploadSlot(
          thumbFilename,
          thumbnailResult.blob.size,
          thumbnailResult.mediaType
        )

        await uploadWithProgress(
          thumbSlot.putUrl,
          new File([thumbnailResult.blob], thumbFilename, { type: thumbnailResult.mediaType }),
          thumbnailResult.mediaType,
          thumbSlot.headers,
          (progress) => {
            thumbProgress = progress
            updateProgress()
          }
        )

        thumbnailInfo = {
          uri: thumbSlot.getUrl,
          mediaType: thumbnailResult.mediaType,
          width: thumbnailResult.width,
          height: thumbnailResult.height,
        }
      }

      setState({ isUploading: false, progress: 100, error: null })

      return {
        url: slot.getUrl,
        name: file.name,
        size: file.size,
        mediaType: effectiveMimeType,
        width,
        height,
        thumbnail: thumbnailInfo,
        duration,
      }
    } catch (err) {
      console.error('[uploadFile] Error during upload:', err)
      const message = err instanceof Error ? err.message : t('upload.failed')
      setState({ isUploading: false, progress: 0, error: message })
      return null
    }
  }, [httpUploadService, requestUploadSlot, t])

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

  console.log('[uploadWithTauri] Starting upload to:', url)
  console.log('[uploadWithTauri] File:', file.name, 'size:', file.size, 'type:', contentType)

  // Read file as Uint8Array for Tauri fetch
  // Note: Tauri's fetch expects Uint8Array, not ArrayBuffer
  const arrayBuffer = await file.arrayBuffer()
  const body = new Uint8Array(arrayBuffer)

  console.log('[uploadWithTauri] Body prepared, length:', body.length)

  // Build headers
  const requestHeaders: Record<string, string> = {
    'Content-Type': contentType,
    ...headers,
  }

  console.log('[uploadWithTauri] Headers:', requestHeaders)

  // Tauri fetch doesn't support progress, simulate it
  onProgress?.(50)

  try {
    const response = await fetch(url, {
      method: 'PUT',
      headers: requestHeaders,
      body,
    })

    console.log('[uploadWithTauri] Response status:', response.status)

    if (!response.ok) {
      const responseText = await response.text()
      console.error('[uploadWithTauri] Upload failed:', response.status, responseText)
      throw new Error(`Upload failed: ${response.status}`)
    }

    console.log('[uploadWithTauri] Upload successful')
    onProgress?.(100)
  } catch (err) {
    console.error('[uploadWithTauri] Fetch error:', err)
    throw err
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
