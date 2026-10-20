import { create } from 'zustand'
import { persistPushSoundEnabled, SOUND_KEY, SOUND_CHANGED_AT_KEY } from '../utils/pushSoundPreference'
import type { ArchivingDefault } from '@fluux/sdk'

export type ThemeMode = 'light' | 'dark' | 'system'
export type TimeFormat = '12h' | '24h' | 'auto'
export type MediaAutoDownload = 'always' | 'private-only' | 'never'
/** Motion preference: follow the OS, force full animations, or reduce them. */
export type MotionPreference = 'system' | 'full' | 'reduced'
/** Transparency preference: follow the OS, force glass frost, or reduce to solid surfaces. */
export type TransparencyMode = 'system' | 'full' | 'reduced'
/** Display density: normal spacing or compact spacing. */
export type DensityMode = 'comfortable' | 'compact'

/** Font size as percentage of default (100 = normal). Range: 75–150. */
export type FontSize = number

export const READING_WIDTH_DEFAULT = 760
export const READING_WIDTH_MIN = 560
export const READING_WIDTH_MAX = 1120
export const READING_WIDTH_STEP = 40

interface SettingsState {
  themeMode: ThemeMode
  setThemeMode: (mode: ThemeMode) => void
  timeFormat: TimeFormat
  setTimeFormat: (format: TimeFormat) => void
  fontSize: FontSize
  setFontSize: (size: FontSize) => void
  mediaAutoDownload: MediaAutoDownload
  setMediaAutoDownload: (value: MediaAutoDownload) => void
  motionPreference: MotionPreference
  setMotionPreference: (value: MotionPreference) => void
  transparencyMode: TransparencyMode
  setTransparencyMode: (value: TransparencyMode) => void
  densityMode: DensityMode
  setDensityMode: (mode: DensityMode) => void
  readingWidthEnabled: boolean
  setReadingWidthEnabled: (enabled: boolean) => void
  /** Maximum conversation column width in CSS pixels. */
  readingWidth: number
  setReadingWidth: (width: number) => void
  soundEnabled: boolean
  setSoundEnabled: (enabled: boolean) => void
  keepInSystemTray: boolean
  setKeepInSystemTray: (enabled: boolean) => void
  /**
   * Per-account archiving choices that differ from the server's own default
   * (XEP-0313). `original` is the server default found before the first override,
   * so clearing the override can put it back. An account without an entry follows its server.
   */
  archiveOverrides: Record<string, ArchiveOverride>
  setArchiveOverride: (account: string, override: ArchiveOverride) => void
  clearArchiveOverride: (account: string) => void
}

export interface ArchiveOverride {
  value: ArchivingDefault
  original: ArchivingDefault
}

const THEME_KEY = 'fluux-theme'
const TIME_FORMAT_KEY = 'fluux-time-format'
const FONT_SIZE_KEY = 'fluux-font-size'
const MEDIA_AUTO_DOWNLOAD_KEY = 'fluux-media-autodownload'
const MOTION_KEY = 'fluux-motion'
const TRANSPARENCY_KEY = 'fluux-transparency'
const DENSITY_KEY = 'fluux-density'
const READING_WIDTH_KEY = 'fluux-reading-width'
const READING_WIDTH_ENABLED_KEY = 'fluux-reading-width-enabled'
const KEEP_IN_TRAY_KEY = 'fluux-keep-in-tray'
const ARCHIVE_OVERRIDES_KEY = 'fluux-archive-overrides'

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

/**
 * Get initial motion preference from localStorage, default to 'system'
 * (follow the OS prefers-reduced-motion setting).
 */
function getInitialMotion(): MotionPreference {
  try {
    const stored = localStorage.getItem(MOTION_KEY)
    if (stored === 'system' || stored === 'full' || stored === 'reduced') {
      return stored
    }
  } catch {
    // localStorage not available
  }
  return 'system'
}

/**
 * Get initial transparency preference from localStorage, default to 'system'
 * (follow the OS prefers-reduced-transparency setting).
 */
function getInitialTransparency(): TransparencyMode {
  try {
    const s = localStorage.getItem(TRANSPARENCY_KEY)
    if (s === 'system' || s === 'full' || s === 'reduced') return s
  } catch {
    // localStorage not available
  }
  return 'system'
}

/**
 * Get initial display density from localStorage, default to 'comfortable'.
 */
function getInitialDensity(): DensityMode {
  try {
    const stored = localStorage.getItem(DENSITY_KEY)
    if (stored === 'comfortable' || stored === 'compact') return stored
  } catch {
    // localStorage not available
  }
  return 'comfortable'
}

function getInitialReadingWidthEnabled(): boolean {
  try {
    return localStorage.getItem(READING_WIDTH_ENABLED_KEY) === 'true'
  } catch {
    return false
  }
}

