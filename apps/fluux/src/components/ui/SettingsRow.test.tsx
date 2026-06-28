import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { SettingsRow } from './SettingsRow'

describe('SettingsRow', () => {
  it('renders a non-interactive div when no onClick is given', () => {
    render(<SettingsRow label="Theme" description="Pick a theme" />)
    expect(screen.getByText('Theme')).toBeInTheDocument()
    expect(screen.getByText('Pick a theme')).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('renders the whole row as a button and fires onClick when clicked', () => {
    const onClick = vi.fn()
    render(<SettingsRow label="Change password" onClick={onClick} />)
    const row = screen.getByRole('button', { name: /change password/i })
    expect(row).toHaveClass('w-full')
    // Clicking anywhere on the row (here: the label text) triggers the action
    fireEvent.click(screen.getByText('Change password'))
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
