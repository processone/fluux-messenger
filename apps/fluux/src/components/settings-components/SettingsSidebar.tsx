import { useTranslation } from 'react-i18next'
import { getGroupedVisibleCategories, type SettingsCategory } from './types'
import { useAdvancedModeStore } from '@/stores/advancedModeStore'

interface SettingsSidebarProps {
  activeCategory: SettingsCategory
  onCategoryChange: (category: SettingsCategory) => void
}

export function SettingsSidebar({ activeCategory, onCategoryChange }: SettingsSidebarProps) {
  const { t } = useTranslation()
  // Re-render the sidebar when advanced mode is toggled.
  useAdvancedModeStore((s) => s.advancedMode)
  const sections = getGroupedVisibleCategories()

  return (
    <nav className="py-2">
      {sections.map((section) => (
        <div key={section.group} className="mt-4 first:mt-0">
          {section.labelKey && (
            <h3
              id={`settings-group-${section.group}`}
              className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-fluux-muted"
            >
              {t(section.labelKey)}
            </h3>
          )}
          <ul
            className="space-y-1"
            aria-labelledby={section.labelKey ? `settings-group-${section.group}` : undefined}
          >
            {section.items.map((category) => {
              const Icon = category.icon
              const isActive = activeCategory === category.id

              return (
                <li key={category.id}>
                  <button
                    type="button"
                    onClick={() => onCategoryChange(category.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-start transition-colors
                      ${isActive
                        ? 'bg-fluux-brand/10 text-fluux-brand'
                        : 'text-fluux-text hover:bg-fluux-hover'
                      }`}
                  >
                    <Icon className={`size-5 ${isActive ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
                    <span className="text-sm font-medium">{t(category.labelKey)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
