import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useThemeStore } from './themeStore'
import type { ThemeDefinition } from '@/themes/types'

const customTheme: ThemeDefinition = {
  id: 'test-custom',
  name: 'Test Custom',
  author: 'Test',
  version: '1.0.0',
  description: 'A test theme',
  variables: {
    dark: { '--fluux-base-10': '#111111' },
    light: { '--fluux-base-10': '#eeeeee' },
  },
}

const anotherTheme: ThemeDefinition = {
  id: 'another',
  name: 'Another',
  author: 'Test',
  version: '1.0.0',
  description: 'Another test theme',
  variables: {
    dark: { '--fluux-base-10': '#222222' },
  },
}

function resetStore() {
  useThemeStore.setState({
    activeThemeId: 'fluux',
    customThemes: [],
    snippets: [],
  })
}

describe('themeStore', () => {
  beforeEach(() => {
    vi.mocked(localStorage.clear).mockClear()
    vi.mocked(localStorage.getItem).mockClear()
    vi.mocked(localStorage.setItem).mockClear()
    vi.mocked(localStorage.getItem).mockReturnValue(null)
    resetStore()
  })

  describe('initial state', () => {
    it('should default to fluux theme', () => {
      expect(useThemeStore.getState().activeThemeId).toBe('fluux')
    })

    it('should have no custom themes', () => {
      expect(useThemeStore.getState().customThemes).toEqual([])
    })

    it('should have no snippets', () => {
      expect(useThemeStore.getState().snippets).toEqual([])
    })
  })

  describe('setActiveTheme', () => {
    it('should switch active theme', () => {
      useThemeStore.getState().setActiveTheme('nord')
      expect(useThemeStore.getState().activeThemeId).toBe('nord')
    })

    it('should persist to localStorage', () => {
      useThemeStore.getState().setActiveTheme('nord')
      expect(localStorage.setItem).toHaveBeenCalled()
      const stored = JSON.parse(vi.mocked(localStorage.setItem).mock.calls.at(-1)![1])
      expect(stored.activeThemeId).toBe('nord')
    })
  })

  describe('installTheme', () => {
    it('should add a custom theme', () => {
      useThemeStore.getState().installTheme(customTheme)
      expect(useThemeStore.getState().customThemes).toHaveLength(1)
      expect(useThemeStore.getState().customThemes[0].id).toBe('test-custom')
    })

    it('should replace existing theme with same ID', () => {
      useThemeStore.getState().installTheme(customTheme)
      const updated = { ...customTheme, name: 'Updated Name' }
      useThemeStore.getState().installTheme(updated)
      expect(useThemeStore.getState().customThemes).toHaveLength(1)
      expect(useThemeStore.getState().customThemes[0].name).toBe('Updated Name')
    })

    it('should allow multiple custom themes', () => {
      useThemeStore.getState().installTheme(customTheme)
      useThemeStore.getState().installTheme(anotherTheme)
      expect(useThemeStore.getState().customThemes).toHaveLength(2)
    })
  })

  describe('removeTheme', () => {
    it('should remove a custom theme', () => {
      useThemeStore.getState().installTheme(customTheme)
      useThemeStore.getState().removeTheme('test-custom')
      expect(useThemeStore.getState().customThemes).toHaveLength(0)
    })

    it('should reset to fluux if removing the active theme', () => {
      useThemeStore.getState().installTheme(customTheme)
      useThemeStore.getState().setActiveTheme('test-custom')
      useThemeStore.getState().removeTheme('test-custom')
      expect(useThemeStore.getState().activeThemeId).toBe('fluux')
    })

    it('should not reset active theme when removing a non-active theme', () => {
      useThemeStore.getState().installTheme(customTheme)
      useThemeStore.getState().installTheme(anotherTheme)
      useThemeStore.getState().setActiveTheme('test-custom')
      useThemeStore.getState().removeTheme('another')
      expect(useThemeStore.getState().activeThemeId).toBe('test-custom')
    })

    it('should not remove built-in themes', () => {
      useThemeStore.getState().removeTheme('fluux')
      // fluux is still the active theme — nothing changed
      expect(useThemeStore.getState().activeThemeId).toBe('fluux')

      useThemeStore.getState().removeTheme('nord')
      // nord is still available as built-in
      const allThemes = useThemeStore.getState().getAllThemes()
      expect(allThemes.find(t => t.id === 'nord')).toBeDefined()
    })
  })

  describe('snippets', () => {
    it('should add a snippet', () => {
      useThemeStore.getState().addSnippet('compact-mode.css', 'body { font-size: 14px; }')
      const { snippets } = useThemeStore.getState()
      expect(snippets).toHaveLength(1)
      expect(snippets[0].id).toBe('compact-mode')
      expect(snippets[0].filename).toBe('compact-mode.css')
      expect(snippets[0].enabled).toBe(true)
      expect(snippets[0].css).toBe('body { font-size: 14px; }')
    })

    it('should toggle a snippet off and on', () => {
      useThemeStore.getState().addSnippet('test.css', '.foo {}')
      useThemeStore.getState().toggleSnippet('test')
      expect(useThemeStore.getState().snippets[0].enabled).toBe(false)

      useThemeStore.getState().toggleSnippet('test')
      expect(useThemeStore.getState().snippets[0].enabled).toBe(true)
    })

    it('should remove a snippet', () => {
      useThemeStore.getState().addSnippet('a.css', '.a {}')
      useThemeStore.getState().addSnippet('b.css', '.b {}')
      useThemeStore.getState().removeSnippet('a')
      expect(useThemeStore.getState().snippets).toHaveLength(1)
      expect(useThemeStore.getState().snippets[0].id).toBe('b')
    })

    it('should replace snippet with same filename', () => {
      useThemeStore.getState().addSnippet('test.css', '.old {}')
      useThemeStore.getState().addSnippet('test.css', '.new {}')
      expect(useThemeStore.getState().snippets).toHaveLength(1)
      expect(useThemeStore.getState().snippets[0].css).toBe('.new {}')
    })
  })

  describe('getActiveTheme', () => {
    it('should return built-in theme by default', () => {
      const theme = useThemeStore.getState().getActiveTheme()
      expect(theme).toBeDefined()
      expect(theme!.id).toBe('fluux')
    })

    it('should return a custom theme when active', () => {
      useThemeStore.getState().installTheme(customTheme)
      useThemeStore.getState().setActiveTheme('test-custom')
      const theme = useThemeStore.getState().getActiveTheme()
      expect(theme).toBeDefined()
      expect(theme!.id).toBe('test-custom')
    })

    it('should return undefined for unknown theme ID', () => {
      useThemeStore.setState({ activeThemeId: 'nonexistent' })
      const theme = useThemeStore.getState().getActiveTheme()
      expect(theme).toBeUndefined()
    })
  })

  describe('getAllThemes', () => {
    it('should include all built-in themes', () => {
      const themes = useThemeStore.getState().getAllThemes()
      const ids = themes.map(t => t.id)
      expect(ids).toContain('fluux')
      expect(ids).toContain('dracula')
      expect(ids).toContain('nord')
      expect(ids).toContain('gruvbox')
      expect(ids).toContain('catppuccin-mocha')
      expect(ids).toContain('solarized')
      expect(ids).toContain('one-dark')
      expect(ids).toContain('tokyo-night')
      expect(ids).toContain('monokai')
      expect(ids).toContain('rose-pine')
      expect(ids).toContain('kanagawa')
      expect(ids).toContain('github')
    })

    it('should include custom themes after built-ins', () => {
      useThemeStore.getState().installTheme(customTheme)
      const themes = useThemeStore.getState().getAllThemes()
      expect(themes.at(-1)!.id).toBe('test-custom')
    })
  })

  describe('localStorage persistence', () => {
    it('should handle localStorage errors gracefully', () => {
      vi.mocked(localStorage.setItem).mockImplementation(() => {
        throw new Error('Storage quota exceeded')
      })

      expect(() => {
        useThemeStore.getState().setActiveTheme('nord')
      }).not.toThrow()

      expect(useThemeStore.getState().activeThemeId).toBe('nord')
    })
  })
})
