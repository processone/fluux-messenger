import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AdvancedSettings } from './AdvancedSettings'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  useAdvancedModeStore.getState().setAdvancedMode(false)
})

describe('AdvancedSettings', () => {
  it.each([false, true])('shows the current advanced mode state (%s) on a stable named switch', enabled => {
    useAdvancedModeStore.getState().setAdvancedMode(enabled)
    render(<AdvancedSettings />)
    expect(screen.getByRole('switch', { name: 'login.advancedMode' }))
      .toHaveAttribute('aria-checked', String(enabled))
  })

  it('keeps the switch reachable through an enable and disable cycle and persists each choice', () => {
    render(<AdvancedSettings />)
    const toggle = screen.getByRole('switch', { name: 'login.advancedMode' })
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    expect(useAdvancedModeStore.getState().advancedMode).toBe(true)
    expect(localStorage.getItem('fluux-advanced-mode')).toBe('true')
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(localStorage.getItem('fluux-advanced-mode')).toBe('false')
  })

  it('makes tool locations available on demand without hiding the mode control', () => {
    render(<AdvancedSettings />)
    const help = screen.getByRole('button', { name: 'settings.advanced.toolLocations' })
    expect(help).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(help)
    expect(screen.getByText('settings.advanced.consoleLocation')).toBeVisible()
    expect(screen.getByText('settings.advanced.serverLocation')).toBeVisible()
    expect(screen.getByRole('switch', { name: 'login.advancedMode' })).toBeVisible()
    fireEvent.click(help)
    expect(screen.getByText('settings.advanced.consoleLocation')).not.toBeVisible()
  })
})
