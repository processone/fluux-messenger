import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { AppearanceSettings } from './AppearanceSettings'
import type { ThemeDefinition, SnippetState } from '@/themes/types'
import { useSettingsStore } from '@/stores/settingsStore'

const themeState = vi.hoisted(() => ({
  activeThemeId: 'aurora',
  themes: [] as ThemeDefinition[],
  snippets: [] as SnippetState[],
  toggleSnippet: vi.fn(),
  setActiveTheme: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { count?: number }) => options?.count === undefined ? key : `${key}: ${options.count}` }),
}))

vi.mock('@/stores/themeStore', () => ({
  useThemeStore: (selector: (s: unknown) => unknown) => {
    const state = {
      activeThemeId: themeState.activeThemeId,
      setActiveTheme: themeState.setActiveTheme,
      getAllThemes: () => themeState.themes,
      installTheme: vi.fn(),
      removeTheme: vi.fn(),
      accentPreset: null,
      setAccentPreset: vi.fn(),
      clearAccentPreset: vi.fn(),
      getAccentPresets: () => [],
      snippets: themeState.snippets,
      toggleSnippet: themeState.toggleSnippet,
      addSnippet: vi.fn(),
      removeSnippet: vi.fn(),
    }
    return selector(state)
  },
}))

vi.mock('@/themes/builtins', () => ({
  getBuiltinTheme: (id: string) => id === 'aurora' ? { id } : null,
}))

beforeEach(() => {
  themeState.activeThemeId = 'aurora'
  themeState.themes = [{ id: 'aurora', name: 'Aurora', author: 'Fluux', version: '1', description: '', variables: {}, swatches: { light: ['#112233', '#445566'], dark: ['#112233', '#445566'] } }]
  themeState.snippets = []
  vi.clearAllMocks()
  useSettingsStore.setState({ densityMode: 'comfortable', readingWidthEnabled: false, readingWidth: 760 })
})

describe('AppearanceSettings', () => {
  it('does not offer conversation width controls', () => {
    useSettingsStore.setState({ readingWidthEnabled: true })
    render(<AppearanceSettings />)
    expect(screen.queryByRole('switch', { name: 'settings.limitReadingWidth' })).toBeNull()
    expect(screen.queryByRole('slider', { name: 'settings.readingWidth' })).toBeNull()
  })

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


describe('Appearance customization hierarchy', () => {
  it('keeps named theme previews visible while import and CSS tools are collapsed', () => {
    render(<AppearanceSettings />)
    const theme = screen.getByRole('button', { name: 'Aurora' })
    expect(theme).toBeVisible()
    expect(theme.querySelector('[style]')).toHaveStyle({ backgroundColor: '#112233' })
    expect(screen.queryByRole('button', { name: 'settings.importTheme' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'settings.addCustomCss' })).toBeNull()
    const disclosure = screen.getByRole('button', { name: 'settings.advancedCustomization' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(theme)
    expect(themeState.setActiveTheme).toHaveBeenCalledWith('aurora')
    fireEvent.click(disclosure)
    expect(screen.getByRole('button', { name: 'settings.importTheme' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'settings.addCustomCss' })).toBeVisible()
    fireEvent.click(disclosure)
    expect(theme).toBeVisible()
  })

  it('shows only enabled CSS in the collapsed summary and keeps toggles usable', () => {
    themeState.snippets = [
      { id: 'a', filename: 'active.css', enabled: true, css: '' },
      { id: 'b', filename: 'inactive.css', enabled: false, css: '' },
    ]
    render(<AppearanceSettings />)
    expect(screen.getByText('settings.activeCss: 1')).toBeVisible()
    expect(screen.queryByRole('switch', { name: 'active.css' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'settings.advancedCustomization' }))
    fireEvent.click(screen.getByRole('switch', { name: 'active.css' }))
    expect(themeState.toggleSnippet).toHaveBeenCalledWith('a')
  })

  it('identifies the active imported theme without requiring the tools to be opened', () => {
    themeState.themes.push({ ...themeState.themes[0], id: 'custom', name: 'My theme' })
    themeState.activeThemeId = 'custom'
    render(<AppearanceSettings />)
    expect(screen.getByText('settings.theme: My theme')).toBeVisible()
    expect(screen.getByRole('button', { name: 'settings.advancedCustomization' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('does not show an active customization summary for disabled CSS and a built-in theme', () => {
    themeState.snippets = [{ id: 'a', filename: 'inactive.css', enabled: false, css: '' }]
    render(<AppearanceSettings />)
    expect(screen.queryByText(/settings.activeCss/)).toBeNull()
    expect(screen.queryByText('settings.theme: Aurora')).toBeNull()
  })
})
