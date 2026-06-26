/**
 * @vitest-environment jsdom
 *
 * Pinned to jsdom: this file checks inline color/gradient styles whose serialization
 * differs between DOM environments (jsdom normalizes #hex to rgb(); happy-dom, the
 * default env, keeps the literal). These assertions/snapshots only hold under jsdom.
 */
import { describe, it, expect, vi, test } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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
})

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
