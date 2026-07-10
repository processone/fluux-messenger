/**
 * @vitest-environment jsdom
 *
 * Pinned to jsdom: this file checks inline color/gradient styles whose serialization
 * differs between DOM environments (jsdom normalizes #hex to rgb(); happy-dom, the
 * default env, keeps the literal). These assertions/snapshots only hold under jsdom.
 */
import { describe, it, expect, vi, test, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { Avatar, getConsistentTextColor } from './Avatar'

// Mock the SDK color generation
vi.mock('@fluux/sdk', () => ({
  generateConsistentColorHexSync: vi.fn((identifier: string) => {
    // Return predictable colors based on identifier for testing
    if (identifier === 'alice') return '#4488cc'
    if (identifier === 'bob') return '#cc8844'
    return '#888888'
  }),
}))

describe('Avatar', () => {
  describe('Basic Rendering', () => {
    it('renders fallback letter when no avatarUrl provided', () => {
      render(<Avatar identifier="alice" name="Alice" />)
      expect(screen.getByText('A')).toBeInTheDocument()
    })

    it('renders first letter of identifier when name not provided', () => {
      render(<Avatar identifier="bob@example.com" />)
      expect(screen.getByText('B')).toBeInTheDocument()
    })

    it('renders image when avatarUrl is provided', () => {
      render(<Avatar identifier="alice" name="Alice" avatarUrl="https://example.com/alice.jpg" />)
      const img = screen.getByRole('img')
      expect(img).toHaveAttribute('src', 'https://example.com/alice.jpg')
      expect(img).toHaveAttribute('alt', 'Alice')
    })

    it('renders ? when identifier is empty', () => {
      render(<Avatar identifier="" />)
      expect(screen.getByText('?')).toBeInTheDocument()
    })
  })

  describe('fallbackColor prop', () => {
    it('uses fallbackColor when provided and no avatarUrl', () => {
      const { container } = render(
        <Avatar identifier="alice" name="Alice" fallbackColor="#ff0000" />
      )
      const letterDiv = container.querySelector('div > div')
      // The color will be adjusted by ensureContrastWithWhite
      expect(letterDiv).toHaveStyle({ backgroundColor: expect.any(String) })
    })

    it('ignores fallbackColor when avatarUrl is provided', () => {
      render(
        <Avatar
          identifier="alice"
          name="Alice"
          avatarUrl="https://example.com/alice.jpg"
          fallbackColor="#ff0000"
        />
      )
      // Should render image, not letter with fallback color
      expect(screen.getByRole('img')).toBeInTheDocument()
    })
  })

  describe('fallbackIcon prop', () => {
    it('renders the fallback icon instead of the letter when no avatarUrl', () => {
      render(
        <Avatar identifier="team" name="Team" fallbackIcon={<svg data-testid="room-glyph" />} />
      )
      expect(screen.getByTestId('room-glyph')).toBeInTheDocument()
      expect(screen.queryByText('T')).not.toBeInTheDocument()
    })

    it('keeps the consistent colored background behind the fallback icon', () => {
      const { container } = render(
        <Avatar identifier="team" name="Team" fallbackIcon={<svg data-testid="room-glyph" />} />
      )
      const bg = container.querySelector('[style*="background"]')
      expect(bg).toBeTruthy()
      expect(bg?.querySelector('[data-testid="room-glyph"]')).toBeTruthy()
    })

    it('ignores fallbackIcon when avatarUrl is provided', () => {
      render(
        <Avatar
          identifier="team"
          name="Team"
          avatarUrl="https://example.com/team.jpg"
          fallbackIcon={<svg data-testid="room-glyph" />}
        />
      )
      expect(screen.getByRole('img')).toBeInTheDocument()
      expect(screen.queryByTestId('room-glyph')).not.toBeInTheDocument()
    })
  })

  describe('fallbackColor used directly (matches nickname color)', () => {
    it('uses fallbackColor as-is without contrast adjustment', () => {
      const { container } = render(
        <Avatar identifier="alice" name="Alice" fallbackColor="#336699" />
      )
      const styledDiv = container.querySelector('[style*="background"]')
      expect(styledDiv).toBeTruthy()
      const style = styledDiv?.getAttribute('style') || ''
      // fallbackColor is used directly to match nickname text color
      expect(style).toContain('rgb(51, 102, 153)')
    })

    it('uses fallbackColor even for light colors', () => {
      const { container } = render(
        <Avatar identifier="alice" name="Alice" fallbackColor="#aaccff" />
      )
      const styledDiv = container.querySelector('[style*="background"]')
      expect(styledDiv).toBeTruthy()
      const style = styledDiv?.getAttribute('style') || ''
      // Light color is kept as-is for consistency with nickname
      expect(style).toContain('rgb(170, 204, 255)')
    })
  })

  describe('Presence Indicator', () => {
    it('shows presence indicator when presence prop is provided', () => {
      const { container } = render(
        <Avatar identifier="alice" name="Alice" presence="online" />
      )
      const presenceIndicator = container.querySelector('.rounded-full.border-2')
      expect(presenceIndicator).toBeInTheDocument()
    })

    it('does not show presence indicator when presence is not provided', () => {
      const { container } = render(
        <Avatar identifier="alice" name="Alice" />
      )
      const presenceIndicator = container.querySelector('.rounded-full.border-2.absolute')
      expect(presenceIndicator).not.toBeInTheDocument()
    })

    it('shows a grey (not transparent) pill when forceOffline is true', () => {
      // While the app is reconnecting, ConversationList passes forceOffline.
      // The pill must show the offline grey, never a transparent (border-only) pill.
      const { container } = render(
        <Avatar identifier="alice" name="Alice" presence="online" forceOffline />
      )
      const pill = container.querySelector('.rounded-full.border-2.absolute') as HTMLElement
      expect(pill).toBeInTheDocument()
      // Grey comes from the APP_OFFLINE_PRESENCE_COLOR class, not an inline color.
      expect(pill).toHaveClass('bg-slate-500')
      // A leftover inline backgroundColor: undefined rendered the pill transparent.
      expect(pill.style.backgroundColor).toBe('')
    })

    it('does not grey out the pill when online (not forced offline)', () => {
      const { container } = render(
        <Avatar identifier="alice" name="Alice" presence="online" />
      )
      const pill = container.querySelector('.rounded-full.border-2.absolute') as HTMLElement
      expect(pill).toBeInTheDocument()
      expect(pill).not.toHaveClass('bg-slate-500')
    })

    it('adds a colored halo to the presence dot when presenceHalo is set', () => {
      const { container } = render(
        <Avatar identifier="alice" name="Alice" presence="online" presenceHalo />
      )
      const pill = container.querySelector('.rounded-full.border-2.absolute') as HTMLElement
      expect(pill.style.boxShadow).toContain('var(--fluux-presence-online)')
    })

    it('has no presence halo by default', () => {
      const { container } = render(
        <Avatar identifier="alice" name="Alice" presence="online" />
      )
      const pill = container.querySelector('.rounded-full.border-2.absolute') as HTMLElement
      expect(pill.style.boxShadow).toBe('')
    })
  })

  describe('Sizes', () => {
    it('applies correct size classes for sm (default)', () => {
      const { container } = render(<Avatar identifier="alice" />)
      expect(container.firstChild).toHaveClass('size-8')
    })

    it('applies correct size classes for md', () => {
      const { container } = render(<Avatar identifier="alice" size="md" />)
      expect(container.firstChild).toHaveClass('size-10')
    })

    it('applies correct size classes for lg', () => {
      const { container } = render(<Avatar identifier="alice" size="lg" />)
      expect(container.firstChild).toHaveClass('size-12')
    })
  })

  describe('Image error fallback', () => {
    it('shows letter fallback when image fails to load', () => {
      render(<Avatar identifier="alice" name="Alice" avatarUrl="blob:invalid" />)
      const img = screen.getByRole('img')
      fireEvent.error(img)
      expect(screen.getByText('A')).toBeInTheDocument()
      expect(screen.queryByRole('img')).not.toBeInTheDocument()
    })

    it('resets error state when avatarUrl changes', () => {
      const { rerender } = render(
        <Avatar identifier="alice" name="Alice" avatarUrl="blob:invalid" />
      )
      fireEvent.error(screen.getByRole('img'))
      expect(screen.queryByRole('img')).not.toBeInTheDocument()

      rerender(<Avatar identifier="alice" name="Alice" avatarUrl="blob:new-valid-url" />)
      expect(screen.getByRole('img')).toBeInTheDocument()
    })
  })

  describe('Click handling', () => {
    it('has cursor-pointer class when onClick provided', () => {
      const { container } = render(
        <Avatar identifier="alice" onClick={() => {}} />
      )
      expect(container.firstChild).toHaveClass('cursor-pointer')
    })

    it('has cursor-default class when no onClick', () => {
      const { container } = render(<Avatar identifier="alice" />)
      expect(container.firstChild).toHaveClass('cursor-default')
    })

    it('has cursor-pointer when clickable prop is true', () => {
      const { container } = render(
        <Avatar identifier="alice" clickable />
      )
      expect(container.firstChild).toHaveClass('cursor-pointer')
    })
  })

  describe('Shape', () => {
    test('Avatar defaults to a circle', () => {
      const { container } = render(<Avatar identifier="emma@fluux.chat" name="Emma" />)
      expect((container.firstChild as HTMLElement).className).toContain('rounded-full')
    })

    test('Avatar shape="square" renders a rounded square', () => {
      const { container } = render(<Avatar identifier="team@conference.fluux.chat" name="Team" shape="square" />)
      const root = container.firstChild as HTMLElement
      expect(root.className).toContain('rounded-xl')
      expect(root.className).not.toContain('rounded-full')
    })

    test('square xs avatar uses a smaller radius so it stays visually square (rounded-xl at 24px is a circle)', () => {
      const { container } = render(
        <Avatar identifier="team@conference.fluux.chat" name="Team" shape="square" size="xs" />
      )
      const root = container.firstChild as HTMLElement
      // rounded-xl (12px) on a 24px box = a full circle; xs must use rounded-lg (8px).
      expect(root.className).toContain('rounded-lg')
      expect(root.className).not.toContain('rounded-xl')
      expect(root.className).not.toContain('rounded-full')
    })
  })
})

describe('Avatar — animated GIF freeze-on-hover', () => {
  const STATIC_DATA_URL = 'data:image/png;base64,FROZEN'
  let fetchSpy: ReturnType<typeof vi.fn>
  let OriginalImage: typeof Image

  // Minimal Image stub: fires onload asynchronously once `src` is assigned,
  // so the extraction effect (which sets onload *before* src) runs to completion.
  class MockImage {
    onload: (() => void) | null = null
    naturalWidth = 48
    naturalHeight = 48
    set src(_v: string) {
      queueMicrotask(() => this.onload?.())
    }
  }

  // Extraction sniffs the image bytes (not the MIME type), so each response
  // carries real magic bytes. Minimal but valid signatures per format:
  const GIF89A = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]
  const APNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x61, 0x63, 0x54, 0x4c] // PNG sig + acTL
  const STATIC_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x49, 0x44, 0x41, 0x54] // PNG sig + IDAT
  const WEBP_ANIMATED = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x41, 0x4e, 0x49, 0x4d] // RIFF/WEBP + ANIM
  const respondWithBytes = (bytes: number[]) =>
    fetchSpy.mockResolvedValue({ arrayBuffer: () => Promise.resolve(new Uint8Array(bytes).buffer) })

  beforeEach(() => {
    fetchSpy = vi.fn()
    respondWithBytes(GIF89A)
    global.fetch = fetchSpy as unknown as typeof fetch
    OriginalImage = global.Image
    global.Image = MockImage as unknown as typeof Image
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(STATIC_DATA_URL)
  })

  afterEach(() => {
    global.Image = OriginalImage
    vi.restoreAllMocks()
  })

  it('freezes an animated GIF to its first frame after extraction', async () => {
    const url = 'blob:gif-freeze'
    render(<Avatar identifier="alice" name="Alice" avatarUrl={url} />)
    // The live (animated) URL shows while the first frame is being extracted.
    expect(screen.getByRole('img')).toHaveAttribute('src', url)
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', STATIC_DATA_URL)
    )
  })

  it('freezes an animated avatar that is not a GIF (e.g. APNG delivered as image/png)', async () => {
    // Real-world: the SDK occupant-avatar path hardcodes/defaults the stored
    // type to image/png (Profile.ts), and many animated avatars are APNG or
    // animated WebP, not GIF. Freezing must key off the actual image bytes, not
    // the declared mime type, or these animate forever (kuyuhi in #XSF).
    respondWithBytes(APNG)
    const url = 'blob:apng-freeze'
    render(<Avatar identifier="kuyuhi" name="kuyuhi" avatarUrl={url} />)
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', STATIC_DATA_URL)
    )
  })

  it('freezes an animated WebP avatar', async () => {
    respondWithBytes(WEBP_ANIMATED)
    const url = 'blob:webp-freeze'
    render(<Avatar identifier="dave" name="Dave" avatarUrl={url} />)
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', STATIC_DATA_URL)
    )
  })

  it('shows the cached static frame synchronously on remount (no replay)', async () => {
    // Regression: virtualized message rows unmount/remount on scroll. The frozen
    // frame must be applied on the first render of the new instance, without a
    // fresh fetch/decode — otherwise the GIF replays every time it scrolls in.
    const url = 'blob:gif-remount'
    const { unmount } = render(<Avatar identifier="alice" name="Alice" avatarUrl={url} />)
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', STATIC_DATA_URL)
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    unmount()

    render(<Avatar identifier="alice" name="Alice" avatarUrl={url} />)
    expect(screen.getByRole('img')).toHaveAttribute('src', STATIC_DATA_URL)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('caches the frozen frame even when the row unmounts mid-extraction (fast scroll)', async () => {
    // The whole point of the module-level cache is virtualized scrolling, where
    // rows mount and unmount in quick succession. Extraction (fetch -> decode ->
    // canvas) is async and takes longer than a fast scroll-past, so the row
    // unmounts *before* it finishes. The cache must still be populated by that
    // in-flight extraction — otherwise it never fills during scrolling and every
    // scroll-in replays the GIF, defeating the fix entirely.
    const url = 'blob:gif-fastscroll'
    const { unmount } = render(<Avatar identifier="alice" name="Alice" avatarUrl={url} />)
    // Scroll past: unmount immediately, before the extraction microtasks resolve.
    unmount()

    // Let the background extraction run to completion despite the unmount.
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 0))

    // Scroll back into view: the frozen frame is applied on the first render with
    // no second fetch, because the earlier extraction populated the shared cache.
    render(<Avatar identifier="alice" name="Alice" avatarUrl={url} />)
    expect(screen.getByRole('img')).toHaveAttribute('src', STATIC_DATA_URL)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('plays the GIF on hover and re-freezes on mouse leave', async () => {
    const url = 'blob:gif-hover'
    const { container } = render(<Avatar identifier="alice" name="Alice" avatarUrl={url} />)
    await waitFor(() =>
      expect(screen.getByRole('img')).toHaveAttribute('src', STATIC_DATA_URL)
    )
    fireEvent.mouseEnter(container.firstChild as Element)
    expect(screen.getByRole('img')).toHaveAttribute('src', url)
    fireEvent.mouseLeave(container.firstChild as Element)
    expect(screen.getByRole('img')).toHaveAttribute('src', STATIC_DATA_URL)
  })

  it('never freezes a static image (PNG with no acTL chunk)', async () => {
    respondWithBytes(STATIC_PNG)
    const url = 'blob:png-static'
    render(<Avatar identifier="alice" name="Alice" avatarUrl={url} />)
    expect(screen.getByRole('img')).toHaveAttribute('src', url)
    // Let any extraction microtasks flush; the src must stay the live URL.
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.getByRole('img')).toHaveAttribute('src', url)
  })
})

describe('Avatar — fallbackTextColor + presenceHalo', () => {
  it('renders the fallback letter in fallbackTextColor when provided', () => {
    const { getByText } = render(
      <Avatar identifier="maya" name="Maya" fallbackColor="#A9B4FF" fallbackTextColor="#000000" />
    )
    const letter = getByText('M')
    expect(letter).toHaveStyle({ color: '#000000' })
  })

  it('defaults the fallback letter to white (back-compat)', () => {
    const { getByText } = render(<Avatar identifier="sam" name="Sam" />)
    expect(getByText('S')).toHaveStyle({ color: '#ffffff' })
  })
})

describe('getConsistentTextColor', () => {
  it('returns a color string', () => {
    const color = getConsistentTextColor('alice')
    expect(color).toMatch(/^#[0-9a-f]{6}$/i)
  })

  it('returns same color for same identifier', () => {
    const color1 = getConsistentTextColor('alice')
    const color2 = getConsistentTextColor('alice')
    expect(color1).toBe(color2)
  })

  it('returns different colors for different identifiers', () => {
    const color1 = getConsistentTextColor('alice')
    const color2 = getConsistentTextColor('bob')
    expect(color1).not.toBe(color2)
  })
})
