import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isImageFile,
  isVideoFile,
  isAudioFile,
  isMediaFile,
  generateThumbnail,
  generateVideoThumbnail,
  getImageDimensions,
  getVideoDuration,
  getVideoDimensions,
  getAudioDuration,
  getEffectiveMimeType,
  isPdfFile,
  isPdfMimeType,
  isDocumentMimeType,
  isArchiveMimeType,
  getFileTypeLabel,
  isTextMimeType,
  isTextFileByExtension,
  canPreviewAsText,
} from './thumbnail'

// Mock URL.createObjectURL and revokeObjectURL
const mockObjectUrl = 'blob:mock-url'
let mockRevokeObjectURL: ReturnType<typeof vi.fn>
let mockCreateObjectURL: ReturnType<typeof vi.fn>

// Mock canvas context
let mockCanvasContext: {
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: string
  drawImage: ReturnType<typeof vi.fn>
}

// Mock canvas
let mockCanvas: {
  width: number
  height: number
  getContext: ReturnType<typeof vi.fn>
  toBlob: ReturnType<typeof vi.fn>
}

// Mock Image
let mockImage: {
  onload: (() => void) | null
  onerror: (() => void) | null
  src: string
  width: number
  height: number
}

beforeEach(() => {
  // Reset mocks
  mockRevokeObjectURL = vi.fn()
  mockCreateObjectURL = vi.fn(() => mockObjectUrl)

  vi.stubGlobal('URL', {
    createObjectURL: mockCreateObjectURL,
    revokeObjectURL: mockRevokeObjectURL,
  })

  mockCanvasContext = {
    imageSmoothingEnabled: false,
    imageSmoothingQuality: '',
    drawImage: vi.fn(),
  }

  mockCanvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => mockCanvasContext),
    toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
      callback(new Blob(['mock-jpeg'], { type: 'image/jpeg' }))
    }),
  }

  vi.stubGlobal('document', {
    createElement: vi.fn((tag: string) => {
      if (tag === 'canvas') return mockCanvas
      return {}
    }),
  })

  mockImage = {
    onload: null,
    onerror: null,
    src: '',
    width: 800,
    height: 600,
  }

  vi.stubGlobal('Image', function(this: typeof mockImage) {
    Object.assign(this, mockImage)
    // Trigger onload when src is set
    Object.defineProperty(this, 'src', {
      set: (value: string) => {
        mockImage.src = value
        // Use setTimeout to simulate async image loading
        setTimeout(() => {
          if (this.onload) this.onload()
        }, 0)
      },
      get: () => mockImage.src,
    })
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('isImageFile', () => {
  it('should return true for image/jpeg', () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    expect(isImageFile(file)).toBe(true)
  })

  it('should return true for image/png', () => {
    const file = new File([''], 'photo.png', { type: 'image/png' })
    expect(isImageFile(file)).toBe(true)
  })

  it('should return true for image/gif', () => {
    const file = new File([''], 'animation.gif', { type: 'image/gif' })
    expect(isImageFile(file)).toBe(true)
  })

  it('should return true for image/webp', () => {
    const file = new File([''], 'photo.webp', { type: 'image/webp' })
    expect(isImageFile(file)).toBe(true)
  })

  it('should return false for text/plain', () => {
    const file = new File([''], 'doc.txt', { type: 'text/plain' })
    expect(isImageFile(file)).toBe(false)
  })

  it('should return false for application/pdf', () => {
    const file = new File([''], 'doc.pdf', { type: 'application/pdf' })
    expect(isImageFile(file)).toBe(false)
  })

  it('should return false for files without type', () => {
    const file = new File([''], 'unknown')
    expect(isImageFile(file)).toBe(false)
  })
})

describe('generateThumbnail', () => {
  it('should return null for non-image files', async () => {
    const file = new File([''], 'doc.pdf', { type: 'application/pdf' })
    const result = await generateThumbnail(file)
    expect(result).toBeNull()
  })

  it('should create object URL and revoke it after loading', async () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    await generateThumbnail(file)

    expect(mockCreateObjectURL).toHaveBeenCalledWith(file)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith(mockObjectUrl)
  })

  it('should scale down wide images to max 512px width', async () => {
    mockImage.width = 1024
    mockImage.height = 768

    const file = new File([''], 'wide.jpg', { type: 'image/jpeg' })
    const result = await generateThumbnail(file)

    expect(result).not.toBeNull()
    expect(result!.width).toBe(512)
    expect(result!.height).toBe(384) // 768 * (512/1024) = 384
  })

  it('should scale down tall images to max 512px height', async () => {
    mockImage.width = 600
    mockImage.height = 800

    const file = new File([''], 'tall.jpg', { type: 'image/jpeg' })
    const result = await generateThumbnail(file)

    expect(result).not.toBeNull()
    expect(result!.width).toBe(384) // 600 * (512/800) = 384
    expect(result!.height).toBe(512)
  })

  it('should not scale up small images', async () => {
    mockImage.width = 100
    mockImage.height = 80

    const file = new File([''], 'small.jpg', { type: 'image/jpeg' })
    const result = await generateThumbnail(file)

    expect(result).not.toBeNull()
    expect(result!.width).toBe(100)
    expect(result!.height).toBe(80)
  })

  it('should handle square images correctly', async () => {
    mockImage.width = 1024
    mockImage.height = 1024

    const file = new File([''], 'square.jpg', { type: 'image/jpeg' })
    const result = await generateThumbnail(file)

    expect(result).not.toBeNull()
    expect(result!.width).toBe(512)
    expect(result!.height).toBe(512)
  })

  it('should return JPEG media type', async () => {
    const file = new File([''], 'photo.png', { type: 'image/png' })
    const result = await generateThumbnail(file)

    expect(result).not.toBeNull()
    expect(result!.mediaType).toBe('image/jpeg')
  })

  it('should use high quality image smoothing', async () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    await generateThumbnail(file)

    expect(mockCanvasContext.imageSmoothingEnabled).toBe(true)
    expect(mockCanvasContext.imageSmoothingQuality).toBe('high')
  })

  it('should return null if canvas context is unavailable', async () => {
    mockCanvas.getContext = vi.fn(() => null)

    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    const result = await generateThumbnail(file)

    expect(result).toBeNull()
  })

  it('should return null if toBlob fails', async () => {
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(null)
    })

    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    const result = await generateThumbnail(file)

    expect(result).toBeNull()
  })

  it('should return null and revoke URL on image load error', async () => {
    // Override Image to trigger onerror instead of onload
    vi.stubGlobal('Image', function(this: typeof mockImage) {
      Object.assign(this, mockImage)
      Object.defineProperty(this, 'src', {
        set: () => {
          setTimeout(() => {
            if (this.onerror) this.onerror()
          }, 0)
        },
      })
    })

    const file = new File([''], 'corrupted.jpg', { type: 'image/jpeg' })
    const result = await generateThumbnail(file)

    expect(result).toBeNull()
    expect(mockRevokeObjectURL).toHaveBeenCalledWith(mockObjectUrl)
  })

  it('should return blob in result', async () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    const result = await generateThumbnail(file)

    expect(result).not.toBeNull()
    expect(result!.blob).toBeInstanceOf(Blob)
    expect(result!.blob.type).toBe('image/jpeg')
  })
})

