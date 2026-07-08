import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { HollowIconMark } from './HollowIconMark'
import { MESSAGE_BUBBLE_PATH, GLYPH_TRANSFORM } from './messageBubbleGlyph'

describe('HollowIconMark', () => {
  it('renders a decorative 1024 viewBox svg with the hollow-icon-mark class', () => {
    const { container } = render(<HollowIconMark size={72} />)
    const svg = container.querySelector('svg.hollow-icon-mark')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('viewBox')).toBe('0 0 1024 1024')
    expect(svg!.getAttribute('aria-hidden')).toBe('true')
    expect(svg!.getAttribute('width')).toBe('72')
  })

  it('draws the pinned MessageCircle glyph at the agreed transform', () => {
    const { container } = render(<HollowIconMark />)
    const path = container.querySelector('path[d="' + MESSAGE_BUBBLE_PATH + '"]')
    expect(path).not.toBeNull()
    expect(path!.getAttribute('stroke')).toBe('#FFFFFF')
    expect(path!.getAttribute('fill')).toBe('none')
    // the glyph sits inside a group carrying the agreed transform
    const group = container.querySelector(`g[transform="${GLYPH_TRANSFORM}"]`)
    expect(group).not.toBeNull()
  })

  it('forwards an extra className alongside the base class', () => {
    const { container } = render(<HollowIconMark className="relative" />)
    const svg = container.querySelector('svg.hollow-icon-mark.relative')
    expect(svg).not.toBeNull()
  })
})
