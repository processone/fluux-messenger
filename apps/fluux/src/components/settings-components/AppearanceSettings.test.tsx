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
  it('renders the density toggle and switches density', () => {
    render(<AppearanceSettings />)
    const compact = screen.getByRole('button', { name: /compact/i })
    fireEvent.click(compact)
    expect(useSettingsStore.getState().densityMode).toBe('compact')
  })

  it('shows comfortable as selected by default', () => {
    render(<AppearanceSettings />)
    expect(useSettingsStore.getState().densityMode).toBe('comfortable')
  })
})