describe('getImageDimensions', () => {
  it('should return null for non-image files', async () => {
    const file = new File([''], 'doc.pdf', { type: 'application/pdf' })
    const result = await getImageDimensions(file)
    expect(result).toBeNull()
  })

  it('should return image dimensions', async () => {
    mockImage.width = 1920
    mockImage.height = 1080

    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    const result = await getImageDimensions(file)

    expect(result).not.toBeNull()
    expect(result!.width).toBe(1920)
    expect(result!.height).toBe(1080)
  })

  it('should create and revoke object URL', async () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    await getImageDimensions(file)

    expect(mockCreateObjectURL).toHaveBeenCalledWith(file)
    expect(mockRevokeObjectURL).toHaveBeenCalledWith(mockObjectUrl)
  })

  it('should return null on image load error', async () => {
    // Override Image to trigger onerror
    vi.stubGlobal('Image', function(this: typeof mockImage) {
      Object.assign(this, mockImage)
      Object.defineProperty(this, 'src', {
        set: () => {
          setTimeout(() => {
            if (this.onerror) this.onerror()
          }, 0)
        },
      })
    })

    const file = new File([''], 'corrupted.jpg', { type: 'image/jpeg' })
    const result = await getImageDimensions(file)

    expect(result).toBeNull()
    expect(mockRevokeObjectURL).toHaveBeenCalledWith(mockObjectUrl)
  })
})

