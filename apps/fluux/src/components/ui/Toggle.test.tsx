import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { Toggle } from './Toggle'

describe('Toggle', () => {
  it('exposes role=switch + aria-checked and toggles on click', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} aria-label="Sounds" />)
    const sw = screen.getByRole('switch', { name: 'Sounds' })
    expect(sw).toHaveAttribute('aria-checked', 'false')
    fireEvent.click(sw)
    expect(onChange).toHaveBeenCalledWith(true)
  })
  it('does not fire onChange when disabled', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} disabled aria-label="Sounds" />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
