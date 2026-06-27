import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, Clock } from 'lucide-react'
import { useSettingsStore, type TimeFormat } from '@/stores/settingsStore'
import { Select } from '@/components/ui/Select'
import { SettingsSection } from '@/components/ui/SettingsSection'

const languages = [
  { code: 'ar', name: 'العربية' },
  { code: 'be', name: 'Беларускі' },
  { code: 'bg', name: 'Български' },
  { code: 'ca', name: 'Català' },
  { code: 'cs', name: 'Čeština' },
  { code: 'da', name: 'Dansk' },
  { code: 'de', name: 'Deutsch' },
  { code: 'el', name: 'Ελληνικά' },
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Español' },
  { code: 'et', name: 'Eesti' },
  { code: 'fi', name: 'Suomi' },
  { code: 'fr', name: 'Français' },
  { code: 'ga', name: 'Gaeilge' },
  { code: 'he', name: 'עברית' },
  { code: 'hr', name: 'Hrvatski' },
  { code: 'hu', name: 'Magyar' },
  { code: 'is', name: 'Íslenska' },
  { code: 'it', name: 'Italiano' },
  { code: 'lt', name: 'Lietuvių' },
  { code: 'lv', name: 'Latviešu' },
  { code: 'mt', name: 'Malti' },
  { code: 'nb', name: 'Norsk bokmål' },
  { code: 'nl', name: 'Nederlands' },
  { code: 'pl', name: 'Polski' },
  { code: 'pt', name: 'Português' },
  { code: 'ro', name: 'Română' },
  { code: 'ru', name: 'Русский' },
  { code: 'sk', name: 'Slovenčina' },
  { code: 'sl', name: 'Slovenščina' },
  { code: 'sv', name: 'Svenska' },
  { code: 'uk', name: 'Українська' },
  { code: 'zh-CN', name: '简体中文' },
]

const timeFormatOptions: { value: TimeFormat; labelKey: string }[] = [
  { value: 'auto', labelKey: 'settings.timeFormatAuto' },
  { value: '12h', labelKey: 'settings.timeFormat12h' },
  { value: '24h', labelKey: 'settings.timeFormat24h' },
]

export function LanguageSettings() {
  const { t, i18n } = useTranslation()
  const [languageChanged, setLanguageChanged] = useState(false)
  const timeFormat = useSettingsStore((s) => s.timeFormat)
  const setTimeFormat = useSettingsStore((s) => s.setTimeFormat)

  const handleLanguageChange = (langCode: string) => {
    void i18n.changeLanguage(langCode)
    localStorage.setItem('i18nextLng', langCode)
    setLanguageChanged(true)
  }

  return (
    <section className="max-w-md">
      <SettingsSection title={t('settings.languageAndRegion')}>
        <div className="space-y-6">
          {/* Language selection */}
          <div className="space-y-3">
            <label htmlFor="language-select" className="flex items-center gap-2">
              <Globe className="size-4 text-fluux-muted" />
              <span className="text-sm font-medium text-fluux-text">{t('settings.language')}</span>
            </label>
            <Select
              id="language-select"
              name="language"
              value={languages.find(l => i18n.language === l.code || i18n.language.startsWith(l.code))?.code || 'en'}
              onChange={(e) => handleLanguageChange(e.target.value)}
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
            </Select>
            {languageChanged && (
              <p className="text-xs text-fluux-muted italic">
                {t('settings.languageStreamNote')}
              </p>
            )}
          </div>

          {/* Time format selection */}
          <div className="space-y-3">
            <label htmlFor="time-format-select" className="flex items-center gap-2">
              <Clock className="size-4 text-fluux-muted" />
              <span className="text-sm font-medium text-fluux-text">{t('settings.timeFormat')}</span>
            </label>
            <Select
              id="time-format-select"
              name="timeFormat"
              value={timeFormat}
              onChange={(e) => setTimeFormat(e.target.value as TimeFormat)}
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
            </Select>
            <p className="text-xs text-fluux-muted">
              {t('settings.timeFormatDescription')}
            </p>
          </div>
        </div>
      </SettingsSection>
    </section>
  )
}
