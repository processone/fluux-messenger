import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useFileUpload, formatBytes, type FileAttachment } from './useFileUpload'

// Mock SDK
const mockRequestUploadSlot = vi.fn()
let mockHttpUploadService: { jid: string; maxFileSize?: number } | null = null

vi.mock('@fluux/sdk', () => ({
  useXMPP: () => ({
    client: {
      discovery: {
        requestUploadSlot: mockRequestUploadSlot,
      },
    },
  }),
}))

vi.mock('@fluux/sdk/react', () => ({
  useConnectionStore: (selector: (state: { httpUploadService: typeof mockHttpUploadService }) => typeof mockHttpUploadService) => {
    return selector({ httpUploadService: mockHttpUploadService })
  },
}))

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      if (key === 'upload.notSupported') return 'File upload is not supported by this server'
      if (key === 'upload.fileTooLarge') return `File is too large (max ${params?.max}MB)`
      if (key === 'upload.failed') return 'Upload failed'
      return key
    },
  }),
}))

// Mock thumbnail utilities
const mockGenerateThumbnail = vi.fn()
const mockGenerateVideoThumbnail = vi.fn()
const mockIsImageFile = vi.fn()
const mockIsVideoFile = vi.fn()
const mockIsAudioFile = vi.fn()
const mockGetVideoDuration = vi.fn()
const mockGetAudioDuration = vi.fn()
const mockGetImageDimensions = vi.fn()
const mockGetVideoDimensions = vi.fn()
const mockGetEffectiveMimeType = vi.fn()

vi.mock('../utils/thumbnail', () => ({
  generateThumbnail: (...args: unknown[]) => mockGenerateThumbnail(...args),
  generateVideoThumbnail: (...args: unknown[]) => mockGenerateVideoThumbnail(...args),
  isImageFile: (...args: unknown[]) => mockIsImageFile(...args),
  isVideoFile: (...args: unknown[]) => mockIsVideoFile(...args),
  isAudioFile: (...args: unknown[]) => mockIsAudioFile(...args),
  getVideoDuration: (...args: unknown[]) => mockGetVideoDuration(...args),
  getAudioDuration: (...args: unknown[]) => mockGetAudioDuration(...args),
  getImageDimensions: (...args: unknown[]) => mockGetImageDimensions(...args),
  getVideoDimensions: (...args: unknown[]) => mockGetVideoDimensions(...args),
  getEffectiveMimeType: (...args: unknown[]) => mockGetEffectiveMimeType(...args),
}))

// Mock XMLHttpRequest to always succeed immediately
let mockXhrStatus = 200
let mockXhrShouldFail = false
let mockXhrShouldTimeout = false

vi.stubGlobal('XMLHttpRequest', function(this: {
  status: number
  upload: { onprogress: ((e: ProgressEvent) => void) | null }
  onload: (() => void) | null
  onerror: (() => void) | null
  ontimeout: (() => void) | null
  open: ReturnType<typeof vi.fn>
  setRequestHeader: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
}) {
  this.status = mockXhrStatus
  this.upload = { onprogress: null }
  this.onload = null
  this.onerror = null
  this.ontimeout = null
  this.open = vi.fn()
  this.setRequestHeader = vi.fn()
  this.send = vi.fn(() => {
    // Simulate immediate completion
    setTimeout(() => {
      if (mockXhrShouldFail) {
        this.onerror?.()
      } else if (mockXhrShouldTimeout) {
        this.ontimeout?.()
      } else {
        this.status = mockXhrStatus
        this.onload?.()
      }
    }, 0)
  })
})

