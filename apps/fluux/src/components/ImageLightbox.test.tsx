import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { ImageLightbox } from './ImageLightbox'

const { useAttachmentUrlSpy, useCachedMediaUrlSpy } = vi.hoisted(() => ({
  useAttachmentUrlSpy: vi.fn(),
  useCachedMediaUrlSpy: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks', () => ({
  useAttachmentUrl: (u: string | undefined, e: unknown, enabled?: boolean) => useAttachmentUrlSpy(u, e, enabled),
}))
vi.mock('@/hooks/useCachedMediaUrl', () => ({
  useCachedMediaUrl: (u: string | undefined, e: unknown, enabled?: boolean) => useCachedMediaUrlSpy(u, e, enabled),
}))
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
