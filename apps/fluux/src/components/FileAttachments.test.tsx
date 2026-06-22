import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImageAttachment, VideoAttachment, AudioAttachment } from './FileAttachments'
import { MessageAttachments } from './MessageAttachments'
import { MediaAutoloadProvider } from '@/contexts'
import { __resetApprovedMediaUrlsForTest } from '@/utils/mediaAutoload'
import type { FileAttachment } from '@fluux/sdk'

// Spy created via vi.hoisted so it exists when the hoisted vi.mock factory runs.
const { useAttachmentUrlSpy, useCachedMediaUrlSpy } = vi.hoisted(() => ({
  useAttachmentUrlSpy: vi.fn(),
  useCachedMediaUrlSpy: vi.fn(),
}))

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

// The component was refactored from `useProxiedUrl` to `useAttachmentUrl`
// (which branches internally to the decrypting path when `encryption` is
// present). These tests exercise only the plaintext renderer path, so one
// mock covers both — either hook resolves to the same stub state.
// useAttachmentUrlSpy records args for deferral tests; the spy's mockReturnValue
// controls the return for both legacy and deferral test suites.
vi.mock('@/hooks', () => ({
  useAttachmentUrl: (url: string | undefined, enc: unknown, enabled: boolean) => {
    return useAttachmentUrlSpy(url, enc, enabled)
  },
  useProxiedUrl: (url: string | undefined, enc: unknown, enabled: boolean) => {
    return useAttachmentUrlSpy(url, enc, enabled)
  },
  useCachedMediaUrl: (url: string | undefined, enc: unknown, enabled: boolean) =>
    useCachedMediaUrlSpy(url, enc, enabled),
  formatBytes: (bytes: number) => `${bytes} B`,
}))

// Isolate ImageAttachment from heavy children rendered on the success path.
vi.mock('./ImageLightbox', () => ({ ImageLightbox: () => null }))
vi.mock('./ImageContextMenu', () => ({ ImageContextMenu: () => null }))

