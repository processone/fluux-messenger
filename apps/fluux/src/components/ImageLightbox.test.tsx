import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImageLightbox } from './ImageLightbox'

const { useAttachmentUrlSpy, useCachedMediaUrlSpy, downloadFileSpy } = vi.hoisted(() => ({
  useAttachmentUrlSpy: vi.fn(),
  useCachedMediaUrlSpy: vi.fn(),
  downloadFileSpy: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks', () => ({
  useAttachmentUrl: (u: string | undefined, e: unknown, enabled?: boolean) => useAttachmentUrlSpy(u, e, enabled),
}))
vi.mock('@/hooks/useCachedMediaUrl', () => ({
  useCachedMediaUrl: (u: string | undefined, e: unknown, enabled?: boolean) => useCachedMediaUrlSpy(u, e, enabled),
}))
vi.mock('@/utils/download', () => ({ downloadFile: (...args: unknown[]) => downloadFileSpy(...args) }))
vi.mock('./ImageContextMenu', () => ({ ImageContextMenu: () => null }))
vi.mock('@/hooks/useContextMenu', () => ({ useContextMenu: () => ({ handleContextMenu: vi.fn() }) }))

describe('ImageLightbox allowFetch gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAttachmentUrlSpy.mockReturnValue({ url: null, isLoading: false, error: null })
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  it('fetches the full-res image by default (allowFetch defaults true)', () => {
    useAttachmentUrlSpy.mockReturnValue({ url: 'blob:fullres', isLoading: false, error: null })
    render(<ImageLightbox src="https://x/full.jpg" downloadUrl="https://x/full.jpg" onClose={() => {}} />)
    expect(useAttachmentUrlSpy).toHaveBeenCalledWith('https://x/full.jpg', undefined, true)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:fullres')
  })

  it('does NOT fetch full-res when allowFetch is false, showing the thumbnail instead', () => {
    render(
      <ImageLightbox
        src="https://x/full.jpg"
        downloadUrl="https://x/full.jpg"
        placeholderSrc="blob:thumb"
        allowFetch={false}
        onClose={() => {}}
      />,
    )
    expect(useAttachmentUrlSpy).toHaveBeenCalledWith('https://x/full.jpg', undefined, false)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:thumb')
  })

  it('upgrades to the cached full-res when present, still without fetching', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: 'blob:fullres-cached', isPeeking: false })
    render(
      <ImageLightbox
        src="https://x/full.jpg"
        downloadUrl="https://x/full.jpg"
        placeholderSrc="blob:thumb"
        allowFetch={false}
        onClose={() => {}}
      />,
    )
    expect(useAttachmentUrlSpy).toHaveBeenCalledWith('https://x/full.jpg', undefined, false)
    expect(screen.getByRole('img')).toHaveAttribute('src', 'blob:fullres-cached')
  })
})

describe('ImageLightbox download button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAttachmentUrlSpy.mockReturnValue({ url: null, isLoading: false, error: null })
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  it('downloads the fetched full-res when available (default path)', () => {
    useAttachmentUrlSpy.mockReturnValue({ url: 'blob:fullres', isLoading: false, error: null })
    render(<ImageLightbox src="https://x/full.jpg" downloadUrl="https://x/full.jpg" onClose={() => {}} />)
    fireEvent.click(screen.getByTitle('common.download'))
    expect(downloadFileSpy).toHaveBeenCalledWith('blob:fullres', 'image', expect.anything())
  })

  it('prefers the cached full-res over the remote URL when shown from cache only', () => {
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: 'blob:fullres-cached', isPeeking: false })
    render(
      <ImageLightbox
        src="https://x/full.jpg"
        downloadUrl="https://x/full.jpg"
        placeholderSrc="blob:thumb"
        allowFetch={false}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTitle('common.download'))
    // Must NOT re-hit the remote URL when the bytes are already cached locally.
    expect(downloadFileSpy).toHaveBeenCalledWith('blob:fullres-cached', 'image', expect.anything())
  })

  it('falls back to the remote URL when nothing is cached', () => {
    render(
      <ImageLightbox
        src="https://x/full.jpg"
        downloadUrl="https://x/full.jpg"
        placeholderSrc="blob:thumb"
        allowFetch={false}
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTitle('common.download'))
    expect(downloadFileSpy).toHaveBeenCalledWith('https://x/full.jpg', 'image', expect.anything())
  })
})