describe('isVideoFile', () => {
  it('should return true for video/mp4', () => {
    const file = new File([''], 'video.mp4', { type: 'video/mp4' })
    expect(isVideoFile(file)).toBe(true)
  })

  it('should return true for video/webm', () => {
    const file = new File([''], 'video.webm', { type: 'video/webm' })
    expect(isVideoFile(file)).toBe(true)
  })

  it('should return true for video/quicktime', () => {
    const file = new File([''], 'video.mov', { type: 'video/quicktime' })
    expect(isVideoFile(file)).toBe(true)
  })

  it('should return false for image files', () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    expect(isVideoFile(file)).toBe(false)
  })

  it('should return false for audio files', () => {
    const file = new File([''], 'song.mp3', { type: 'audio/mpeg' })
    expect(isVideoFile(file)).toBe(false)
  })
})

describe('isAudioFile', () => {
  it('should return true for audio/mpeg', () => {
    const file = new File([''], 'song.mp3', { type: 'audio/mpeg' })
    expect(isAudioFile(file)).toBe(true)
  })

  it('should return true for audio/wav', () => {
    const file = new File([''], 'sound.wav', { type: 'audio/wav' })
    expect(isAudioFile(file)).toBe(true)
  })

  it('should return true for audio/ogg', () => {
    const file = new File([''], 'song.ogg', { type: 'audio/ogg' })
    expect(isAudioFile(file)).toBe(true)
  })

  it('should return false for video files', () => {
    const file = new File([''], 'video.mp4', { type: 'video/mp4' })
    expect(isAudioFile(file)).toBe(false)
  })

  it('should return false for image files', () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    expect(isAudioFile(file)).toBe(false)
  })
})

describe('isMediaFile', () => {
  it('should return true for image files', () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    expect(isMediaFile(file)).toBe(true)
  })

  it('should return true for video files', () => {
    const file = new File([''], 'video.mp4', { type: 'video/mp4' })
    expect(isMediaFile(file)).toBe(true)
  })

  it('should return true for audio files', () => {
    const file = new File([''], 'song.mp3', { type: 'audio/mpeg' })
    expect(isMediaFile(file)).toBe(true)
  })

  it('should return false for text files', () => {
    const file = new File([''], 'doc.txt', { type: 'text/plain' })
    expect(isMediaFile(file)).toBe(false)
  })

  it('should return false for PDF files', () => {
    const file = new File([''], 'doc.pdf', { type: 'application/pdf' })
    expect(isMediaFile(file)).toBe(false)
  })
})