describe('useFileUpload', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHttpUploadService = {
      jid: 'upload.example.com',
      maxFileSize: 52428800, // 50 MB
    }
    mockXhrStatus = 200
    mockXhrShouldFail = false
    mockXhrShouldTimeout = false
    // Default: not a media file (no thumbnail/duration/dimensions generation)
    mockIsImageFile.mockReturnValue(false)
    mockIsVideoFile.mockReturnValue(false)
    mockIsAudioFile.mockReturnValue(false)
    mockGenerateThumbnail.mockResolvedValue(null)
    mockGenerateVideoThumbnail.mockResolvedValue(null)
    mockGetVideoDuration.mockResolvedValue(null)
    mockGetAudioDuration.mockResolvedValue(null)
    mockGetImageDimensions.mockResolvedValue(null)
    mockGetVideoDimensions.mockResolvedValue(null)
    // Default: return the file's type or application/octet-stream
    mockGetEffectiveMimeType.mockImplementation((file: File) => file.type || 'application/octet-stream')
  })

  describe('initial state', () => {
    it('should return initial state with upload not in progress', () => {
      const { result } = renderHook(() => useFileUpload())

      expect(result.current.isUploading).toBe(false)
      expect(result.current.progress).toBe(0)
      expect(result.current.error).toBeNull()
    })

    it('should indicate upload is supported when service is available', () => {
      const { result } = renderHook(() => useFileUpload())

      expect(result.current.isSupported).toBe(true)
      expect(result.current.maxFileSize).toBe(52428800)
    })

    it('should indicate upload is not supported when service is unavailable', () => {
      mockHttpUploadService = null

      const { result } = renderHook(() => useFileUpload())

      expect(result.current.isSupported).toBe(false)
      expect(result.current.maxFileSize).toBeUndefined()
    })
  })

  describe('uploadFile', () => {
    it('should set error when upload service is not available', async () => {
      mockHttpUploadService = null

      const { result } = renderHook(() => useFileUpload())

      const file = new File(['test'], 'test.txt', { type: 'text/plain' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).toBeNull()
      expect(result.current.error).toBe('File upload is not supported by this server')
      expect(result.current.isUploading).toBe(false)
    })

    it('should set error when file exceeds max size', async () => {
      mockHttpUploadService = {
        jid: 'upload.example.com',
        maxFileSize: 1000, // 1 KB limit
      }

      const { result } = renderHook(() => useFileUpload())

      // Create a file larger than the limit
      const largeContent = 'x'.repeat(2000)
      const file = new File([largeContent], 'large.txt', { type: 'text/plain' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).toBeNull()
      expect(result.current.error).toContain('File is too large')
      expect(result.current.isUploading).toBe(false)
    })

    it('should request upload slot and return FileAttachment on success', async () => {
      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/files/test.txt',
      })

      const { result } = renderHook(() => useFileUpload())

      const file = new File(['test content'], 'test.txt', { type: 'text/plain' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).not.toBeNull()
      expect(uploadResult!.url).toBe('https://upload.example.com/files/test.txt')
      expect(uploadResult!.name).toBe('test.txt')
      expect(uploadResult!.mediaType).toBe('text/plain')
      expect(result.current.isUploading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('should pass correct parameters to requestUploadSlot', async () => {
      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/get/abc123',
      })

      const { result } = renderHook(() => useFileUpload())

      const file = new File(['test content'], 'document.pdf', { type: 'application/pdf' })

      await act(async () => {
        await result.current.uploadFile(file)
      })

      expect(mockRequestUploadSlot).toHaveBeenCalledWith(
        'document.pdf',
        12, // 'test content'.length
        'application/pdf'
      )
    })

    it('should use application/octet-stream for files without type', async () => {
      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/get/abc123',
      })

      const { result } = renderHook(() => useFileUpload())

      // Create file without type
      const file = new File(['data'], 'unknown.bin')

      await act(async () => {
        await result.current.uploadFile(file)
      })

      expect(mockRequestUploadSlot).toHaveBeenCalledWith(
        'unknown.bin',
        4,
        'application/octet-stream'
      )
    })

    it('should handle slot request error', async () => {
      mockRequestUploadSlot.mockRejectedValue(new Error('Service unavailable'))

      const { result } = renderHook(() => useFileUpload())

      const file = new File(['test'], 'test.txt', { type: 'text/plain' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).toBeNull()
      expect(result.current.error).toBe('Service unavailable')
      expect(result.current.isUploading).toBe(false)
      expect(result.current.progress).toBe(0)
    })

    it('should handle XHR network error', async () => {
      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/get/abc123',
      })
      mockXhrShouldFail = true

      const { result } = renderHook(() => useFileUpload())

      const file = new File(['test'], 'test.txt', { type: 'text/plain' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).toBeNull()
      expect(result.current.error).toBe('Network error during upload')
      expect(result.current.isUploading).toBe(false)
    })

    it('should handle XHR HTTP error', async () => {
      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/get/abc123',
      })
      mockXhrStatus = 403

      const { result } = renderHook(() => useFileUpload())

      const file = new File(['test'], 'test.txt', { type: 'text/plain' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).toBeNull()
      expect(result.current.error).toBe('Upload failed: 403')
      expect(result.current.isUploading).toBe(false)
    })

    it('should handle XHR timeout', async () => {
      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/get/abc123',
      })
      mockXhrShouldTimeout = true

      const { result } = renderHook(() => useFileUpload())

      const file = new File(['test'], 'test.txt', { type: 'text/plain' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).toBeNull()
      expect(result.current.error).toBe('Upload timed out')
    })

    it('should allow upload without max file size limit', async () => {
      mockHttpUploadService = {
        jid: 'upload.example.com',
        // No maxFileSize - unlimited
      }

      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/get/abc123',
      })

      const { result } = renderHook(() => useFileUpload())

      // Large file should be allowed when no limit
      const largeContent = 'x'.repeat(100000)
      const file = new File([largeContent], 'large.bin', { type: 'application/octet-stream' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).not.toBeNull()
      expect(uploadResult!.url).toBe('https://upload.example.com/get/abc123')
      expect(result.current.error).toBeNull()
    })
  })

  describe('clearError', () => {
    it('should clear error state', async () => {
      mockHttpUploadService = null

      const { result } = renderHook(() => useFileUpload())

      // Trigger an error
      const file = new File(['test'], 'test.txt', { type: 'text/plain' })
      await act(async () => {
        await result.current.uploadFile(file)
      })

      expect(result.current.error).not.toBeNull()

      // Clear the error
      act(() => {
        result.current.clearError()
      })

      expect(result.current.error).toBeNull()
    })
  })

  describe('thumbnail generation', () => {
    it('should check if file is an image', async () => {
      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/files/test.txt',
      })

      const { result } = renderHook(() => useFileUpload())
      const file = new File(['test'], 'test.txt', { type: 'text/plain' })

      await act(async () => {
        await result.current.uploadFile(file)
      })

      expect(mockIsImageFile).toHaveBeenCalledWith(file)
    })

    it('should generate thumbnail for image files', async () => {
      mockIsImageFile.mockReturnValue(true)
      mockGenerateThumbnail.mockResolvedValue({
        blob: new Blob(['thumbnail'], { type: 'image/jpeg' }),
        width: 256,
        height: 192,
        mediaType: 'image/jpeg',
      })

      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/files/photo.jpg',
      })

      const { result } = renderHook(() => useFileUpload())
      const file = new File(['image data'], 'photo.jpg', { type: 'image/jpeg' })

      await act(async () => {
        await result.current.uploadFile(file)
      })

      expect(mockGenerateThumbnail).toHaveBeenCalledWith(file)
    })

    it('should not generate thumbnail for non-image files', async () => {
      mockIsImageFile.mockReturnValue(false)

      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/abc123',
        getUrl: 'https://upload.example.com/files/doc.pdf',
      })

      const { result } = renderHook(() => useFileUpload())
      const file = new File(['pdf data'], 'doc.pdf', { type: 'application/pdf' })

      await act(async () => {
        await result.current.uploadFile(file)
      })

      expect(mockGenerateThumbnail).not.toHaveBeenCalled()
    })

    it('should upload thumbnail and include it in result', async () => {
      mockIsImageFile.mockReturnValue(true)
      mockGenerateThumbnail.mockResolvedValue({
        blob: new Blob(['thumbnail'], { type: 'image/jpeg' }),
        width: 256,
        height: 192,
        mediaType: 'image/jpeg',
      })

      // First call for main file, second for thumbnail
      mockRequestUploadSlot
        .mockResolvedValueOnce({
          putUrl: 'https://upload.example.com/put/main',
          getUrl: 'https://upload.example.com/files/photo.jpg',
        })
        .mockResolvedValueOnce({
          putUrl: 'https://upload.example.com/put/thumb',
          getUrl: 'https://upload.example.com/thumbs/thumb_photo.jpg',
        })

      const { result } = renderHook(() => useFileUpload())
      const file = new File(['image data'], 'photo.jpg', { type: 'image/jpeg' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).not.toBeNull()
      expect(uploadResult!.url).toBe('https://upload.example.com/files/photo.jpg')
      expect(uploadResult!.thumbnail).toEqual({
        uri: 'https://upload.example.com/thumbs/thumb_photo.jpg',
        mediaType: 'image/jpeg',
        width: 256,
        height: 192,
      })
    })

    it('should request slot for thumbnail with correct parameters', async () => {
      mockIsImageFile.mockReturnValue(true)
      const thumbnailBlob = new Blob(['thumbnail-data'], { type: 'image/jpeg' })
      mockGenerateThumbnail.mockResolvedValue({
        blob: thumbnailBlob,
        width: 200,
        height: 150,
        mediaType: 'image/jpeg',
      })

      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/file',
        getUrl: 'https://upload.example.com/files/image.png',
      })

      const { result } = renderHook(() => useFileUpload())
      const file = new File(['image data'], 'image.png', { type: 'image/png' })

      await act(async () => {
        await result.current.uploadFile(file)
      })

      // Second call should be for thumbnail
      expect(mockRequestUploadSlot).toHaveBeenCalledTimes(2)
      expect(mockRequestUploadSlot).toHaveBeenNthCalledWith(
        2,
        'thumb_image.jpg', // Thumbnail filename
        thumbnailBlob.size,
        'image/jpeg'
      )
    })

    it('should succeed even if thumbnail generation fails', async () => {
      mockIsImageFile.mockReturnValue(true)
      mockGenerateThumbnail.mockResolvedValue(null) // Thumbnail generation failed

      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/main',
        getUrl: 'https://upload.example.com/files/photo.jpg',
      })

      const { result } = renderHook(() => useFileUpload())
      const file = new File(['image data'], 'photo.jpg', { type: 'image/jpeg' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      // Upload should still succeed, just without thumbnail
      expect(uploadResult).not.toBeNull()
      expect(uploadResult!.url).toBe('https://upload.example.com/files/photo.jpg')
      expect(uploadResult!.thumbnail).toBeUndefined()
      expect(mockRequestUploadSlot).toHaveBeenCalledTimes(1) // Only main file
    })

    it('should not include thumbnail if result has no thumbnail field', async () => {
      mockIsImageFile.mockReturnValue(false)

      mockRequestUploadSlot.mockResolvedValue({
        putUrl: 'https://upload.example.com/put/file',
        getUrl: 'https://upload.example.com/files/doc.pdf',
      })

      const { result } = renderHook(() => useFileUpload())
      const file = new File(['pdf'], 'doc.pdf', { type: 'application/pdf' })

      let uploadResult: FileAttachment | null = null
      await act(async () => {
        uploadResult = await result.current.uploadFile(file)
      })

      expect(uploadResult).not.toBeNull()
      expect(uploadResult!.thumbnail).toBeUndefined()
    })
  })
})

describe('formatBytes', () => {
  it('should format 0 bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
  })

  it('should format bytes', () => {
    expect(formatBytes(500)).toBe('500 B')
  })

  it('should format kilobytes', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
  })

  it('should format megabytes', () => {
    expect(formatBytes(1048576)).toBe('1 MB')
    expect(formatBytes(52428800)).toBe('50 MB')
  })

  it('should format gigabytes', () => {
    expect(formatBytes(1073741824)).toBe('1 GB')
  })
})
