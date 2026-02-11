import { describe, it, expect, beforeEach } from 'vitest'
import i18n from './index'

// Auto-discover all locale files via Vite eager glob
const localeModules = import.meta.glob('./locales/*.json', { eager: true }) as Record<
  string,
  { default: Record<string, unknown> }
>

// Build a map of language code → translation object
const locales: Record<string, Record<string, unknown>> = {}
for (const [path, mod] of Object.entries(localeModules)) {
  const code = path.replace('./locales/', '').replace('.json', '')
  locales[code] = mod.default
}

const languageCodes = Object.keys(locales).sort()

/**
 * Recursively get all keys from a nested object as dot-notation paths
 */
function getAllKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = []

  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...getAllKeys(value as Record<string, unknown>, path))
    } else {
      keys.push(path)
    }
  }

  return keys.sort()
}

/**
 * Resolve a dot-notation key to its value in a nested object
 */
function resolveKey(obj: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce((o, k) => (o as Record<string, unknown>)?.[k], obj as unknown)
}

describe('i18n', () => {
  const enKeys = getAllKeys(locales['en'])
  const keysByLang = Object.fromEntries(
    languageCodes.map(code => [code, getAllKeys(locales[code])])
  )

  describe('translation key parity', () => {
    const nonEnglish = languageCodes.filter(code => code !== 'en')

    it.each(nonEnglish)('%s should have the same number of keys as English', (code) => {
      expect(keysByLang[code].length).toBe(enKeys.length)
    })

    it.each(nonEnglish)('%s should have all English keys', (code) => {
      const missing = enKeys.filter(key => !keysByLang[code].includes(key))
      expect(missing).toEqual([])
    })

    it.each(nonEnglish)('%s should not have extra keys beyond English', (code) => {
      const extra = keysByLang[code].filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it.each(languageCodes)('%s should not have empty translation values', (code) => {
      const keys = keysByLang[code]
      const emptyKeys = keys.filter(key => {
        const value = resolveKey(locales[code], key)
        return value === '' || value === null || value === undefined
      })
      expect(emptyKeys).toEqual([])
    })
  })

  describe('interpolation', () => {
    beforeEach(async () => {
      await i18n.changeLanguage('en')
    })

    it('should interpolate reconnecting status with seconds and attempt', () => {
      const result = i18n.t('status.reconnectingIn', { seconds: 5, attempt: 2 })
      expect(result).toBe('Reconnecting in 5s (attempt 2)')
    })

    it('should interpolate version in about dialog', () => {
      const result = i18n.t('about.version', { version: '1.2.3' })
      expect(result).toBe('Version 1.2.3')
    })

    it('should interpolate nickname in room tooltip', () => {
      const result = i18n.t('rooms.asNickname', { nickname: 'TestUser' })
      expect(result).toBe('as TestUser')
    })
  })

  describe('language switching', () => {
    it.each(languageCodes)('should switch to %s and resolve login.connect', async (code) => {
      await i18n.changeLanguage(code)
      expect(i18n.language).toBe(code)
      // Verify the key resolves to the locale value, not the raw key
      const value = i18n.t('login.connect')
      expect(value).toBe(resolveKey(locales[code], 'login.connect'))
    })

    it('should fall back to English for unknown language', async () => {
      await i18n.changeLanguage('ja')
      expect(i18n.t('login.connect')).toBe('Connect')
    })
  })

  describe('translation content', () => {
    beforeEach(async () => {
      await i18n.changeLanguage('en')
    })

    it('should have correct English translations for key UI elements', () => {
      expect(i18n.t('sidebar.messages')).toBe('Messages')
      expect(i18n.t('sidebar.rooms')).toBe('Rooms')
      expect(i18n.t('presence.online')).toBe('Online')
      expect(i18n.t('common.save')).toBe('Save')
      expect(i18n.t('common.cancel')).toBe('Cancel')
    })

    it('should have correct French translations for key UI elements', async () => {
      await i18n.changeLanguage('fr')
      expect(i18n.t('sidebar.messages')).toBe('Messages')
      expect(i18n.t('sidebar.rooms')).toBe('Salons')
      expect(i18n.t('presence.online')).toBe('En ligne')
      expect(i18n.t('common.save')).toBe('Enregistrer')
      expect(i18n.t('common.cancel')).toBe('Annuler')
    })

    it('should have correct German translations for key UI elements', async () => {
      await i18n.changeLanguage('de')
      expect(i18n.t('sidebar.messages')).toBe('Nachrichten')
      expect(i18n.t('sidebar.rooms')).toBe('Räume')
      expect(i18n.t('presence.online')).toBe('Online')
      expect(i18n.t('common.save')).toBe('Speichern')
      expect(i18n.t('common.cancel')).toBe('Abbrechen')
    })

    it('should have correct Italian translations for key UI elements', async () => {
      await i18n.changeLanguage('it')
      expect(i18n.t('sidebar.messages')).toBe('Messaggi')
      expect(i18n.t('sidebar.rooms')).toBe('Stanze')
      expect(i18n.t('presence.online')).toBe('Online')
      expect(i18n.t('common.save')).toBe('Salva')
      expect(i18n.t('common.cancel')).toBe('Annulla')
    })

    it('should have correct Polish translations for key UI elements', async () => {
      await i18n.changeLanguage('pl')
      expect(i18n.t('sidebar.messages')).toBe('Wiadomości')
      expect(i18n.t('sidebar.rooms')).toBe('Pokoje')
      expect(i18n.t('presence.online')).toBe('Dostępny')
      expect(i18n.t('common.save')).toBe('Zapisz')
      expect(i18n.t('common.cancel')).toBe('Anuluj')
    })

    it('should have correct Dutch translations for key UI elements', async () => {
      await i18n.changeLanguage('nl')
      expect(i18n.t('sidebar.messages')).toBe('Berichten')
      expect(i18n.t('sidebar.rooms')).toBe('Groepen')
      expect(i18n.t('presence.online')).toBe('Online')
      expect(i18n.t('common.save')).toBe('Opslaan')
      expect(i18n.t('common.cancel')).toBe('Annuleren')
    })

    it('should have correct Portuguese translations for key UI elements', async () => {
      await i18n.changeLanguage('pt')
      expect(i18n.t('sidebar.settings')).toBe('Definições')
      expect(i18n.t('presence.online')).toBe('Online')
      expect(i18n.t('common.save')).toBe('Guardar')
      expect(i18n.t('common.cancel')).toBe('Cancelar')
    })

    it('should have correct Swedish translations for key UI elements', async () => {
      await i18n.changeLanguage('sv')
      expect(i18n.t('sidebar.messages')).toBe('Meddelanden')
      expect(i18n.t('sidebar.rooms')).toBe('Rum')
      expect(i18n.t('presence.online')).toBe('Online')
      expect(i18n.t('common.save')).toBe('Spara')
      expect(i18n.t('common.cancel')).toBe('Avbryt')
    })

    it('should have correct Norwegian translations for key UI elements', async () => {
      await i18n.changeLanguage('nb')
      expect(i18n.t('sidebar.messages')).toBe('Meldinger')
      expect(i18n.t('sidebar.rooms')).toBe('Rom')
      expect(i18n.t('presence.online')).toBe('Pålogget')
      expect(i18n.t('common.save')).toBe('Lagre')
      expect(i18n.t('common.cancel')).toBe('Avbryt')
    })

    it('should have correct Danish translations for key UI elements', async () => {
      await i18n.changeLanguage('da')
      expect(i18n.t('sidebar.messages')).toBe('Beskeder')
      expect(i18n.t('sidebar.rooms')).toBe('Rum')
      expect(i18n.t('presence.online')).toBe('Online')
      expect(i18n.t('common.save')).toBe('Gem')
      expect(i18n.t('common.cancel')).toBe('Annuller')
    })

    it('should have correct Finnish translations for key UI elements', async () => {
      await i18n.changeLanguage('fi')
      expect(i18n.t('sidebar.messages')).toBe('Viestit')
      expect(i18n.t('sidebar.rooms')).toBe('Huoneet')
      expect(i18n.t('presence.online')).toBe('Paikalla')
      expect(i18n.t('common.save')).toBe('Tallenna')
      expect(i18n.t('common.cancel')).toBe('Peruuta')
    })

    it('should have correct Bulgarian translations for key UI elements', async () => {
      await i18n.changeLanguage('bg')
      expect(i18n.t('sidebar.messages')).toBe('Съобщения')
      expect(i18n.t('sidebar.rooms')).toBe('Стаи')
      expect(i18n.t('presence.online')).toBe('На линия')
      expect(i18n.t('common.save')).toBe('Запази')
      expect(i18n.t('common.cancel')).toBe('Отказ')
    })

    it('should have correct Croatian translations for key UI elements', async () => {
      await i18n.changeLanguage('hr')
      expect(i18n.t('sidebar.messages')).toBe('Poruke')
      expect(i18n.t('sidebar.rooms')).toBe('Sobe')
      expect(i18n.t('presence.online')).toBe('Na mreži')
      expect(i18n.t('common.save')).toBe('Spremi')
      expect(i18n.t('common.cancel')).toBe('Odustani')
    })

    it('should have correct Slovak translations for key UI elements', async () => {
      await i18n.changeLanguage('sk')
      expect(i18n.t('sidebar.messages')).toBe('Správy')
      expect(i18n.t('sidebar.rooms')).toBe('Miestnosti')
      expect(i18n.t('presence.online')).toBe('Online')
      expect(i18n.t('common.save')).toBe('Uložiť')
      expect(i18n.t('common.cancel')).toBe('Zrušiť')
    })

    it('should have correct Slovenian translations for key UI elements', async () => {
      await i18n.changeLanguage('sl')
      expect(i18n.t('sidebar.messages')).toBe('Sporočila')
      expect(i18n.t('sidebar.rooms')).toBe('Sobe')
      expect(i18n.t('presence.online')).toBe('Na spletu')
      expect(i18n.t('common.save')).toBe('Shrani')
      expect(i18n.t('common.cancel')).toBe('Prekliči')
    })

    it('should have correct Lithuanian translations for key UI elements', async () => {
      await i18n.changeLanguage('lt')
      expect(i18n.t('sidebar.messages')).toBe('Žinutės')
      expect(i18n.t('sidebar.rooms')).toBe('Kambariai')
      expect(i18n.t('presence.online')).toBe('Prisijungęs')
      expect(i18n.t('common.save')).toBe('Išsaugoti')
      expect(i18n.t('common.cancel')).toBe('Atšaukti')
    })

    it('should have correct Latvian translations for key UI elements', async () => {
      await i18n.changeLanguage('lv')
      expect(i18n.t('sidebar.messages')).toBe('Ziņojumi')
      expect(i18n.t('sidebar.rooms')).toBe('Istabas')
      expect(i18n.t('presence.online')).toBe('Tiešsaistē')
      expect(i18n.t('common.save')).toBe('Saglabāt')
      expect(i18n.t('common.cancel')).toBe('Atcelt')
    })

    it('should have correct Estonian translations for key UI elements', async () => {
      await i18n.changeLanguage('et')
      expect(i18n.t('sidebar.messages')).toBe('Sõnumid')
      expect(i18n.t('sidebar.rooms')).toBe('Toad')
      expect(i18n.t('presence.online')).toBe('Võrgus')
      expect(i18n.t('common.save')).toBe('Salvesta')
      expect(i18n.t('common.cancel')).toBe('Tühista')
    })

    it('should have correct Irish translations for key UI elements', async () => {
      await i18n.changeLanguage('ga')
      expect(i18n.t('sidebar.messages')).toBe('Teachtaireachtaí')
      expect(i18n.t('sidebar.rooms')).toBe('Seomraí')
      expect(i18n.t('presence.online')).toBe('Ar líne')
      expect(i18n.t('common.save')).toBe('Sábháil')
      expect(i18n.t('common.cancel')).toBe('Cealaigh')
    })

    it('should have correct Maltese translations for key UI elements', async () => {
      await i18n.changeLanguage('mt')
      expect(i18n.t('sidebar.messages')).toBe('Messaġġi')
      expect(i18n.t('sidebar.rooms')).toBe('Kmamar')
      expect(i18n.t('presence.online')).toBe('Online')
      expect(i18n.t('common.save')).toBe('Issejvja')
      expect(i18n.t('common.cancel')).toBe('Ikkanċella')
    })

    it('should have correct Icelandic translations for key UI elements', async () => {
      await i18n.changeLanguage('is')
      expect(i18n.t('sidebar.messages')).toBe('Skilaboð')
      expect(i18n.t('sidebar.rooms')).toBe('Herbergi')
      expect(i18n.t('presence.online')).toBe('Á netinu')
      expect(i18n.t('common.save')).toBe('Vista')
      expect(i18n.t('common.cancel')).toBe('Hætta við')
    })
  })
})
