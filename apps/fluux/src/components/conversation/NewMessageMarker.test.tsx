import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import { NewMessageMarker } from './NewMessageMarker'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}))

describe('NewMessageMarker', () => {
  it('uses the accent color, not alarm-red', () => {
    const { container } = render(<NewMessageMarker />)
    expect(container.querySelector('.bg-fluux-red')).not.toBeInTheDocument()
    expect(container.querySelector('.text-fluux-error')).not.toBeInTheDocument()
    // lines + label carry the AA-safe accent-family color via inline style
    const styled = container.querySelectorAll('[style*="--fluux-text-self"]')
    expect(styled.length).toBe(3)
  })

  // Provisional = derived from the local read pointer while a synced XEP-0490
  // read position is still unresolved; it may move or vanish once the marker
  // resolves, so it renders muted rather than looking definitive.
  it('renders muted grey when provisional', () => {
    const { container } = render(<NewMessageMarker provisional />)
    const marker = container.querySelector('[data-new-message-marker]') as HTMLElement
    expect(marker?.dataset.provisional).toBe('true')
    expect(container.querySelectorAll('[style*="--fluux-text-muted"]').length).toBe(3)
    expect(container.querySelectorAll('[style*="--fluux-text-self"]').length).toBe(0)
  })

  it('is not marked provisional by default', () => {
    const { container } = render(<NewMessageMarker />)
    const marker = container.querySelector('[data-new-message-marker]') as HTMLElement
    expect(marker?.dataset.provisional).toBeUndefined()
  })
})
