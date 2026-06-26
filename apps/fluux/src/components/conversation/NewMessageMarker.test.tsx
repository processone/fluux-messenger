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
})
