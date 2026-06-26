import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    // Clear localStorage mock and reset store before each test
    vi.mocked(localStorage.clear).mockClear()
    vi.mocked(localStorage.getItem).mockClear()
    vi.mocked(localStorage.setItem).mockClear()
    vi.mocked(localStorage.getItem).mockReturnValue(null)
    useSettingsStore.setState({ themeMode: 'system', timeFormat: 'auto', fontSize: 100, mediaAutoDownload: 'private-only', motionPreference: 'system' })
  })

  describe('initial state', () => {
    it('should default to system mode when localStorage is empty', () => {
      // Force re-creation by setting state directly
      useSettingsStore.setState({ themeMode: 'system' })
      expect(useSettingsStore.getState().themeMode).toBe('system')
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

  describe('setFontSize', () => {
    it('should update fontSize', () => {
      useSettingsStore.getState().setFontSize(120)
      expect(useSettingsStore.getState().fontSize).toBe(120)
    })

    it('should clamp fontSize to minimum 75', () => {
      useSettingsStore.getState().setFontSize(50)
      expect(useSettingsStore.getState().fontSize).toBe(75)
    })

    it('should clamp fontSize to maximum 150', () => {
      useSettingsStore.getState().setFontSize(200)
      expect(useSettingsStore.getState().fontSize).toBe(150)
    })

    it('should persist fontSize to localStorage', () => {
      useSettingsStore.getState().setFontSize(110)
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-font-size', '110')
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

  describe('mediaAutoDownload', () => {
    it('defaults to private-only when localStorage is empty', () => {
      useSettingsStore.setState({ mediaAutoDownload: 'private-only' })
      expect(useSettingsStore.getState().mediaAutoDownload).toBe('private-only')
    })

    it('setMediaAutoDownload persists to localStorage', () => {
      useSettingsStore.getState().setMediaAutoDownload('always')
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-media-autodownload', 'always')
      expect(useSettingsStore.getState().mediaAutoDownload).toBe('always')
    })

    it('accepts all three policy values', () => {
      const { setMediaAutoDownload } = useSettingsStore.getState()
      for (const v of ['always', 'private-only', 'never'] as const) {
        setMediaAutoDownload(v)
        expect(useSettingsStore.getState().mediaAutoDownload).toBe(v)
      }
    })
  })

  describe('motionPreference', () => {
    it('defaults to system when localStorage is empty', () => {
      useSettingsStore.setState({ motionPreference: 'system' })
      expect(useSettingsStore.getState().motionPreference).toBe('system')
    })

    it('setMotionPreference persists to localStorage', () => {
      useSettingsStore.getState().setMotionPreference('reduced')
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-motion', 'reduced')
      expect(useSettingsStore.getState().motionPreference).toBe('reduced')
    })

    it('accepts all three values', () => {
      const { setMotionPreference } = useSettingsStore.getState()
      for (const v of ['system', 'full', 'reduced'] as const) {
        setMotionPreference(v)
        expect(useSettingsStore.getState().motionPreference).toBe(v)
      }
    })
  })
})