function getInitialReadingWidth(): number {
  try {
    const stored = localStorage.getItem(READING_WIDTH_KEY)
    const width = Number(stored)
    if (stored && Number.isFinite(width) && width >= READING_WIDTH_MIN && width <= READING_WIDTH_MAX) return width
  } catch { /* localStorage not available */ }
  return READING_WIDTH_DEFAULT
}

/**
 * Get initial sound enabled preference from localStorage, default to true.
 */
function getInitialSoundEnabled(): boolean {
  let enabled = true
  let changedAt = 0
  try {
    enabled = localStorage.getItem(SOUND_KEY) !== 'false'
    changedAt = Number(localStorage.getItem(SOUND_CHANGED_AT_KEY)) || 0
  } catch {
    // localStorage not available
  }
  void persistPushSoundEnabled(enabled, changedAt)
  return enabled
}

/**
 * Keep the current close-to-tray behavior for existing desktop users until
 * they explicitly opt out.
 */
function getInitialKeepInSystemTray(): boolean {
  try {
    const stored = localStorage.getItem(KEEP_IN_TRAY_KEY)
    if (stored === 'false') return false
    if (stored === 'true') return true
  } catch {
    // localStorage not available
  }
  return true
}

const ARCHIVING_DEFAULTS: readonly string[] = ['always', 'roster', 'never']

/** Read the saved per-account archiving overrides, ignoring anything malformed. */
function getInitialArchiveOverrides(): Record<string, ArchiveOverride> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(ARCHIVE_OVERRIDES_KEY) ?? '{}')
    if (!parsed || typeof parsed !== 'object') return {}
    const overrides: Record<string, ArchiveOverride> = {}
    for (const [account, entry] of Object.entries(parsed)) {
      const { value, original } = (entry ?? {}) as Partial<ArchiveOverride>
      if (ARCHIVING_DEFAULTS.includes(value as string) && ARCHIVING_DEFAULTS.includes(original as string)) {
        overrides[account] = { value: value!, original: original! }
      }
    }
    return overrides
  } catch {
    return {}
  }
}

function saveArchiveOverrides(overrides: Record<string, ArchiveOverride>): void {
  try { localStorage.setItem(ARCHIVE_OVERRIDES_KEY, JSON.stringify(overrides)) } catch { /* localStorage not available */ }
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
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

  motionPreference: getInitialMotion(),

  setMotionPreference: (value) => {
    try {
      localStorage.setItem(MOTION_KEY, value)
    } catch {
      // localStorage not available
    }
    set({ motionPreference: value })
  },

  transparencyMode: getInitialTransparency(),

  setTransparencyMode: (value) => {
    try { localStorage.setItem(TRANSPARENCY_KEY, value) } catch { /* */ }
    set({ transparencyMode: value })
  },

  densityMode: getInitialDensity(),

  setDensityMode: (mode) => {
    try { localStorage.setItem(DENSITY_KEY, mode) } catch { /* localStorage not available */ }
    set({ densityMode: mode })
  },

  readingWidthEnabled: getInitialReadingWidthEnabled(),

  setReadingWidthEnabled: (enabled) => {
    try { localStorage.setItem(READING_WIDTH_ENABLED_KEY, String(enabled)) } catch { /* localStorage not available */ }
    set({ readingWidthEnabled: enabled })
  },

  readingWidth: getInitialReadingWidth(),

  setReadingWidth: (width) => {
    if (!Number.isFinite(width)) return
    const clamped = Math.max(READING_WIDTH_MIN, Math.min(READING_WIDTH_MAX, width))
    try { localStorage.setItem(READING_WIDTH_KEY, String(clamped)) } catch { /* localStorage not available */ }
    set({ readingWidth: clamped })
  },

  soundEnabled: getInitialSoundEnabled(),

  setSoundEnabled: (enabled) => {
    const changedAt = Date.now()
    try {
      localStorage.setItem(SOUND_KEY, String(enabled))
      localStorage.setItem(SOUND_CHANGED_AT_KEY, String(changedAt))
    } catch { /* localStorage not available */ }
    void persistPushSoundEnabled(enabled, changedAt)
    set({ soundEnabled: enabled })
  },

  keepInSystemTray: getInitialKeepInSystemTray(),

  setKeepInSystemTray: (enabled) => {
    try { localStorage.setItem(KEEP_IN_TRAY_KEY, String(enabled)) } catch { /* localStorage not available */ }
    set({ keepInSystemTray: enabled })
  },

  archiveOverrides: getInitialArchiveOverrides(),

  setArchiveOverride: (account, override) => {
    const archiveOverrides = { ...get().archiveOverrides, [account]: override }
    saveArchiveOverrides(archiveOverrides)
    set({ archiveOverrides })
  },

  clearArchiveOverride: (account) => {
    const { [account]: _removed, ...archiveOverrides } = get().archiveOverrides
    saveArchiveOverrides(archiveOverrides)
    set({ archiveOverrides })
  },
}))
