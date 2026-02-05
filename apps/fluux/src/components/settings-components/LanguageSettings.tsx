import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Globe, ChevronDown } from 'lucide-react'
import { useMode } from '@/hooks'

const languages = [
  { code: 'de', name: 'Deutsch', flag: '🇩🇪' },
  { code: 'en', name: 'English', flag: '🇬🇧' },
  { code: 'es', name: 'Español', flag: '🇪🇸' },
  { code: 'fr', name: 'Français', flag: '🇫🇷' },
  { code: 'it', name: 'Italiano', flag: '🇮🇹' },
  { code: 'nl', name: 'Nederlands', flag: '🇳🇱' },
  { code: 'pl', name: 'Polski', flag: '🇵🇱' },
  { code: 'pt', name: 'Português', flag: '🇵🇹' },
  { code: 'ru', name: 'Русский', flag: '🇷🇺' },
  { code: 'be', name: 'Беларускі', flag: '🇧🇾' },
  { code: 'uk', name: 'Українська', flag: '🇺🇦' },
]

export function LanguageSettings() {
  const { t, i18n } = useTranslation()
  const [languageChanged, setLanguageChanged] = useState(false)
  const { isDark } = useMode()

  const handleLanguageChange = (langCode: string) => {
    i18n.changeLanguage(langCode)
    localStorage.setItem('i18nextLng', langCode)
    setLanguageChanged(true)
  }

  return (
    <section className="max-w-md">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.language')}
      </h3>

      <div className="space-y-3">
        <div className="flex items-center gap-2 mb-3">
          <Globe className="w-4 h-4 text-fluux-muted" />
          <span className="text-sm text-fluux-muted">{t('settings.languageDescription')}</span>
        </div>
        <div className="relative">
          <select
            value={languages.find(l => i18n.language === l.code || i18n.language.startsWith(l.code))?.code || 'en'}
            onChange={(e) => handleLanguageChange(e.target.value)}
            className={`w-full appearance-none px-4 py-3 pr-10 rounded-lg border-2 border-fluux-hover
                       bg-fluux-bg text-fluux-text cursor-pointer
                       hover:border-fluux-muted focus:border-fluux-brand focus:outline-none
                       transition-colors ${isDark ? '[color-scheme:dark]' : '[color-scheme:light]'}`}
          >
            {languages.map((lang) => (
              <option
                key={lang.code}
                value={lang.code}
                className="bg-fluux-bg text-fluux-text"
              >
                {lang.flag} {lang.name}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-3 top-1/2 -translate-y-1/2 w-5 h-5 text-fluux-muted pointer-events-none" />
        </div>
        {languageChanged && (
          <p className="text-xs text-fluux-muted mt-2 italic">
            {t('settings.languageStreamNote')}
          </p>
        )}
      </div>
    </section>
  )
}
