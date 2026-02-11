import type { LucideIcon } from 'lucide-react'
import { User, Palette, Globe, Bell, Download, Ban } from 'lucide-react'
import { isTauri, isUpdaterEnabled } from '@/utils/tauri'

export type SettingsCategory = 'profile' | 'appearance' | 'language' | 'notifications' | 'updates' | 'blocked'

export interface SettingsCategoryConfig {
  id: SettingsCategory
  labelKey: string
  icon: LucideIcon
  /** Only show in Tauri desktop app */
  tauriOnly?: boolean
  /** Only show when in-app updater is enabled (macOS/Windows, not Linux) */
  updaterOnly?: boolean
}

export { isTauri }

export const SETTINGS_CATEGORIES: SettingsCategoryConfig[] = [
  { id: 'profile', labelKey: 'settings.categories.profile', icon: User },
  { id: 'appearance', labelKey: 'settings.categories.appearance', icon: Palette },
  { id: 'language', labelKey: 'settings.categories.language', icon: Globe },
  { id: 'notifications', labelKey: 'settings.categories.notifications', icon: Bell },
  { id: 'updates', labelKey: 'settings.categories.updates', icon: Download, updaterOnly: true },
  { id: 'blocked', labelKey: 'settings.categories.blocked', icon: Ban },
]

/**
 * Get visible categories based on platform (web vs Tauri, Linux vs others)
 */
export function getVisibleCategories(): SettingsCategoryConfig[] {
  const updaterEnabled = isUpdaterEnabled()
  return SETTINGS_CATEGORIES.filter(cat => {
    if (cat.tauriOnly && !isTauri()) return false
    if (cat.updaterOnly && !updaterEnabled) return false
    return true
  })
}

/**
 * Default settings category to show when none specified
 */
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = 'profile'