describe('generateVideoThumbnail', () => {
  it('should return null for non-video files', async () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    const result = await generateVideoThumbnail(file)
    expect(result).toBeNull()
  })

  it('should generate thumbnail for video file', async () => {
    const videoElement: Record<string | symbol, unknown> = {
      preload: '',
      muted: false,
      playsInline: false,
      duration: 60,
      videoWidth: 1920,
      videoHeight: 1080,
    }

    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        if (tag === 'canvas') return mockCanvas
        if (tag === 'video') {
          return new Proxy(videoElement, {
            set(target, prop, value) {
              target[prop] = value
              if (prop === 'src') {
                setTimeout(() => (target.onloadedmetadata as () => void)?.(), 0)
              }
              if (prop === 'currentTime') {
                setTimeout(() => (target.onseeked as () => void)?.(), 0)
              }
              return true
            },
          })
        }
        return {}
      }),
    })

    const file = new File([''], 'video.mp4', { type: 'video/mp4' })
    const result = await generateVideoThumbnail(file)

    expect(result).not.toBeNull()
    expect(result!.mediaType).toBe('image/jpeg')
  })

  it('should scale down wide videos to max 512px width', async () => {
    const videoElement: Record<string | symbol, unknown> = {
      preload: '',
      muted: false,
      playsInline: false,
      duration: 60,
      videoWidth: 1920,
      videoHeight: 1080,
    }

    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        if (tag === 'canvas') return mockCanvas
        if (tag === 'video') {
          return new Proxy(videoElement, {
            set(target, prop, value) {
              target[prop] = value
              if (prop === 'src') {
                setTimeout(() => (target.onloadedmetadata as () => void)?.(), 0)
              }
              if (prop === 'currentTime') {
                setTimeout(() => (target.onseeked as () => void)?.(), 0)
              }
              return true
            },
          })
        }
        return {}
      }),
    })

    const file = new File([''], 'video.mp4', { type: 'video/mp4' })
    const result = await generateVideoThumbnail(file)

    expect(result).not.toBeNull()
    expect(result!.width).toBe(512)
    expect(result!.height).toBe(288) // 1080 * (512/1920) = 288
  })
})

describe('getVideoDuration', () => {
  it('should return null for non-video files', async () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    const result = await getVideoDuration(file)
    expect(result).toBeNull()
  })

  it('should return duration for video file', async () => {
    const videoElement: Record<string | symbol, unknown> = {
      preload: '',
      muted: false,
      duration: 90.5,
    }

    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        if (tag === 'canvas') return mockCanvas
        if (tag === 'video') {
          return new Proxy(videoElement, {
            set(target, prop, value) {
              target[prop] = value
              if (prop === 'src') {
                setTimeout(() => (target.onloadedmetadata as () => void)?.(), 0)
              }
              return true
            },
          })
        }
        return {}
      }),
    })

    const file = new File([''], 'video.mp4', { type: 'video/mp4' })
    const result = await getVideoDuration(file)

    expect(result).toBe(90.5)
  })
})

describe('getVideoDimensions', () => {
  it('should return null for non-video files', async () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    const result = await getVideoDimensions(file)
    expect(result).toBeNull()
  })

  it('should return dimensions for video file', async () => {
    const videoElement: Record<string | symbol, unknown> = {
      preload: '',
      muted: false,
      videoWidth: 1280,
      videoHeight: 720,
    }

    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        if (tag === 'canvas') return mockCanvas
        if (tag === 'video') {
          return new Proxy(videoElement, {
            set(target, prop, value) {
              target[prop] = value
              if (prop === 'src') {
                setTimeout(() => (target.onloadedmetadata as () => void)?.(), 0)
              }
              return true
            },
          })
        }
        return {}
      }),
    })

    const file = new File([''], 'video.mp4', { type: 'video/mp4' })
    const result = await getVideoDimensions(file)

    expect(result).not.toBeNull()
    expect(result!.width).toBe(1280)
    expect(result!.height).toBe(720)
  })
})

describe('getAudioDuration', () => {
  it('should return null for non-audio files', async () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    const result = await getAudioDuration(file)
    expect(result).toBeNull()
  })

  it('should return duration for audio file', async () => {
    const audioElement: Record<string | symbol, unknown> = {
      preload: '',
      duration: 240.5,
    }

    vi.stubGlobal('document', {
      createElement: vi.fn((tag: string) => {
        if (tag === 'canvas') return mockCanvas
        if (tag === 'audio') {
          return new Proxy(audioElement, {
            set(target, prop, value) {
              target[prop] = value
              if (prop === 'src') {
                setTimeout(() => (target.onloadedmetadata as () => void)?.(), 0)
              }
              return true
            },
          })
        }
        return {}
      }),
    })

    const file = new File([''], 'song.mp3', { type: 'audio/mpeg' })
    const result = await getAudioDuration(file)

    expect(result).toBe(240.5)
  })
})

