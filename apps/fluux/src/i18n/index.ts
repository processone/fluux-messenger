import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import resourcesToBackend from 'i18next-resources-to-backend'

export const supportedLanguages = [
  'ar', 'be', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr',
  'ga', 'he', 'hr', 'hu', 'is', 'it', 'lt', 'lv', 'mt', 'nb', 'nl',
  'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk', 'zh-CN',
] as const

const RTL_LANGUAGES = new Set(['ar', 'he'])

export function isRTL(lang: string): boolean {
  return RTL_LANGUAGES.has(lang)
}

function applyDirection(lang: string) {
  const dir = isRTL(lang) ? 'rtl' : 'ltr'
  document.documentElement.dir = dir
  document.documentElement.lang = lang
}

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .use(resourcesToBackend((language: string) =>
    import(`./locales/${language}.json`)
  ))
  .init({
    supportedLngs: supportedLanguages,
    fallbackLng: 'en',
    debug: false,
    interpolation: {
      escapeValue: false, // React already escapes values
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  })

// Set direction on initial load and language changes
i18n.on('languageChanged', applyDirection)
if (i18n.language) {
  applyDirection(i18n.language)
}

export default i18n
