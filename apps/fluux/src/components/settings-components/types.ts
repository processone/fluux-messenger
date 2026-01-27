import type { LucideIcon } from 'lucide-react'
import { User, Palette, Globe, Bell, Download, Ban } from 'lucide-react'
import { isTauri } from '@/utils/tauri'

export type SettingsCategory = 'profile' | 'appearance' | 'language' | 'notifications' | 'updates' | 'blocked'

export interface SettingsCategoryConfig {
  id: SettingsCategory
  labelKey: string
  icon: LucideIcon
  tauriOnly?: boolean
}

export { isTauri }

export const SETTINGS_CATEGORIES: SettingsCategoryConfig[] = [
  { id: 'profile', labelKey: 'settings.categories.profile', icon: User },
  { id: 'appearance', labelKey: 'settings.categories.appearance', icon: Palette },
  { id: 'language', labelKey: 'settings.categories.language', icon: Globe },
  { id: 'notifications', labelKey: 'settings.categories.notifications', icon: Bell },
  { id: 'updates', labelKey: 'settings.categories.updates', icon: Download, tauriOnly: true },
  { id: 'blocked', labelKey: 'settings.categories.blocked', icon: Ban },
]

/**
 * Get visible categories based on platform (web vs Tauri)
 */
export function getVisibleCategories(): SettingsCategoryConfig[] {
  return SETTINGS_CATEGORIES.filter(cat => !cat.tauriOnly || isTauri)
}

/**
 * Default settings category to show when none specified
 */
export const DEFAULT_SETTINGS_CATEGORY: SettingsCategory = 'profile'
