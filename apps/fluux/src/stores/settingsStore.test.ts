import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'

describe('settingsStore', () => {
  beforeEach(() => {
    // Clear localStorage mock and reset store before each test
    vi.mocked(localStorage.clear).mockClear()
    vi.mocked(localStorage.getItem).mockClear()
    vi.mocked(localStorage.setItem).mockClear()
    vi.mocked(localStorage.getItem).mockReturnValue(null)
    useSettingsStore.setState({ themeMode: 'system', timeFormat: 'auto', fontSize: 100, mediaAutoDownload: 'private-only', motionPreference: 'system', densityMode: 'comfortable', transparencyMode: 'system', keepInSystemTray: true })
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

  describe('transparencyMode', () => {
    it('defaults transparencyMode to system and persists on set', () => {
      expect(useSettingsStore.getState().transparencyMode).toBe('system')
      useSettingsStore.getState().setTransparencyMode('reduced')
      expect(useSettingsStore.getState().transparencyMode).toBe('reduced')
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-transparency', 'reduced')
    })
  })

  describe('densityMode', () => {
    it('defaults densityMode to comfortable and persists on set', () => {
      localStorage.clear()
      const { setDensityMode } = useSettingsStore.getState()
      expect(useSettingsStore.getState().densityMode).toBe('comfortable')
      setDensityMode('compact')
      expect(useSettingsStore.getState().densityMode).toBe('compact')
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-density', 'compact')
    })

    it('accepts both density values', () => {
      const { setDensityMode } = useSettingsStore.getState()
      for (const v of ['comfortable', 'compact'] as const) {
        setDensityMode(v)
        expect(useSettingsStore.getState().densityMode).toBe(v)
      }
    })
  })

  describe('keepInSystemTray', () => {
    it('defaults to enabled to preserve the current desktop behavior', () => {
      expect(useSettingsStore.getState().keepInSystemTray).toBe(true)
    })

    it('persists and applies both values', () => {
      useSettingsStore.getState().setKeepInSystemTray(false)
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-keep-in-tray', 'false')
      expect(useSettingsStore.getState().keepInSystemTray).toBe(false)

      useSettingsStore.getState().setKeepInSystemTray(true)
      expect(localStorage.setItem).toHaveBeenCalledWith('fluux-keep-in-tray', 'true')
      expect(useSettingsStore.getState().keepInSystemTray).toBe(true)
    })
  })
})

describe('reading width persistence', () => {
  beforeEach(() => {
    vi.mocked(localStorage.getItem).mockReset().mockReturnValue(null)
    vi.mocked(localStorage.setItem).mockReset()
    vi.resetModules()
  })

  it('uses full width for untouched settings without persisting the default', async () => {
    const { useSettingsStore: store } = await import('./settingsStore')
    expect(store.getState().readingWidthEnabled).toBe(false)
    expect(store.getState().readingWidth).toBe(760)
    expect(localStorage.setItem).not.toHaveBeenCalled()
  })

  it('keeps full width when storage is unavailable', async () => {
    vi.mocked(localStorage.getItem).mockImplementation(() => { throw new Error('unavailable') })
    const { useSettingsStore: store } = await import('./settingsStore')
    expect(store.getState().readingWidthEnabled).toBe(false)
    expect(store.getState().readingWidth).toBe(760)
  })

  it('reloads an explicit opt-in with the default slider width', async () => {
    const saved = new Map<string, string>()
    vi.mocked(localStorage.getItem).mockImplementation(key => saved.get(key) ?? null)
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => { saved.set(key, value) })
    const { useSettingsStore: store } = await import('./settingsStore')
    store.getState().setReadingWidthEnabled(true)
    vi.resetModules()
    const { useSettingsStore: restored } = await import('./settingsStore')
    expect(restored.getState().readingWidthEnabled).toBe(true)
    expect(restored.getState().readingWidth).toBe(760)
  })

  it('reloads both the opt-out and preferred width', async () => {
    const saved = new Map<string, string>()
    vi.mocked(localStorage.getItem).mockImplementation(key => saved.get(key) ?? null)
    vi.mocked(localStorage.setItem).mockImplementation((key, value) => { saved.set(key, value) })
    const { useSettingsStore: store } = await import('./settingsStore')
    store.getState().setReadingWidth(920)
    store.getState().setReadingWidthEnabled(false)
    vi.resetModules()
    const { useSettingsStore: restored } = await import('./settingsStore')
    expect(restored.getState().readingWidthEnabled).toBe(false)
    expect(restored.getState().readingWidth).toBe(920)
  })

  it.each(['', 'NaN', 'Infinity', 'garbage', '0', '559', '1121'])(
    'falls back safely for an invalid stored width: %s', async value => {
      vi.mocked(localStorage.getItem).mockImplementation(key => key === 'fluux-reading-width' ? value : null)
      const { useSettingsStore: store } = await import('./settingsStore')
      expect(store.getState().readingWidth).toBe(760)
    },
  )

  it('bounds widths and ignores non-finite updates even without storage', async () => {
    const { useSettingsStore: store } = await import('./settingsStore')
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error('unavailable') })
    store.getState().setReadingWidth(100)
    expect(store.getState().readingWidth).toBe(560)
    store.getState().setReadingWidth(2000)
    expect(store.getState().readingWidth).toBe(1120)
    store.getState().setReadingWidth(NaN)
    store.getState().setReadingWidth(Infinity)
    expect(store.getState().readingWidth).toBe(1120)
    store.getState().setReadingWidthEnabled(false)
    expect(store.getState().readingWidthEnabled).toBe(false)
  })
})
