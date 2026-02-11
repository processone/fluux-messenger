import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import cs from './locales/cs.json'
import de from './locales/de.json'
import el from './locales/el.json'
import en from './locales/en.json'
import es from './locales/es.json'
import fr from './locales/fr.json'
import it from './locales/it.json'
import nl from './locales/nl.json'
import pl from './locales/pl.json'
import pt from './locales/pt.json'
import ro from './locales/ro.json'

const resources = {
  cs: { translation: cs },
  de: { translation: de },
  el: { translation: el },
  en: { translation: en },
  es: { translation: es },
  fr: { translation: fr },
  it: { translation: it },
  nl: { translation: nl },
  pl: { translation: pl },
  pt: { translation: pt },
  ro: { translation: ro },
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
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

export default i18n
