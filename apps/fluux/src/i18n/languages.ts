/**
 * The locale registry, kept free of side effects so it can be imported by
 * tests and by the service-worker string table without booting i18next.
 *
 * A shipped locale has four registrations: `supportedLanguages` tells i18next
 * what to load, `languageNames` populates the Settings picker, a matching JSON
 * file supplies the app strings, and `utils/swMessages.ts` supplies notification
 * text without i18next. The i18n parity suite enforces agreement in both
 * directions, so adding a locale means updating all four.
 */

export const supportedLanguages = [
  'ar', 'be', 'bg', 'ca', 'cs', 'da', 'de', 'el', 'en', 'es', 'et', 'fi', 'fr',
  'ga', 'he', 'hr', 'hu', 'is', 'it', 'ko', 'lt', 'lv', 'mt', 'nb', 'nl',
  'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'uk', 'zh-CN',
] as const

export type SupportedLanguage = (typeof supportedLanguages)[number]

/** Display name for each supported locale, written in that locale. */
export const languageNames: { code: SupportedLanguage; name: string }[] = [
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
  { code: 'ko', name: '한국어' },
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
