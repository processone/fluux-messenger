import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppearanceSettings } from './AppearanceSettings'
import { useSettingsStore } from '@/stores/settingsStore'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/stores/themeStore', () => ({
  useThemeStore: (selector: (s: unknown) => unknown) => {
    const state = {
      activeThemeId: 'aurora',
      setActiveTheme: vi.fn(),
      getAllThemes: () => [],
      installTheme: vi.fn(),
      removeTheme: vi.fn(),
      accentPreset: null,
      setAccentPreset: vi.fn(),
      clearAccentPreset: vi.fn(),
      getAccentPresets: () => [],
      snippets: [],
      toggleSnippet: vi.fn(),
      addSnippet: vi.fn(),
      removeSnippet: vi.fn(),
    }
    return selector(state)
  },
}))

vi.mock('@/themes/builtins', () => ({
  getBuiltinTheme: () => null,
}))

beforeEach(() => {
  useSettingsStore.setState({ densityMode: 'comfortable' })
})

describe('AppearanceSettings', () => {
  it('keeps the appearance panel width stable when mode and density change', () => {
    const { container } = render(<AppearanceSettings />)
    const panel = container.firstElementChild
    expect(panel).toHaveClass('w-full', 'max-w-md')

    const initialClassName = panel?.className
    fireEvent.click(screen.getByRole('button', { name: /settings\.light/i }))
    fireEvent.click(screen.getByRole('button', { name: /settings\.compact/i }))
    expect(panel?.className).toBe(initialClassName)

    expect(screen.getByRole('button', { name: /settings\.light/i })).toHaveClass('min-w-0')
    expect(screen.getByRole('button', { name: /settings\.compact/i })).toHaveClass('min-w-0')
  })

  it('renders the density toggle and switches density', () => {
    render(<AppearanceSettings />)
    const compact = screen.getByRole('button', { name: /compact/i })
    fireEvent.click(compact)
    expect(useSettingsStore.getState().densityMode).toBe('compact')
  })

  it('renders the comfortable option as selected by default', () => {
    render(<AppearanceSettings />)
    const comfortable = screen.getByRole('button', { name: /settings\.comfortable/i })
    expect(comfortable.className).toContain('border-fluux-brand')
  })
})
