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

  it('renders the label in the danger color when danger is true', () => {
    render(<SettingsRow label="Delete account" danger onClick={() => {}} />)
    expect(screen.getByText('Delete account')).toHaveClass('text-fluux-error')
    expect(screen.getByText('Delete account')).not.toHaveClass('text-fluux-text')
  })

  it('renders the label in the default color when danger is omitted', () => {
    render(<SettingsRow label="Change password" onClick={() => {}} />)
    expect(screen.getByText('Change password')).toHaveClass('text-fluux-text')
  })

  it('renders a disabled button and does not fire onClick when disabled is true', () => {
    const onClick = vi.fn()
    render(<SettingsRow label="Delete account" onClick={onClick} disabled />)
    const row = screen.getByRole('button', { name: /delete account/i })
    expect(row).toBeDisabled()
    fireEvent.click(row)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders an enabled button when disabled is omitted', () => {
    render(<SettingsRow label="Change password" onClick={() => {}} />)
    expect(screen.getByRole('button', { name: /change password/i })).not.toBeDisabled()
  })
})
