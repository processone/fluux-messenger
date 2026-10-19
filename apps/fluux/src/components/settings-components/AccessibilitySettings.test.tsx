import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AccessibilitySettings } from './AccessibilitySettings'
import { useSettingsStore } from '@/stores/settingsStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

beforeEach(() => {
  useSettingsStore.setState({ motionPreference: 'system', transparencyMode: 'system', fontSize: 100, readingWidthEnabled: false, readingWidth: 760 })
})

describe('AccessibilitySettings', () => {
  it('renders Animation, Transparency, and Character size, and switches transparency', () => {
    render(<AccessibilitySettings />)
    expect(screen.getByText('settings.motion')).toBeInTheDocument()
    expect(screen.getByText('settings.transparency')).toBeInTheDocument()
    expect(screen.getByText('settings.fontSize')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /transparencyReduced/i }))
    expect(useSettingsStore.getState().transparencyMode).toBe('reduced')
  })

  it('keeps the accessibility panel width stable when transparency changes', () => {
    const { container } = render(<AccessibilitySettings />)
    const panel = container.firstElementChild
    expect(panel).toHaveClass('w-full', 'max-w-md')

    const initialClassName = panel?.className
    fireEvent.click(screen.getByRole('button', { name: /transparencyFull/i }))
    expect(panel?.className).toBe(initialClassName)

    const transparencyButton = screen.getByRole('button', { name: /transparencyFull/i })
    expect(transparencyButton).toHaveClass('min-w-0')
  })

  it('switches motion preference', () => {
    render(<AccessibilitySettings />)
    fireEvent.click(screen.getByRole('button', { name: /motionFull/i }))
    expect(useSettingsStore.getState().motionPreference).toBe('full')
  })

  it('renders font size slider and adjusts font size', () => {
    render(<AccessibilitySettings />)
    const slider = screen.getByRole('slider')
    expect(slider).toBeInTheDocument()
    fireEvent.change(slider, { target: { value: '125' } })
    expect(useSettingsStore.getState().fontSize).toBe(125)
  })
})

describe('conversation reading width', () => {
  it('starts full width, offers a 760 px slider on opt-in, and remembers its width', () => {
    render(<AccessibilitySettings />)
    const toggle = screen.getByRole('switch', { name: 'settings.limitReadingWidth' })
    expect(toggle).toHaveAttribute('aria-checked', 'false')
    expect(screen.queryByRole('slider', { name: 'settings.readingWidth' })).toBeNull()
    fireEvent.click(toggle)
    expect(toggle).toHaveAttribute('aria-checked', 'true')
    const slider = screen.getByRole('slider', { name: 'settings.readingWidth' })
    expect(slider).toHaveValue('760')
    expect(slider).toHaveAttribute('min', '560')
    expect(slider).toHaveAttribute('max', '1120')
    expect(slider).toHaveAttribute('step', '40')
    fireEvent.change(slider, { target: { value: '920' } })
    expect(useSettingsStore.getState().readingWidth).toBe(920)
    fireEvent.click(toggle)
    expect(useSettingsStore.getState().readingWidthEnabled).toBe(false)
    expect(screen.queryByRole('slider', { name: 'settings.readingWidth' })).toBeNull()
    fireEvent.click(toggle)
    expect(screen.getByRole('slider', { name: 'settings.readingWidth' })).toHaveValue('920')
  })
})
