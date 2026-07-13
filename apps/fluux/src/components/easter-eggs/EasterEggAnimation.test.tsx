// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EasterEggAnimation } from './EasterEggAnimation'

vi.mock('./ChristmasAnimation', () => ({
  ChristmasAnimation: () => <div data-testid="christmas-overlay" />,
}))
vi.mock('./FireworksAnimation', () => ({
  FireworksAnimation: () => <div data-testid="fireworks-overlay" />,
}))

describe('EasterEggAnimation', () => {
  it("renders the christmas overlay for 'christmas'", () => {
    render(<EasterEggAnimation animation="christmas" onComplete={vi.fn()} />)
    expect(screen.getByTestId('christmas-overlay')).toBeInTheDocument()
  })

  it("renders the fireworks overlay for 'fireworks'", () => {
    render(<EasterEggAnimation animation="fireworks" onComplete={vi.fn()} />)
    expect(screen.getByTestId('fireworks-overlay')).toBeInTheDocument()
  })

  it('renders nothing for unknown animation names (forward compatibility)', () => {
    const { container } = render(
      <EasterEggAnimation animation="disco-2030" onComplete={vi.fn()} />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing for prototype-chain keys arriving from the wire', () => {
    for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
      const { container, unmount } = render(
        <EasterEggAnimation animation={name} onComplete={vi.fn()} />,
      )
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })
})
