import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AdvancedSettings } from './AdvancedSettings'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  useAdvancedModeStore.setState({ advancedMode: false })
})

describe('AdvancedSettings', () => {
  it('shows the enable control (and no disable control) when advanced mode is OFF', () => {
    useAdvancedModeStore.getState().setAdvancedMode(false)
    render(<AdvancedSettings />)
    expect(screen.getByRole('button', { name: 'settings.advanced.enable' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.advanced.disable' })).not.toBeInTheDocument()
  })

  it('enables advanced mode when the enable button is clicked', () => {
    useAdvancedModeStore.getState().setAdvancedMode(false)
    render(<AdvancedSettings />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.advanced.enable' }))
    expect(useAdvancedModeStore.getState().advancedMode).toBe(true)
  })

  it('shows the disable control (and no enable control) when advanced mode is ON', () => {
    useAdvancedModeStore.getState().setAdvancedMode(true)
    render(<AdvancedSettings />)
    expect(screen.getByRole('button', { name: 'settings.advanced.disable' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.advanced.enable' })).not.toBeInTheDocument()
  })
})
