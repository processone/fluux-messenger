import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ImageLightbox } from './ImageLightbox'

const { useAttachmentUrlSpy, useCachedMediaUrlSpy, downloadFileSpy, downloadAttachmentSpy } = vi.hoisted(() => ({
  useAttachmentUrlSpy: vi.fn(),
  useCachedMediaUrlSpy: vi.fn(),
  downloadFileSpy: vi.fn(),
  downloadAttachmentSpy: vi.fn(),
}))

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('@/hooks', () => ({
  useAttachmentUrl: (u: string | undefined, e: unknown, enabled?: boolean) => useAttachmentUrlSpy(u, e, enabled),
}))
vi.mock('@/hooks/useCachedMediaUrl', () => ({
  useCachedMediaUrl: (u: string | undefined, e: unknown, enabled?: boolean) => useCachedMediaUrlSpy(u, e, enabled),
}))
vi.mock('@/utils/download', () => ({
  downloadFile: (...args: unknown[]) => downloadFileSpy(...args),
  downloadAttachment: (...args: unknown[]) => downloadAttachmentSpy(...args),
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

describe('ImageLightbox Escape handling', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAttachmentUrlSpy.mockReturnValue({ url: null, isLoading: false, error: null })
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(<ImageLightbox src="https://x/full.jpg" downloadUrl="https://x/full.jpg" onClose={onClose} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('consumes Escape so it never reaches the window-level shortcut handler', () => {
    // useKeyboardShortcuts listens on `window`; its Escape branch runs
    // onConversationEscape → scrollToBottom(), snapping a reader who had scrolled
    // up into history back to the newest message. The lightbox's own Escape (which
    // closes it) must stop there — the same keypress must NOT also trigger that
    // window-level handler. Regression guard for "opening an image resets my
    // scroll position back to most recent".
    const onClose = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<ImageLightbox src="https://x/full.jpg" downloadUrl="https://x/full.jpg" onClose={onClose} />)
      fireEvent.keyDown(document.body, { key: 'Escape' })
      expect(onClose).toHaveBeenCalledTimes(1)
      expect(windowKeydown).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
  })

  it('does not intercept non-Escape keys (they still reach the window handler)', () => {
    // Control: the consume behavior must be Escape-specific. A different key must
    // pass through untouched, or the block above could be trivially satisfied by
    // swallowing everything.
    const onClose = vi.fn()
    const windowKeydown = vi.fn()
    window.addEventListener('keydown', windowKeydown)
    try {
      render(<ImageLightbox src="https://x/full.jpg" downloadUrl="https://x/full.jpg" onClose={onClose} />)
      fireEvent.keyDown(document.body, { key: 'a' })
      expect(onClose).not.toHaveBeenCalled()
      expect(windowKeydown).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener('keydown', windowKeydown)
    }
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

describe('ImageLightbox encrypted download', () => {
  const encryption = { cipher: 'aes-256-gcm' as const, key: new Uint8Array(32), iv: new Uint8Array(12) }

  beforeEach(() => {
    vi.clearAllMocks()
    // No resolved (decrypted) bytes: proxied + cached are both null.
    useAttachmentUrlSpy.mockReturnValue({ url: null, isLoading: false, error: new Error('Failed to fetch') })
    useCachedMediaUrlSpy.mockReturnValue({ cachedUrl: null, isPeeking: false })
  })

  it('decrypts on demand and NEVER hands the ciphertext URL to the save path', () => {
    render(
      <ImageLightbox
        src="https://x/cipher.bin"
        downloadUrl="https://x/cipher.bin"
        encryption={encryption}
        filename="secret.jpg"
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTitle('common.download'))

    // Routes through the decrypting helper with the attachment shape...
    expect(downloadAttachmentSpy).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://x/cipher.bin', encryption }),
      expect.anything(),
    )
    // ...and never saves the raw ciphertext URL directly.
    expect(downloadFileSpy).not.toHaveBeenCalled()
  })

  it('downloads the decrypted blob directly once resolved (no re-decrypt)', () => {
    useAttachmentUrlSpy.mockReturnValue({ url: 'blob:decrypted', isLoading: false, error: null })
    render(
      <ImageLightbox
        src="https://x/cipher.bin"
        downloadUrl="https://x/cipher.bin"
        encryption={encryption}
        filename="secret.jpg"
        onClose={() => {}}
      />,
    )
    fireEvent.click(screen.getByTitle('common.download'))
    expect(downloadFileSpy).toHaveBeenCalledWith('blob:decrypted', 'secret.jpg', expect.anything())
    expect(downloadAttachmentSpy).not.toHaveBeenCalled()
  })
})
