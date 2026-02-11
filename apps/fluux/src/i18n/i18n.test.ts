import { describe, it, expect, beforeEach } from 'vitest'
import i18n from './index'
import de from './locales/de.json'
import en from './locales/en.json'
import fr from './locales/fr.json'
import itLang from './locales/it.json'
import nl from './locales/nl.json'
import pl from './locales/pl.json'
import pt from './locales/pt.json'
import ru from './locales/ru.json'
import be from './locales/be.json'
import uk from './locales/uk.json'

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

describe('i18n', () => {
  describe('translation key parity', () => {
    const deKeys = getAllKeys(de)
    const enKeys = getAllKeys(en)
    const frKeys = getAllKeys(fr)
    const itKeys = getAllKeys(itLang)
    const nlKeys = getAllKeys(nl)
    const plKeys = getAllKeys(pl)
    const ptKeys = getAllKeys(pt)
    const ruKeys = getAllKeys(ru)
    const beKeys = getAllKeys(be)
    const ukKeys = getAllKeys(uk)

    it('should have the same number of keys in all languages', () => {
      expect(deKeys.length).toBe(enKeys.length)
      expect(frKeys.length).toBe(enKeys.length)
      expect(itKeys.length).toBe(enKeys.length)
      expect(nlKeys.length).toBe(enKeys.length)
      expect(plKeys.length).toBe(enKeys.length)
      expect(ptKeys.length).toBe(enKeys.length)
      expect(ruKeys.length).toBe(enKeys.length)
      expect(beKeys.length).toBe(enKeys.length)
      expect(ukKeys.length).toBe(enKeys.length)
    })

    it('should have all English keys in German', () => {
      const missing = enKeys.filter(key => !deKeys.includes(key))
      expect(missing).toEqual([])
    })

    it('should have all English keys in French', () => {
      const missing = enKeys.filter(key => !frKeys.includes(key))
      expect(missing).toEqual([])
    })

    it('should have all English keys in Italian', () => {
      const missing = enKeys.filter(key => !itKeys.includes(key))
      expect(missing).toEqual([])
    })

    it('should have all English keys in Dutch', () => {
      const missing = enKeys.filter(key => !nlKeys.includes(key))
      expect(missing).toEqual([])
    })

    it('should have all English keys in Polish', () => {
      const missing = enKeys.filter(key => !plKeys.includes(key))
      expect(missing).toEqual([])
    })

    it('should have all English keys in Portuguese', () => {
      const missing = enKeys.filter(key => !ptKeys.includes(key))
      expect(missing).toEqual([])
    })

    it('should have all English keys in Russian', () => {
      const missing = enKeys.filter(key => !ruKeys.includes(key))
      expect(missing).toEqual([])
    })

    it('should have all English keys in Belarusian', () => {
      const missing = enKeys.filter(key => !beKeys.includes(key))
      expect(missing).toEqual([])
    })

    it('should have all English keys in Ukrainian', () => {
      const missing = enKeys.filter(key => !ukKeys.includes(key))
      expect(missing).toEqual([])
    })

    it('should not have extra keys in German', () => {
      const extra = deKeys.filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it('should not have extra keys in French', () => {
      const extra = frKeys.filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it('should not have extra keys in Italian', () => {
      const extra = itKeys.filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it('should not have extra keys in Dutch', () => {
      const extra = nlKeys.filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it('should not have extra keys in Polish', () => {
      const extra = plKeys.filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it('should not have extra keys in Portuguese', () => {
      const extra = ptKeys.filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it('should not have extra keys in Russian', () => {
      const extra = ruKeys.filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it('should not have extra keys in Belarusian', () => {
      const extra = beKeys.filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it('should not have extra keys in Ukrainian', () => {
      const extra = ukKeys.filter(key => !enKeys.includes(key))
      expect(extra).toEqual([])
    })

    it('should not have empty translation values in English', () => {
      const emptyKeys = enKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], en as unknown)

        return value === '' || value === null || value === undefined
      })

      expect(emptyKeys).toEqual([])
    })

    it('should not have empty translation values in German', () => {
      const emptyKeys = deKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], de as unknown)

        return value === '' || value === null || value === undefined
      })

      expect(emptyKeys).toEqual([])
    })

    it('should not have empty translation values in French', () => {
      const emptyKeys = frKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], fr as unknown)

        return value === '' || value === null || value === undefined
      })

      expect(emptyKeys).toEqual([])
    })

    it('should not have empty translation values in Italian', () => {
      const emptyKeys = itKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], itLang as unknown)

        return value === '' || value === null || value === undefined
      })

      expect(emptyKeys).toEqual([])
    })

    it('should not have empty translation values in Dutch', () => {
      const emptyKeys = nlKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], nl as unknown)

        return value === '' || value === null || value === undefined
      })

      expect(emptyKeys).toEqual([])
    })

    it('should not have empty translation values in Polish', () => {
      const emptyKeys = plKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], pl as unknown)

        return value === '' || value === null || value === undefined
      })

      expect(emptyKeys).toEqual([])
    })

    it('should not have empty translation values in Portuguese', () => {
      const emptyKeys = ptKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], pt as unknown)

        return value === '' || value === null || value === undefined
      })

      expect(emptyKeys).toEqual([])
    })

    it('should not have empty translation values in Russian', () => {
      const emptyKeys = ruKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], ru as unknown)

        return value === '' || value === null || value === undefined
      })

      expect(emptyKeys).toEqual([])
    })

    it('should not have empty translation values in Belarusian', () => {
      const emptyKeys = beKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], be as unknown)

        return value === '' || value === null || value === undefined
      })

      expect(emptyKeys).toEqual([])
    })

    it('should not have empty translation values in Ukrainian', () => {
      const emptyKeys = ukKeys.filter(key => {
        const value = key
          .split('.')
          .reduce((obj, k) => (obj as Record<string, unknown>)?.[k], uk as unknown)

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
    it('should switch to German', async () => {
      await i18n.changeLanguage('de')
      expect(i18n.language).toBe('de')
      expect(i18n.t('login.connect')).toBe('Verbinden')
    })

    it('should switch to French', async () => {
      await i18n.changeLanguage('fr')
      expect(i18n.language).toBe('fr')
      expect(i18n.t('login.connect')).toBe('Se connecter')
    })

    it('should switch to Italian', async () => {
      await i18n.changeLanguage('it')
      expect(i18n.language).toBe('it')
      expect(i18n.t('login.connect')).toBe('Connetti')
    })

    it('should switch to Dutch', async () => {
      await i18n.changeLanguage('nl')
      expect(i18n.language).toBe('nl')
      expect(i18n.t('login.connect')).toBe('Verbinden')
    })

    it('should switch to Polish', async () => {
      await i18n.changeLanguage('pl')
      expect(i18n.language).toBe('pl')
      expect(i18n.t('login.connect')).toBe('Połącz')
    })

    it('should switch to Portuguese', async () => {
      await i18n.changeLanguage('pt')
      expect(i18n.language).toBe('pt')
      expect(i18n.t('login.connect')).toBe('Ligar')
    })

    it('should switch to English', async () => {
      await i18n.changeLanguage('en')
      expect(i18n.language).toBe('en')
      expect(i18n.t('login.connect')).toBe('Connect')
    })

    it('should switch to Russian', async () => {
      await i18n.changeLanguage('ru')
      expect(i18n.language).toBe('ru')
      expect(i18n.t('login.connect')).toBe('Подключиться')
    })

    it('should switch to Belarusian', async () => {
      await i18n.changeLanguage('be')
      expect(i18n.language).toBe('be')
      expect(i18n.t('login.connect')).toBe('Падключыцца')
    })

    it('should switch to Ukrainian', async () => {
      await i18n.changeLanguage('uk')
      expect(i18n.language).toBe('uk')
      expect(i18n.t('login.connect')).toBe('Підключитися')
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

    it('should have correct Russian translations for key UI elements', async () => {
      await i18n.changeLanguage('ru')
      expect(i18n.t('sidebar.messages')).toBe('Сообщения')
      expect(i18n.t('sidebar.rooms')).toBe('Конференции')
      expect(i18n.t('presence.online')).toBe('В сети')
      expect(i18n.t('common.save')).toBe('Сохранить')
      expect(i18n.t('common.cancel')).toBe('Отмена')
    })

    it('should have correct Belarusian translations for key UI elements', async () => {
      await i18n.changeLanguage('be')
      expect(i18n.t('sidebar.messages')).toBe('Паведамлення')
      expect(i18n.t('sidebar.rooms')).toBe('Канферэнцыі')
      expect(i18n.t('presence.online')).toBe('Інтэрнэт')
      expect(i18n.t('common.save')).toBe('Захаваць')
      expect(i18n.t('common.cancel')).toBe('Адмена')
    })

    it('should have correct Ukrainian translations for key UI elements', async () => {
      await i18n.changeLanguage('uk')
      expect(i18n.t('sidebar.messages')).toBe('Повідомлення')
      expect(i18n.t('sidebar.rooms')).toBe('Конференції')
      expect(i18n.t('presence.online')).toBe('Онлайн')
      expect(i18n.t('common.save')).toBe('Зберегти')
      expect(i18n.t('common.cancel')).toBe('Скасування')
    })
  })
})
