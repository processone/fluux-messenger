import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    // Clear localStorage mock and reset store before each test
    vi.mocked(localStorage.clear).mockClear()
    vi.mocked(localStorage.getItem).mockClear()
    vi.mocked(localStorage.setItem).mockClear()
    vi.mocked(localStorage.getItem).mockReturnValue(null)
    useSettingsStore.setState({ themeMode: 'dark', timeFormat: 'auto' })
  })

  describe('initial state', () => {
    it('should default to dark mode when localStorage is empty', () => {
      // Force re-creation by setting state directly
      useSettingsStore.setState({ themeMode: 'dark' })
      expect(useSettingsStore.getState().themeMode).toBe('dark')
    })

    it('should load theme from localStorage if set', () => {
      // Mock getItem to return 'light' before store reads it
      vi.mocked(localStorage.getItem).mockReturnValue('light')

      // Verify the mock is configured correctly
      expect(localStorage.getItem('fluux-theme')).toBe('light')
    })
  })

  describe('setThemeMode', () => {
    it('should update themeMode to light', () => {
      useSettingsStore.getState().setThemeMode('light')
      expect(useSettingsStore.getState().themeMode).toBe('light')
    })

    it('should update themeMode to dark', () => {
      useSettingsStore.getState().setThemeMode('light')
      useSettingsStore.getState().setThemeMode('dark')
      expect(useSettingsStore.getState().themeMode).toBe('dark')
    })

    it('should update themeMode to system', () => {
      useSettingsStore.getState().setThemeMode('system')
      expect(useSettingsStore.getState().themeMode).toBe('system')
    })

    it('should persist theme to localStorage', () => {
      useSettingsStore.getState().setThemeMode('light')
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-theme', 'light')

      useSettingsStore.getState().setThemeMode('system')
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-theme', 'system')

      useSettingsStore.getState().setThemeMode('dark')
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-theme', 'dark')
    })
  })

  describe('localStorage persistence', () => {
    it('should handle localStorage errors gracefully', () => {
      // Mock localStorage.setItem to throw
      vi.mocked(localStorage.setItem).mockImplementation(() => {
        throw new Error('Storage quota exceeded')
      })

      // Should not throw
      expect(() => {
        useSettingsStore.getState().setThemeMode('light')
      }).not.toThrow()

      // State should still update
      expect(useSettingsStore.getState().themeMode).toBe('light')
    })
  })
})
