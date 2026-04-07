import { useTranslation } from 'react-i18next'
import { getVisibleCategories, type SettingsCategory } from './types'

interface SettingsSidebarProps {
  activeCategory: SettingsCategory
  onCategoryChange: (category: SettingsCategory) => void
}

export function SettingsSidebar({ activeCategory, onCategoryChange }: SettingsSidebarProps) {
  const { t } = useTranslation()
  const categories = getVisibleCategories()

  return (
    <nav className="py-2">
      <ul className="space-y-1">
        {categories.map((category) => {
          const Icon = category.icon
          const isActive = activeCategory === category.id

          return (
            <li key={category.id}>
              <button
                onClick={() => onCategoryChange(category.id)}
                className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-start transition-colors
                  ${isActive
                    ? 'bg-fluux-brand/10 text-fluux-brand'
                    : 'text-fluux-text hover:bg-fluux-hover'
                  }`}
              >
                <Icon className={`w-5 h-5 ${isActive ? 'text-fluux-brand' : 'text-fluux-muted'}`} />
                <span className="text-sm font-medium">{t(category.labelKey)}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
