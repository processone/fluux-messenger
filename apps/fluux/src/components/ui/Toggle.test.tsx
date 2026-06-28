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

  it('shows cursor-wait (not cursor-not-allowed) while loading, even when also disabled', () => {
    // The async-pending affordance: a toggle mid-operation reads as "busy",
    // not "blocked". EncryptionSettings drives both at once (disabled covers
    // isToggling AND the PEP gate), so cursor-wait must win over the
    // disabled cursor-not-allowed.
    const onChange = vi.fn()
    render(<Toggle checked onChange={onChange} disabled loading aria-label="Sounds" />)
    const sw = screen.getByRole('switch', { name: 'Sounds' })
    expect(sw.className).toContain('cursor-wait')
    expect(sw.className).not.toContain('cursor-not-allowed')
  })

  it('does not fire onChange while loading', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} loading aria-label="Sounds" />)
    fireEvent.click(screen.getByRole('switch'))
    expect(onChange).not.toHaveBeenCalled()
  })
})
