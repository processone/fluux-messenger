import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SecurityGlanceCard } from './SecurityGlanceCard'

describe('SecurityGlanceCard', () => {
  it('shows verified label and calls onOpen when clicked', () => {
    const onOpen = vi.fn()
    render(<SecurityGlanceCard state={{ kind: 'encrypted', fingerprint: 'AB', trust: 'verified' }} onOpen={onOpen} />)
    const btn = screen.getByRole('button', { name: 'Verified and encrypted' })
    fireEvent.click(btn)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('shows unverified label for an unverified encrypted state', () => {
    render(<SecurityGlanceCard state={{ kind: 'encrypted', fingerprint: 'AB', trust: 'unverified' }} onOpen={() => {}} />)
    expect(screen.getByText('Encrypted, not verified')).toBeInTheDocument()
  })

  it('renders nothing for the disabled state', () => {
    const { container } = render(<SecurityGlanceCard state={{ kind: 'disabled' }} onOpen={() => {}} />)
    expect(container).toBeEmptyDOMElement()
  })
})
