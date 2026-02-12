import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { useWindowDrag } from '@/hooks'
import { useRouteSync } from '@/hooks/useRouteSync'
import {
  ProfileSettings,
  AppearanceSettings,
  LanguageSettings,
  NotificationsSettings,
  UpdatesSettings,
  BlockedUsersSettings,
  type SettingsCategory,
  SETTINGS_CATEGORIES,
  DEFAULT_SETTINGS_CATEGORY,
} from './settings-components'
import { isUpdaterEnabled } from '@/utils/tauri'
import { ArrowLeft } from 'lucide-react'

interface SettingsViewProps {
  onBack?: () => void
}

/**
 * Settings content view - renders the content for the selected settings category.
 * The settings category list is now in the main Sidebar component.
 */
export function SettingsView({ onBack }: SettingsViewProps) {
  detectRenderLoop('SettingsView')
  const { t } = useTranslation()
  const { titleBarClass, dragRegionProps } = useWindowDrag()
  const { settingsCategory } = useRouteSync()

  // Current category (default to profile if none specified)
  const activeCategory = (settingsCategory as SettingsCategory) || DEFAULT_SETTINGS_CATEGORY

  // Get the active category's config for icon and label
  const activeCategoryConfig = SETTINGS_CATEGORIES.find(cat => cat.id === activeCategory)
  const CategoryIcon = activeCategoryConfig?.icon
  const categoryLabel = activeCategoryConfig?.labelKey ? t(activeCategoryConfig.labelKey) : t('settings.title')

  // Render settings content based on active category
  const renderContent = () => {
    switch (activeCategory) {
      case 'profile':
        return <ProfileSettings />
      case 'appearance':
        return <AppearanceSettings />
      case 'language':
        return <LanguageSettings />
      case 'notifications':
        return <NotificationsSettings />
      case 'updates':
        // Updates only available on macOS/Windows, not Linux (users update via package manager)
        return isUpdaterEnabled() ? <UpdatesSettings /> : <ProfileSettings />
      case 'blocked':
        return <BlockedUsersSettings />
      default:
        return <ProfileSettings />
    }
  }

  return (
    <div className="h-full flex flex-col bg-fluux-chat">
      {/* Header */}
      <div className={`h-12 ${titleBarClass} px-4 flex items-center border-b border-fluux-bg shadow-sm`} {...dragRegionProps}>
        {/* Back button - mobile only */}
        {onBack && (
          <button
            onClick={onBack}
            className="p-1 -ml-1 mr-2 rounded hover:bg-fluux-hover md:hidden"
            aria-label={t('common.back')}
          >
            <ArrowLeft className="w-5 h-5 text-fluux-muted" />
          </button>
        )}
        {CategoryIcon && <CategoryIcon className="w-5 h-5 text-fluux-muted mr-2" />}
        <h2 className="font-semibold text-fluux-text">{categoryLabel}</h2>
      </div>

      {/* Content - centered like ProfileView */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-6 flex flex-col items-center">
          {renderContent()}
        </div>
      </div>
    </div>
  )
}
