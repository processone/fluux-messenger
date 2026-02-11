import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import LanguageDetector from 'i18next-browser-languagedetector'

import bg from './locales/bg.json'
import cs from './locales/cs.json'
import da from './locales/da.json'
import de from './locales/de.json'
import el from './locales/el.json'
import en from './locales/en.json'
import es from './locales/es.json'
import et from './locales/et.json'
import fi from './locales/fi.json'
import fr from './locales/fr.json'
import ga from './locales/ga.json'
import hr from './locales/hr.json'
import hu from './locales/hu.json'
import is from './locales/is.json'
import it from './locales/it.json'
import lt from './locales/lt.json'
import lv from './locales/lv.json'
import mt from './locales/mt.json'
import nb from './locales/nb.json'
import nl from './locales/nl.json'
import pl from './locales/pl.json'
import pt from './locales/pt.json'
import ro from './locales/ro.json'
import sk from './locales/sk.json'
import sl from './locales/sl.json'
import sv from './locales/sv.json'

const resources = {
  bg: { translation: bg },
  cs: { translation: cs },
  da: { translation: da },
  de: { translation: de },
  el: { translation: el },
  en: { translation: en },
  es: { translation: es },
  et: { translation: et },
  fi: { translation: fi },
  fr: { translation: fr },
  ga: { translation: ga },
  hr: { translation: hr },
  hu: { translation: hu },
  is: { translation: is },
  it: { translation: it },
  lt: { translation: lt },
  lv: { translation: lv },
  mt: { translation: mt },
  nb: { translation: nb },
  nl: { translation: nl },
  pl: { translation: pl },
  pt: { translation: pt },
  ro: { translation: ro },
  sk: { translation: sk },
  sl: { translation: sl },
  sv: { translation: sv },
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
