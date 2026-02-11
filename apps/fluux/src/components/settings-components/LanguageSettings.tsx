import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Clock, ChevronDown } from 'lucide-react'
import { useMode } from '@/hooks'
import { useSettingsStore, type TimeFormat } from '@/stores/settingsStore'

const languages = [
  { code: 'de', name: 'Deutsch' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'fr', name: 'Français' },
  { code: 'it', name: 'Italiano' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'pt', name: 'Português' },
]

const timeFormatOptions: { value: TimeFormat; labelKey: string }[] = [
  { value: 'auto', labelKey: 'settings.timeFormatAuto' },
  { value: '12h', labelKey: 'settings.timeFormat12h' },
  { value: '24h', labelKey: 'settings.timeFormat24h' },
]

export function LanguageSettings() {
  const { t, i18n } = useTranslation()
  const [languageChanged, setLanguageChanged] = useState(false)
  const { isDark } = useMode()
  const timeFormat = useSettingsStore((s) => s.timeFormat)
  const setTimeFormat = useSettingsStore((s) => s.setTimeFormat)

  const handleLanguageChange = (langCode: string) => {
    i18n.changeLanguage(langCode)
    localStorage.setItem('i18nextLng', langCode)
    setLanguageChanged(true)
  }

  const selectClassName = `w-full appearance-none px-4 py-3 pr-10 rounded-lg border-2 border-fluux-hover
                           bg-fluux-bg text-fluux-text cursor-pointer
                           hover:border-fluux-muted focus:border-fluux-brand focus:outline-none
                           transition-colors ${isDark ? '[color-scheme:dark]' : '[color-scheme:light]'}`

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.languageAndRegion')}
      </h3>

      <div className="space-y-6">
        {/* Language selection */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-fluux-muted" />
            <span className="text-sm font-medium text-fluux-text">{t('settings.language')}</span>
          </div>
          <div className="relative">
            <select
              value={languages.find(l => i18n.language === l.code || i18n.language.startsWith(l.code))?.code || 'en'}
              onChange={(e) => handleLanguageChange(e.target.value)}
              className={selectClassName}
            >
              {languages.map((lang) => (
                <option
                  key={lang.code}
                  value={lang.code}
                  className="bg-fluux-bg text-fluux-text"
                >
                  {lang.name}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fluux-muted pointer-events-none" />
          </div>
          {languageChanged && (
            <p className="text-xs text-fluux-muted italic">
              {t('settings.languageStreamNote')}
            </p>
          )}
        </div>

        {/* Time format selection */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-fluux-muted" />
            <span className="text-sm font-medium text-fluux-text">{t('settings.timeFormat')}</span>
          </div>
          <div className="relative">
            <select
              value={timeFormat}
              onChange={(e) => setTimeFormat(e.target.value as TimeFormat)}
              className={selectClassName}
            >
              {timeFormatOptions.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  className="bg-fluux-bg text-fluux-text"
                >
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fluux-muted pointer-events-none" />
          </div>
          <p className="text-xs text-fluux-muted">
            {t('settings.timeFormatDescription')}
          </p>
        </div>
      </div>
    </section>
  )
}