describe('getEffectiveMimeType', () => {
  it('should use browser type when available and valid', () => {
    const file = new File([''], 'song.mp3', { type: 'audio/mpeg' })
    expect(getEffectiveMimeType(file)).toBe('audio/mpeg')
  })

  it('should fallback to extension for OGG audio when browser type is application/ogg', () => {
    // Some browsers report OGG as application/ogg instead of audio/ogg
    const file = new File([''], 'song.ogg', { type: 'application/ogg' })
    expect(getEffectiveMimeType(file)).toBe('audio/ogg')
  })

  it('should fallback to extension for OGG video when browser type is missing', () => {
    const file = new File([''], 'video.ogv', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('video/ogg')
  })

  it('should fallback to extension when type is application/octet-stream', () => {
    const file = new File([''], 'track.flac', { type: 'application/octet-stream' })
    expect(getEffectiveMimeType(file)).toBe('audio/flac')
  })

  it('should detect MP3 from extension', () => {
    const file = new File([''], 'music.mp3', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('audio/mpeg')
  })

  it('should detect WAV from extension', () => {
    const file = new File([''], 'audio.wav', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('audio/wav')
  })

  it('should detect M4A from extension', () => {
    const file = new File([''], 'podcast.m4a', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('audio/mp4')
  })

  it('should detect OPUS from extension', () => {
    const file = new File([''], 'voice.opus', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('audio/opus')
  })

  it('should detect WebM audio from extension', () => {
    const file = new File([''], 'audio.weba', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('audio/webm')
  })

  it('should detect MP4 video from extension', () => {
    const file = new File([''], 'movie.mp4', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('video/mp4')
  })

  it('should detect WebM video from extension', () => {
    const file = new File([''], 'clip.webm', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('video/webm')
  })

  it('should detect MOV from extension', () => {
    const file = new File([''], 'movie.mov', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('video/quicktime')
  })

  it('should detect PNG from extension', () => {
    const file = new File([''], 'image.png', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('image/png')
  })

  it('should detect JPEG from extension', () => {
    const file = new File([''], 'photo.jpg', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('image/jpeg')
  })

  it('should detect JPEG from .jpeg extension', () => {
    const file = new File([''], 'photo.jpeg', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('image/jpeg')
  })

  it('should detect GIF from extension', () => {
    const file = new File([''], 'animated.gif', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('image/gif')
  })

  it('should detect WebP from extension', () => {
    const file = new File([''], 'image.webp', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('image/webp')
  })

  it('should return application/octet-stream for unknown extensions', () => {
    const file = new File([''], 'file.xyz', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/octet-stream')
  })

  it('should handle uppercase extensions', () => {
    const file = new File([''], 'SONG.MP3', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('audio/mpeg')
  })

  it('should handle mixed case extensions', () => {
    const file = new File([''], 'Video.OGV', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('video/ogg')
  })
})

describe('file type detection with extension fallback', () => {
  it('isAudioFile should detect OGG files when browser reports application/ogg', () => {
    const file = new File([''], 'song.ogg', { type: 'application/ogg' })
    expect(isAudioFile(file)).toBe(true)
  })

  it('isAudioFile should detect OGG files when browser type is empty', () => {
    const file = new File([''], 'song.ogg', { type: '' })
    expect(isAudioFile(file)).toBe(true)
  })

  it('isVideoFile should detect OGV files when browser type is empty', () => {
    const file = new File([''], 'video.ogv', { type: '' })
    expect(isVideoFile(file)).toBe(true)
  })

  it('isImageFile should detect PNG files when browser type is empty', () => {
    const file = new File([''], 'image.png', { type: '' })
    expect(isImageFile(file)).toBe(true)
  })

  it('isMediaFile should detect OGG audio when browser type is application/ogg', () => {
    const file = new File([''], 'song.ogg', { type: 'application/ogg' })
    expect(isMediaFile(file)).toBe(true)
  })
})

describe('isPdfFile', () => {
  it('should return true for PDF files with correct MIME type', () => {
    const file = new File([''], 'document.pdf', { type: 'application/pdf' })
    expect(isPdfFile(file)).toBe(true)
  })

  it('should return true for PDF files detected by extension', () => {
    const file = new File([''], 'document.pdf', { type: '' })
    expect(isPdfFile(file)).toBe(true)
  })

  it('should return true for PDF files with octet-stream type', () => {
    const file = new File([''], 'report.pdf', { type: 'application/octet-stream' })
    expect(isPdfFile(file)).toBe(true)
  })

  it('should return false for non-PDF files', () => {
    const file = new File([''], 'document.doc', { type: 'application/msword' })
    expect(isPdfFile(file)).toBe(false)
  })

  it('should return false for image files', () => {
    const file = new File([''], 'photo.jpg', { type: 'image/jpeg' })
    expect(isPdfFile(file)).toBe(false)
  })
})

describe('isPdfMimeType', () => {
  it('should return true for application/pdf', () => {
    expect(isPdfMimeType('application/pdf')).toBe(true)
  })

  it('should return false for other document types', () => {
    expect(isPdfMimeType('application/msword')).toBe(false)
  })

  it('should return false for undefined', () => {
    expect(isPdfMimeType(undefined)).toBe(false)
  })

  it('should return false for image types', () => {
    expect(isPdfMimeType('image/png')).toBe(false)
  })
})

describe('isDocumentMimeType', () => {
  it('should return true for PDF', () => {
    expect(isDocumentMimeType('application/pdf')).toBe(true)
  })

  it('should return true for MS Word', () => {
    expect(isDocumentMimeType('application/msword')).toBe(true)
  })

  it('should return true for Word DOCX', () => {
    expect(isDocumentMimeType('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(true)
  })

  it('should return true for Excel XLSX', () => {
    expect(isDocumentMimeType('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true)
  })

  it('should return true for PowerPoint PPTX', () => {
    expect(isDocumentMimeType('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe(true)
  })

  it('should return true for RTF', () => {
    expect(isDocumentMimeType('application/rtf')).toBe(true)
  })

  it('should return true for plain text', () => {
    expect(isDocumentMimeType('text/plain')).toBe(true)
  })

  it('should return false for images', () => {
    expect(isDocumentMimeType('image/png')).toBe(false)
  })

  it('should return false for audio', () => {
    expect(isDocumentMimeType('audio/mpeg')).toBe(false)
  })

  it('should return false for undefined', () => {
    expect(isDocumentMimeType(undefined)).toBe(false)
  })

  it('should return false for archives', () => {
    expect(isDocumentMimeType('application/zip')).toBe(false)
  })
})

describe('isArchiveMimeType', () => {
  it('should return true for ZIP', () => {
    expect(isArchiveMimeType('application/zip')).toBe(true)
  })

  it('should return true for RAR', () => {
    expect(isArchiveMimeType('application/vnd.rar')).toBe(true)
  })

  it('should return true for 7z', () => {
    expect(isArchiveMimeType('application/x-7z-compressed')).toBe(true)
  })

  it('should return true for TAR', () => {
    expect(isArchiveMimeType('application/x-tar')).toBe(true)
  })

  it('should return true for GZIP', () => {
    expect(isArchiveMimeType('application/gzip')).toBe(true)
  })

  it('should return false for documents', () => {
    expect(isArchiveMimeType('application/pdf')).toBe(false)
  })

  it('should return false for images', () => {
    expect(isArchiveMimeType('image/jpeg')).toBe(false)
  })

  it('should return false for undefined', () => {
    expect(isArchiveMimeType(undefined)).toBe(false)
  })
})

describe('getFileTypeLabel', () => {
  it('should return "PDF" for PDF files', () => {
    expect(getFileTypeLabel('application/pdf')).toBe('PDF')
  })

  it('should return "Word" for MS Word', () => {
    expect(getFileTypeLabel('application/msword')).toBe('Word')
  })

  it('should return "Word" for Word DOCX', () => {
    expect(getFileTypeLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('Word')
  })

  it('should return "Excel" for MS Excel', () => {
    expect(getFileTypeLabel('application/vnd.ms-excel')).toBe('Excel')
  })

  it('should return "Excel" for Excel XLSX', () => {
    expect(getFileTypeLabel('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('Excel')
  })

  it('should return "PowerPoint" for MS PowerPoint', () => {
    expect(getFileTypeLabel('application/vnd.ms-powerpoint')).toBe('PowerPoint')
  })

  it('should return "PowerPoint" for PowerPoint PPTX', () => {
    expect(getFileTypeLabel('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('PowerPoint')
  })

  it('should return "Text" for plain text', () => {
    expect(getFileTypeLabel('text/plain')).toBe('Text')
  })

  it('should return "RTF" for RTF files', () => {
    expect(getFileTypeLabel('application/rtf')).toBe('RTF')
  })

  it('should return "ZIP" for ZIP archives', () => {
    expect(getFileTypeLabel('application/zip')).toBe('ZIP')
  })

  it('should return "RAR" for RAR archives', () => {
    expect(getFileTypeLabel('application/vnd.rar')).toBe('RAR')
  })

  it('should return "7Z" for 7-Zip archives', () => {
    expect(getFileTypeLabel('application/x-7z-compressed')).toBe('7Z')
  })

  it('should return "Archive" for TAR files', () => {
    expect(getFileTypeLabel('application/x-tar')).toBe('Archive')
  })

  it('should return "Archive" for GZIP files', () => {
    expect(getFileTypeLabel('application/gzip')).toBe('Archive')
  })

  it('should return "File" for unknown types', () => {
    expect(getFileTypeLabel('application/octet-stream')).toBe('File')
  })

  it('should return "File" for undefined', () => {
    expect(getFileTypeLabel(undefined)).toBe('File')
  })

  it('should return "File" for audio types', () => {
    expect(getFileTypeLabel('audio/mpeg')).toBe('File')
  })

  it('should return "File" for video types', () => {
    expect(getFileTypeLabel('video/mp4')).toBe('File')
  })
})

describe('getEffectiveMimeType for documents', () => {
  it('should detect PDF from extension', () => {
    const file = new File([''], 'document.pdf', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/pdf')
  })

  it('should detect DOC from extension', () => {
    const file = new File([''], 'document.doc', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/msword')
  })

  it('should detect DOCX from extension', () => {
    const file = new File([''], 'document.docx', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
  })

  it('should detect XLS from extension', () => {
    const file = new File([''], 'spreadsheet.xls', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/vnd.ms-excel')
  })

  it('should detect XLSX from extension', () => {
    const file = new File([''], 'spreadsheet.xlsx', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  })

  it('should detect PPT from extension', () => {
    const file = new File([''], 'presentation.ppt', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/vnd.ms-powerpoint')
  })

  it('should detect PPTX from extension', () => {
    const file = new File([''], 'presentation.pptx', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation')
  })

  it('should detect TXT from extension', () => {
    const file = new File([''], 'notes.txt', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('text/plain')
  })

  it('should detect RTF from extension', () => {
    const file = new File([''], 'document.rtf', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/rtf')
  })
})

describe('getEffectiveMimeType for archives', () => {
  it('should detect ZIP from extension', () => {
    const file = new File([''], 'archive.zip', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/zip')
  })

  it('should detect RAR from extension', () => {
    const file = new File([''], 'archive.rar', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/vnd.rar')
  })

  it('should detect 7Z from extension', () => {
    const file = new File([''], 'archive.7z', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/x-7z-compressed')
  })

  it('should detect TAR from extension', () => {
    const file = new File([''], 'archive.tar', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/x-tar')
  })

  it('should detect GZ from extension', () => {
    const file = new File([''], 'archive.gz', { type: '' })
    expect(getEffectiveMimeType(file)).toBe('application/gzip')
  })
})

describe('isTextMimeType', () => {
  it('should return true for text/plain', () => {
    expect(isTextMimeType('text/plain')).toBe(true)
  })

  it('should return true for text/markdown', () => {
    expect(isTextMimeType('text/markdown')).toBe(true)
  })

  it('should return true for text/css', () => {
    expect(isTextMimeType('text/css')).toBe(true)
  })

  it('should return true for text/html', () => {
    expect(isTextMimeType('text/html')).toBe(true)
  })

  it('should return true for application/json', () => {
    expect(isTextMimeType('application/json')).toBe(true)
  })

  it('should return true for application/xml', () => {
    expect(isTextMimeType('application/xml')).toBe(true)
  })

  it('should return true for text/x-python', () => {
    expect(isTextMimeType('text/x-python')).toBe(true)
  })

  it('should return true for any text/* MIME type', () => {
    expect(isTextMimeType('text/x-custom')).toBe(true)
  })

  it('should return false for image types', () => {
    expect(isTextMimeType('image/png')).toBe(false)
  })

  it('should return false for video types', () => {
    expect(isTextMimeType('video/mp4')).toBe(false)
  })

  it('should return false for audio types', () => {
    expect(isTextMimeType('audio/mpeg')).toBe(false)
  })

  it('should return false for application/pdf', () => {
    expect(isTextMimeType('application/pdf')).toBe(false)
  })

  it('should return false for undefined', () => {
    expect(isTextMimeType(undefined)).toBe(false)
  })
})

describe('isTextFileByExtension', () => {
  it('should return true for .txt files', () => {
    expect(isTextFileByExtension('readme.txt')).toBe(true)
  })

  it('should return true for .md files', () => {
    expect(isTextFileByExtension('README.md')).toBe(true)
  })

  it('should return true for .json files', () => {
    expect(isTextFileByExtension('package.json')).toBe(true)
  })

  it('should return true for .js files', () => {
    expect(isTextFileByExtension('index.js')).toBe(true)
  })

  it('should return true for .ts files', () => {
    expect(isTextFileByExtension('main.ts')).toBe(true)
  })

  it('should return true for .py files', () => {
    expect(isTextFileByExtension('script.py')).toBe(true)
  })

  it('should return true for .sh files', () => {
    expect(isTextFileByExtension('build.sh')).toBe(true)
  })

  it('should return true for .yml files', () => {
    expect(isTextFileByExtension('config.yml')).toBe(true)
  })

  it('should return true for .css files', () => {
    expect(isTextFileByExtension('styles.css')).toBe(true)
  })

  it('should return true for .erl files (Erlang)', () => {
    expect(isTextFileByExtension('module.erl')).toBe(true)
  })

  it('should return true for .ex files (Elixir)', () => {
    expect(isTextFileByExtension('lib.ex')).toBe(true)
  })

  it('should return true for .exs files (Elixir script)', () => {
    expect(isTextFileByExtension('test.exs')).toBe(true)
  })

  it('should return true for Makefile (no extension)', () => {
    expect(isTextFileByExtension('Makefile')).toBe(true)
  })

  it('should return true for Dockerfile (no extension)', () => {
    expect(isTextFileByExtension('Dockerfile')).toBe(true)
  })

  it('should return true for .gitignore', () => {
    expect(isTextFileByExtension('.gitignore')).toBe(true)
  })

  it('should return false for .pdf files', () => {
    expect(isTextFileByExtension('document.pdf')).toBe(false)
  })

  it('should return false for .zip files', () => {
    expect(isTextFileByExtension('archive.zip')).toBe(false)
  })

  it('should return false for .jpg files', () => {
    expect(isTextFileByExtension('photo.jpg')).toBe(false)
  })

  it('should return false for undefined', () => {
    expect(isTextFileByExtension(undefined)).toBe(false)
  })
})

describe('canPreviewAsText', () => {
  it('should return true when MIME type is text', () => {
    expect(canPreviewAsText('text/plain', 'file.xyz')).toBe(true)
  })

  it('should return true when extension is text-based', () => {
    expect(canPreviewAsText('application/octet-stream', 'script.py')).toBe(true)
  })

  it('should return true when both match', () => {
    expect(canPreviewAsText('text/javascript', 'app.js')).toBe(true)
  })

  it('should return false when neither match', () => {
    expect(canPreviewAsText('application/pdf', 'document.pdf')).toBe(false)
  })

  it('should return false for images', () => {
    expect(canPreviewAsText('image/png', 'photo.png')).toBe(false)
  })

  it('should return true for JSON with application/json', () => {
    expect(canPreviewAsText('application/json', 'data.json')).toBe(true)
  })

  it('should return true for log files by extension', () => {
    expect(canPreviewAsText(undefined, 'error.log')).toBe(true)
  })

  it('should return false when both are undefined', () => {
    expect(canPreviewAsText(undefined, undefined)).toBe(false)
  })
})
