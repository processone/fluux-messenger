import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'
export type TimeFormat = '12h' | '24h' | 'auto'
export type MediaAutoDownload = 'always' | 'private-only' | 'never'

/** Font size as percentage of default (100 = normal). Range: 75–150. */
export type FontSize = number

interface SettingsState {
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  timeFormat: TimeFormat
  setTimeFormat: (format: TimeFormat) => void
  fontSize: FontSize
  setFontSize: (size: FontSize) => void
  mediaAutoDownload: MediaAutoDownload
  setMediaAutoDownload: (value: MediaAutoDownload) => void
}

const THEME_KEY = 'fluux-theme'
const TIME_FORMAT_KEY = 'fluux-time-format'
const FONT_SIZE_KEY = 'fluux-font-size'
const MEDIA_AUTO_DOWNLOAD_KEY = 'fluux-media-autodownload'

/**
 * Get initial theme mode from localStorage, default to 'system'
 */
function getInitialMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_KEY)
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      return stored
    }
  } catch {
    // localStorage not available
  }
  return 'system'
}

/**
 * Get initial time format from localStorage, default to 'auto'
 */
function getInitialTimeFormat(): TimeFormat {
  try {
    const stored = localStorage.getItem(TIME_FORMAT_KEY)
    if (stored === '12h' || stored === '24h' || stored === 'auto') {
      return stored
    }
  } catch {
    // localStorage not available
  }
  return 'auto'
}

/**
 * Get initial media auto-download policy from localStorage, default to 'private-only'.
 */
function getInitialMediaAutoDownload(): MediaAutoDownload {
  try {
    const stored = localStorage.getItem(MEDIA_AUTO_DOWNLOAD_KEY)
    if (stored === 'always' || stored === 'private-only' || stored === 'never') {
      return stored
    }
  } catch {
    // localStorage not available
  }
  return 'private-only'
}

/**
 * Get initial font size from localStorage, default to 100 (normal)
 */
function getInitialFontSize(): FontSize {
  try {
    const stored = localStorage.getItem(FONT_SIZE_KEY)
    if (stored) {
      const parsed = Number(stored)
      if (parsed >= 75 && parsed <= 150) return parsed
    }
  } catch {
    // localStorage not available
  }
  return 100
}

export const useSettingsStore = create<SettingsState>((set) => ({
  themeMode: getInitialMode(),

  setThemeMode: (mode) => {
    // Persist to localStorage
    try {
      localStorage.setItem(THEME_KEY, mode)
    } catch {
      // localStorage not available
    }
    set({ themeMode: mode })
  },

  timeFormat: getInitialTimeFormat(),

  setTimeFormat: (format) => {
    // Persist to localStorage
    try {
      localStorage.setItem(TIME_FORMAT_KEY, format)
    } catch {
      // localStorage not available
    }
    set({ timeFormat: format })
  },

  fontSize: getInitialFontSize(),

  setFontSize: (size) => {
    const clamped = Math.max(75, Math.min(150, size))
    try {
      localStorage.setItem(FONT_SIZE_KEY, String(clamped))
    } catch {
      // localStorage not available
    }
    set({ fontSize: clamped })
  },

  mediaAutoDownload: getInitialMediaAutoDownload(),

  setMediaAutoDownload: (value) => {
    try {
      localStorage.setItem(MEDIA_AUTO_DOWNLOAD_KEY, value)
    } catch {
      // localStorage not available
    }
    set({ mediaAutoDownload: value })
  },
}))
