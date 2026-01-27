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
  getEffectiveMimeType,
  type ThumbnailResult,
} from '@/utils/thumbnail'

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
      let thumbnailResult: ThumbnailResult | null = null
      let duration: number | undefined

      if (isImageFile(file)) {
        thumbnailResult = await generateThumbnail(file)
      } else if (isVideoFile(file)) {
        // Generate video thumbnail and extract duration in parallel
        const [thumbResult, videoDuration] = await Promise.all([
          generateVideoThumbnail(file),
          getVideoDuration(file),
        ])
        thumbnailResult = thumbResult
        if (videoDuration !== null) {
          duration = videoDuration
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
        thumbnail: thumbnailInfo,
        duration,
      }
    } catch (err) {
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
 * Upload file with XMLHttpRequest for progress tracking.
 */
async function uploadWithProgress(
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
