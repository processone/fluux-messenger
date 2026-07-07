import type { LucideIcon } from 'lucide-react'
import { User, Palette, Globe, Bell, Download, Ban, HardDrive, Lock, ShieldCheck, Wrench, Accessibility, Bot } from 'lucide-react'
import { isTauri, isUpdaterEnabled } from '@/utils/tauri'

export type SettingsCategory =
  | 'profile'
  | 'appearance'
  | 'accessibility'
  | 'language'
  | 'notifications'
  | 'privacy'
  | 'updates'
  | 'blocked'
  | 'storage'
  | 'encryption'
  | 'mcp'
  | 'advanced'

export type SettingsGroup = 'account' | 'general' | 'privacy' | 'system'

export interface SettingsCategoryConfig {
  id: SettingsCategory
  labelKey: string
  icon: LucideIcon
  group: SettingsGroup
  /** Only show in Tauri desktop app */
  tauriOnly?: boolean
  /** Only show when in-app updater is enabled (macOS/Windows, not Linux) */
  updaterOnly?: boolean
}

export { isTauri }

export const SETTINGS_CATEGORIES: SettingsCategoryConfig[] = [
  { id: 'profile', labelKey: 'settings.categories.profile', icon: User, group: 'account' },

  { id: 'appearance', labelKey: 'settings.categories.appearance', icon: Palette, group: 'general' },
  { id: 'accessibility', labelKey: 'settings.categories.accessibility', icon: Accessibility, group: 'general' },
  { id: 'language', labelKey: 'settings.categories.language', icon: Globe, group: 'general' },
  { id: 'notifications', labelKey: 'settings.categories.notifications', icon: Bell, group: 'general' },

  { id: 'encryption', labelKey: 'settings.categories.encryption', icon: Lock, group: 'privacy' },
  { id: 'privacy', labelKey: 'settings.categories.privacy', icon: ShieldCheck, group: 'privacy' },
  { id: 'blocked', labelKey: 'settings.categories.blocked', icon: Ban, group: 'privacy' },

  { id: 'storage', labelKey: 'settings.categories.storage', icon: HardDrive, tauriOnly: true, group: 'system' },
  { id: 'updates', labelKey: 'settings.categories.updates', icon: Download, updaterOnly: true, group: 'system' },
  { id: 'mcp', labelKey: 'settings.categories.mcp', icon: Bot, tauriOnly: true, group: 'system' },
  { id: 'advanced', labelKey: 'settings.categories.advanced', icon: Wrench, group: 'system' },
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

export interface SettingsGroupSection {
  group: SettingsGroup
  /** i18n key for the group header, or null for a group rendered with no header */
  labelKey: string | null
  items: SettingsCategoryConfig[]
}

const SETTINGS_GROUP_ORDER: SettingsGroup[] = ['account', 'general', 'privacy', 'system']

const SETTINGS_GROUP_LABEL_KEYS: Record<SettingsGroup, string | null> = {
  account: null,
  general: 'settings.groups.general',
  privacy: 'settings.groups.privacy',
  system: 'settings.groups.system',
}

/**
 * Group the platform-visible categories into ordered sections for the sidebar.
 * Groups with no visible items are omitted, so platform/updater filtering can
 * never leave an empty header behind.
 */
export function getGroupedVisibleCategories(): SettingsGroupSection[] {
  const visible = getVisibleCategories()
  return SETTINGS_GROUP_ORDER.map((group) => ({
    group,
    labelKey: SETTINGS_GROUP_LABEL_KEYS[group],
    items: visible.filter((cat) => cat.group === group),
  })).filter((section) => section.items.length > 0)
}
