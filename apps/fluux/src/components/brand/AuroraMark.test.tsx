import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { AuroraMark } from './AuroraMark'

describe('AuroraMark', () => {
  it('renders a decorative aria-hidden svg with the aurora-mark class', () => {
    const { container } = render(<AuroraMark />)
    const svg = container.querySelector('svg.aurora-mark')
    expect(svg).not.toBeNull()
    expect(svg!.getAttribute('aria-hidden')).toBe('true')
  })

  it('renders all five layers of the G2 recipe', () => {
    const { container } = render(<AuroraMark />)
    expect(container.querySelectorAll('.aurora-mark-backlight ellipse')).toHaveLength(3)
    expect(container.querySelector('.aurora-mark-pane')).not.toBeNull()
    expect(container.querySelectorAll('.aurora-mark-lens ellipse')).toHaveLength(3)
    expect(container.querySelector('.aurora-mark-rim-glow')).not.toBeNull()
    expect(container.querySelector('.aurora-mark-rim')).not.toBeNull()
    expect(container.querySelector('.aurora-mark-hairline-dark')).not.toBeNull()
    expect(container.querySelector('.aurora-mark-hairline-light')).not.toBeNull()
  })

  it('renders the deterministic 8-star field (dark-mode layer)', () => {
    const { container } = render(<AuroraMark />)
    expect(container.querySelectorAll('.aurora-mark-stars circle')).toHaveLength(8)
    // determinism: two renders agree on the first star position
    const { container: c2 } = render(<AuroraMark />)
    expect(container.querySelector('.aurora-mark-stars circle')!.getAttribute('cx')).toBe(
      c2.querySelector('.aurora-mark-stars circle')!.getAttribute('cx'),
    )
  })

  it('respects the size prop', () => {
    const { container } = render(<AuroraMark size={100} />)
    expect(container.querySelector('svg')!.getAttribute('width')).toBe('100')
  })
})
