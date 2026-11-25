import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { useWindowDrag } from '@/hooks'
import { useRouteSync } from '@/hooks/useRouteSync'
import {
  ProfileSettings,
  AppearanceSettings,
  AccessibilitySettings,
  LanguageSettings,
  NotificationsSettings,
  UpdatesSettings,
  BlockedUsersSettings,
  StorageSettings,
  EncryptionSettings,
  PrivacySettings,
  AdvancedSettings,
  McpSettings,
  SETTINGS_CATEGORIES,
  resolveSettingsCategory,
  resolveEncryptionSubPage,
  ENCRYPTION_SUB_PAGE_LABEL_KEYS,
} from './settings-components'
import { ArrowLeft } from 'lucide-react'

interface SettingsViewProps {
  onBack?: () => void
  /** Leaves an encryption method screen for the overview; defaults to a plain navigation. */
  onSubPageBack?: () => void
  /** Draws the category's root screen even when the route names a sub-page. */
  showOverview?: boolean
}

/**
 * Settings content view - renders the content for the selected settings category.
 * The settings category list is now in the main Sidebar component.
 */
export function SettingsView({ onBack, onSubPageBack, showOverview = false }: SettingsViewProps) {
  detectRenderLoop('SettingsView')
  const { t } = useTranslation()
  const { dragRegionProps } = useWindowDrag()
  const { settingsCategory, settingsSubPage, navigateToSettings } = useRouteSync()

  // Current category: default to profile if none specified, and fall back to
  // profile when the URL names a category this platform doesn't offer (e.g. a
  // deep link to the Tauri-only `mcp` or `storage` panels in the web build).
  const activeCategory = resolveSettingsCategory(settingsCategory)

  // Get the active category's config for icon and label
  const activeCategoryConfig = SETTINGS_CATEGORIES.find(cat => cat.id === activeCategory)
  const CategoryIcon = activeCategoryConfig?.icon
  const categoryLabel = activeCategoryConfig?.labelKey ? t(activeCategoryConfig.labelKey) : t('settings.title')

  // Encryption has a screen per method behind its overview; an unknown one shows the overview.
  const encryptionSubPage = activeCategory === 'encryption' && !showOverview ? resolveEncryptionSubPage(settingsSubPage) : null
  const headerLabel = encryptionSubPage ? t(ENCRYPTION_SUB_PAGE_LABEL_KEYS[encryptionSubPage]) : categoryLabel
  // The category summary describes the category's root screen, not one of its sub-pages.
  const categoryDescription = activeCategoryConfig && !encryptionSubPage ? t(activeCategoryConfig.descriptionKey) : null

  // Render settings content based on active category
  const renderContent = () => {
    switch (activeCategory) {
      case 'profile':
        return <ProfileSettings />
      case 'appearance':
        return <AppearanceSettings />
      case 'accessibility':
        return <AccessibilitySettings />
      case 'language':
        return <LanguageSettings />
      case 'notifications':
        return <NotificationsSettings />
      case 'privacy':
        return <PrivacySettings />
      case 'updates':
        // Platform availability is handled by resolveSettingsCategory above
        // (updaterOnly config), so this case only renders where it applies.
        return <UpdatesSettings />
      case 'blocked':
        return <BlockedUsersSettings />
      case 'storage':
        return <StorageSettings />
      case 'encryption':
        return <EncryptionSettings subPage={encryptionSubPage} />
      case 'mcp':
        return <McpSettings />
      case 'advanced':
        return <AdvancedSettings />
      default:
        return <ProfileSettings />
    }
  }

  return (
    <div className="h-full flex flex-col bg-fluux-chat">
      {/* Header */}
      <div className="min-h-14 shrink-0 px-4 md:h-14 flex items-center border-b border-fluux-bg shadow-sm" {...dragRegionProps}>
        {/* Back to the Encryption overview, at every width */}
        {encryptionSubPage && (
          <button
            type="button"
            onClick={onSubPageBack ?? (() => navigateToSettings('encryption', { replace: true }))}
            className="shrink-0 p-1 -ms-1 me-2 rounded hover:bg-fluux-hover tap-target"
            aria-label={t('common.back')}
          >
            <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
          </button>
        )}
        {/* Back button - mobile only */}
        {onBack && !encryptionSubPage && (
          <button
            type="button"
            onClick={onBack}
            className="shrink-0 p-1 -ms-1 me-2 rounded hover:bg-fluux-hover md:hidden tap-target"
            aria-label={t('common.back')}
          >
            <ArrowLeft className="size-5 text-fluux-muted rtl-mirror" />
          </button>
        )}
        {CategoryIcon && <CategoryIcon className="size-5 shrink-0 text-fluux-muted me-2" />}
        <div className="min-w-0 py-2 md:py-0">
          <h2 className="type-view-title text-fluux-text truncate !leading-tight">{headerLabel}</h2>
          {categoryDescription && (
            <p className="text-xs text-fluux-muted break-words md:truncate">{categoryDescription}</p>
          )}
        </div>
      </div>

      {/* Content. Profile uses an edge-to-edge hero that handles its own padding
          and width; every other category fills one shared reading column. */}
      <div className="flex-1 overflow-y-auto">
        {activeCategory === 'profile' ? (
          <div className="py-6">{renderContent()}</div>
        ) : (
          <div className="px-4 py-6 md:px-8 md:py-8">
            <div className="w-full max-w-2xl mx-auto">{renderContent()}</div>
          </div>
        )}
      </div>
    </div>
  )
}
