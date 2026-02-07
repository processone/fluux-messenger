import { create } from 'zustand'

export type ThemeMode = 'light' | 'dark' | 'system'
export type TimeFormat = '12h' | '24h' | 'auto'

interface SettingsState {
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  timeFormat: TimeFormat
  setTimeFormat: (format: TimeFormat) => void
}

const THEME_KEY = 'fluux-theme'
const TIME_FORMAT_KEY = 'fluux-time-format'

/**
 * Get initial theme mode from localStorage, default to 'dark'
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
  return 'dark'
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
}))