describe('FileAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    __resetApprovedMediaUrlsForTest()
    // Default: return successful proxied URL
    useAttachmentUrlSpy.mockReturnValue({
      url: 'blob:http://localhost/image123',
      isLoading: false,
      error: null,
    })
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  describe('ImageAttachment', () => {
    const imageAttachment: FileAttachment = {
      url: 'https://example.com/image.jpg',
      mediaType: 'image/jpeg',
      name: 'test-image.jpg',
    }

    it('should render image when loaded successfully', () => {
      render(<ImageAttachment attachment={imageAttachment} />)

      const img = screen.getByRole('img')
      expect(img).toBeInTheDocument()
      expect(img).toHaveAttribute('src', 'blob:http://localhost/image123')
    })

    it('should show loading state', () => {
      useAttachmentUrlSpy.mockReturnValue({
        url: null,
        isLoading: true,
        error: null,
      })

      render(<ImageAttachment attachment={imageAttachment} />)

      // Loading spinner should be visible (Loader2 component)
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
    })

    it('should show unavailable message when proxy fetch fails', () => {
      useAttachmentUrlSpy.mockReturnValue({
        url: null,
        isLoading: false,
        error: new Error('Failed to fetch'),
      })

      render(<ImageAttachment attachment={imageAttachment} />)

      expect(screen.getByText('chat.imageUnavailable')).toBeInTheDocument()
    })

    it('should show unavailable message when image fails to load (onError)', () => {
      render(<ImageAttachment attachment={imageAttachment} />)

      const img = screen.getByRole('img')
      fireEvent.error(img)

      expect(screen.getByText('chat.imageUnavailable')).toBeInTheDocument()
    })

    it('should not render for non-image attachments', () => {
      const pdfAttachment: FileAttachment = {
        url: 'https://example.com/doc.pdf',
        mediaType: 'application/pdf',
        name: 'document.pdf',
      }

      const { container } = render(<ImageAttachment attachment={pdfAttachment} />)
      expect(container.firstChild).toBeNull()
    })

    it('reserves the aspect-ratio box in the error state to avoid a layout shift', () => {
      // When an image fails to load — or its blob URL is invalidated AFTER it was
      // displayed (sleep/wake, WebKit blob reclaim) — the error fallback must keep
      // the same reserved box the loading/loaded image used. Collapsing to a
      // compact card shifts every row below it; a burst of such invalidations
      // feeds the message-list ResizeObserver scroll-correction loop on WebKitGTK.
      useAttachmentUrlSpy.mockReturnValue({
        url: null,
        isLoading: false,
        error: new Error('Failed to fetch'),
      })

      const { container } = render(<ImageAttachment attachment={imageAttachment} />)

      const reserved = container.querySelector('[style*="aspect-ratio"]')
      expect(reserved).toBeTruthy()
    })
  })

  describe('VideoAttachment', () => {
    const videoAttachment: FileAttachment = {
      url: 'https://example.com/video.mp4',
      mediaType: 'video/mp4',
      name: 'test-video.mp4',
    }

    it('should render video when loaded successfully', () => {
      render(<VideoAttachment attachment={videoAttachment} />)

      const video = document.querySelector('video')
      expect(video).toBeInTheDocument()
      expect(video).toHaveAttribute('src', 'blob:http://localhost/image123')
      expect(document.querySelector('source')).not.toBeInTheDocument()
    })

    it('should show loading state', () => {
      useAttachmentUrlSpy.mockReturnValue({
        url: null,
        isLoading: true,
        error: null,
      })

      render(<VideoAttachment attachment={videoAttachment} />)

      expect(document.querySelector('video')).not.toBeInTheDocument()
    })

    it('should show unavailable message when proxy fetch fails', () => {
      useAttachmentUrlSpy.mockReturnValue({
        url: null,
        isLoading: false,
        error: new Error('Failed to fetch'),
      })

      render(<VideoAttachment attachment={videoAttachment} />)

      expect(screen.getByText('chat.videoUnavailable')).toBeInTheDocument()
      expect(screen.getByLabelText('common.download')).toHaveAttribute('href', videoAttachment.url)
    })

    it('should show unavailable message when video fails to load (onError)', () => {
      render(<VideoAttachment attachment={videoAttachment} />)

      const video = document.querySelector('video')
      expect(video).not.toBeNull()
      fireEvent.error(video!)

      expect(screen.getByText('chat.videoUnavailable')).toBeInTheDocument()
    })

    it('should not render for non-video attachments', () => {
      const imageAttachment: FileAttachment = {
        url: 'https://example.com/image.jpg',
        mediaType: 'image/jpeg',
        name: 'image.jpg',
      }

      const { container } = render(<VideoAttachment attachment={imageAttachment} />)
      expect(container.firstChild).toBeNull()
    })

    it('should preserve Prosody-style file_share URL in fallback download link', () => {
      const prosodyVideoAttachment: FileAttachment = {
        url: 'https://upload.example.com:5281/file_share/019c54ed-91f2-7434-b717-6fdd8296c5b3/uuid=51B2BBEE-EAA7-4738-BEB6-F32AC33B16A2&code=001&library=1&type=3&mode=2&loc=true&cap=true.mov',
        mediaType: 'video/quicktime',
        name: 'uuid=51B2BBEE-EAA7-4738-BEB6-F32AC33B16A2&code=001&library=1&type=3&mode=2&loc=true&cap=true.mov',
      }

      useAttachmentUrlSpy.mockReturnValue({
        url: null,
        isLoading: false,
        error: new Error('Failed to fetch'),
      })

      render(<VideoAttachment attachment={prosodyVideoAttachment} />)

      expect(screen.getByLabelText('common.download')).toHaveAttribute('href', prosodyVideoAttachment.url)
    })
  })

  describe('AudioAttachment', () => {
    const audioAttachment: FileAttachment = {
      url: 'https://example.com/audio.mp3',
      mediaType: 'audio/mpeg',
      name: 'test-audio.mp3',
    }

    it('should render audio player when loaded successfully', () => {
      render(<AudioAttachment attachment={audioAttachment} />)

      const audio = document.querySelector('audio')
      expect(audio).toBeInTheDocument()
    })

    it('should show unavailable message when proxy fetch fails', () => {
      useAttachmentUrlSpy.mockReturnValue({
        url: null,
        isLoading: false,
        error: new Error('Failed to fetch'),
      })

      render(<AudioAttachment attachment={audioAttachment} />)

      expect(screen.getByText('chat.audioUnavailable')).toBeInTheDocument()
    })

    it('should show unavailable message when audio fails to load (onError)', () => {
      render(<AudioAttachment attachment={audioAttachment} />)

      const audio = document.querySelector('audio')
      expect(audio).not.toBeNull()
      fireEvent.error(audio!)

      expect(screen.getByText('chat.audioUnavailable')).toBeInTheDocument()
    })

    it('should not render for non-audio attachments', () => {
      const imageAttachment: FileAttachment = {
        url: 'https://example.com/image.jpg',
        mediaType: 'image/jpeg',
        name: 'image.jpg',
      }

      const { container } = render(<AudioAttachment attachment={imageAttachment} />)
      expect(container.firstChild).toBeNull()
    })

    it('should not render for audio with thumbnail (treated as voice message)', () => {
      const voiceMessage: FileAttachment = {
        url: 'https://example.com/voice.ogg',
        mediaType: 'audio/ogg',
        name: 'voice.ogg',
        thumbnail: {
          uri: 'https://example.com/waveform.png',
          mediaType: 'image/png',
          width: 200,
          height: 50,
        },
      }

      const { container } = render(<AudioAttachment attachment={voiceMessage} />)
      expect(container.firstChild).toBeNull()
    })
  })
})

