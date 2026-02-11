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
  })
})
