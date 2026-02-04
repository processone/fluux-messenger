import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImageAttachment, VideoAttachment, AudioAttachment } from './FileAttachments'
import type { FileAttachment } from '@fluux/sdk'

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

// Mock useProxiedUrl hook
const mockUseProxiedUrl = vi.fn()
vi.mock('@/hooks', () => ({
  useProxiedUrl: (...args: unknown[]) => mockUseProxiedUrl(...args),
  formatBytes: (bytes: number) => `${bytes} bytes`,
}))

describe('FileAttachments', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default: return successful proxied URL
    mockUseProxiedUrl.mockReturnValue({
      url: 'blob:http://localhost/image123',
      isLoading: false,
      error: null,
    })
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
      mockUseProxiedUrl.mockReturnValue({
        url: null,
        isLoading: true,
        error: null,
      })

      render(<ImageAttachment attachment={imageAttachment} />)

      // Loading spinner should be visible (Loader2 component)
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
    })

    it('should show unavailable message when proxy fetch fails', () => {
      mockUseProxiedUrl.mockReturnValue({
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
    })

    it('should show loading state', () => {
      mockUseProxiedUrl.mockReturnValue({
        url: null,
        isLoading: true,
        error: null,
      })

      render(<VideoAttachment attachment={videoAttachment} />)

      expect(document.querySelector('video')).not.toBeInTheDocument()
    })

    it('should show unavailable message when proxy fetch fails', () => {
      mockUseProxiedUrl.mockReturnValue({
        url: null,
        isLoading: false,
        error: new Error('Failed to fetch'),
      })

      render(<VideoAttachment attachment={videoAttachment} />)

      expect(screen.getByText('chat.videoUnavailable')).toBeInTheDocument()
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
      mockUseProxiedUrl.mockReturnValue({
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