// ── Deferral gating tests ────────────────────────────────────────────────────

const deferralImageAttachment = { url: 'https://x/a.jpg', name: 'a.jpg', mediaType: 'image/jpeg', size: 1234, width: 800, height: 600 }

describe('ImageAttachment deferral', () => {
  beforeEach(() => {
    useAttachmentUrlSpy.mockClear()
    __resetApprovedMediaUrlsForTest()
    // Deferral tests control return based on `enabled` arg in the mock factory above.
    // Override spy to return based on enabled flag.
    useAttachmentUrlSpy.mockImplementation((_url: string | undefined, _enc: unknown, enabled: boolean) => ({
      url: enabled ? 'blob:loaded' : null,
      isLoading: false,
      error: null,
    }))
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  it('defers (placeholder, no fetch) when autoLoad is false', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={deferralImageAttachment} />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('chat.loadImage')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
    expect(useAttachmentUrlSpy).toHaveBeenLastCalledWith('https://x/a.jpg', undefined, false)
  })

  it('loads inline after the user taps', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={deferralImageAttachment} />
      </MediaAutoloadProvider>,
    )
    fireEvent.click(screen.getByText('chat.loadImage'))
    expect(useAttachmentUrlSpy).toHaveBeenLastCalledWith('https://x/a.jpg', undefined, true)
    expect(screen.getByRole('img')).toBeInTheDocument()
  })

  it('auto-loads when autoLoad is true (default, no provider)', () => {
    render(<ImageAttachment attachment={deferralImageAttachment} />)
    expect(screen.queryByText('chat.loadImage')).not.toBeInTheDocument()
    expect(screen.getByRole('img')).toBeInTheDocument()
  })
})

describe('ImageAttachment cached-while-deferred', () => {
  const attachment = { url: 'https://x/a.jpg', name: 'a.jpg', mediaType: 'image/jpeg', size: 1234, width: 800, height: 600 }

  beforeEach(() => {
    vi.clearAllMocks()
    __resetApprovedMediaUrlsForTest()
    // Deferred: the consent-gated fetch path returns nothing.
    useAttachmentUrlSpy.mockImplementation((_u: string | undefined, _e: unknown, enabled: boolean) => ({
      url: enabled ? 'blob:fetched' : null,
      isLoading: false,
      error: null,
    }))
  })

  it('renders the image from cache without entering the fetch path', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: 'blob:cached', isPeeking: false })
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={attachment} />
      </MediaAutoloadProvider>,
    )
    const img = screen.getByRole('img')
    expect(img).toHaveAttribute('src', 'blob:cached')
    expect(screen.queryByText('chat.loadImage')).not.toBeInTheDocument()
    // Fetch path must be disabled while displaying from cache.
    expect(useAttachmentUrlSpy).toHaveBeenLastCalledWith('https://x/a.jpg', undefined, false)
  })

  it('shows the placeholder on a cache miss', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={attachment} />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('chat.loadImage')).toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('shows neither image nor placeholder while peeking', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: true })
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <ImageAttachment attachment={attachment} />
      </MediaAutoloadProvider>,
    )
    expect(screen.queryByText('chat.loadImage')).not.toBeInTheDocument()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('peek is disabled (not called with enabled) once the user consents', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
    render(<ImageAttachment attachment={attachment} />) // no provider → autoLoad true
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:fetched')
    // Peek must be disabled when the fetch path is active.
    expect(useCachedMediaUrlSpy).toHaveBeenLastCalledWith('https://x/a.jpg', undefined, false)
  })
})

describe('MessageAttachments own-message threading', () => {
  beforeEach(() => {
    __resetApprovedMediaUrlsForTest()
    useAttachmentUrlSpy.mockImplementation((_u: string | undefined, _e: unknown, enabled: boolean) => ({
      url: enabled ? 'blob:loaded' : null,
      isLoading: false,
      error: null,
    }))
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  it('loads an own-message image inline even when autoLoad is false', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <MessageAttachments attachment={deferralImageAttachment} isOwnMessage />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByRole('img')).toBeInTheDocument()
    expect(screen.queryByText('chat.loadImage')).not.toBeInTheDocument()
  })

  it('defers a non-own image when autoLoad is false', () => {
    render(
      <MediaAutoloadProvider autoLoad={false}>
        <MessageAttachments attachment={deferralImageAttachment} />
      </MediaAutoloadProvider>,
    )
    expect(screen.getByText('chat.loadImage')).toBeInTheDocument()
  })
})
