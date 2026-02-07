import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  formatDateHeader,
  formatLocalizedDate,
  formatConversationTime,
  getDateLocale,
  formatTime,
} from './dateFormat'
import { enUS, fr, pt, de, es } from 'date-fns/locale'

describe('dateFormat', () => {
  // ------------------------------
  // getDateLocale
  // ------------------------------
  describe('getDateLocale', () => {
    it('should return English locale for "en"', () => {
      expect(getDateLocale('en')).toBe(enUS)
    })

    it('should return French locale for "fr"', () => {
      expect(getDateLocale('fr')).toBe(fr)
    })

    it('should return Portuguese (European) locale for "pt"', () => {
      expect(getDateLocale('pt')).toBe(pt)
    })

    it('should return German locale for "de"', () => {
      expect(getDateLocale('de')).toBe(de)
    })

    it('should return Spanish locale for "es"', () => {
      expect(getDateLocale('es')).toBe(es)
    })

    it('should fall back to English for unsupported languages', () => {
      expect(getDateLocale('unknown')).toBe(enUS)
    })
  })

  // ------------------------------
  // formatLocalizedDate
  // ------------------------------
  describe('formatLocalizedDate', () => {
    const testDate = new Date('2025-12-23')

    it('should format date in English', () => {
      const result = formatLocalizedDate(testDate, 'en')
      expect(result).toBe('December 23rd, 2025')
    })

    it('should format date in French', () => {
      const result = formatLocalizedDate(testDate, 'fr')
      expect(result).toBe('23 décembre 2025')
    })

    it('should format date in Portuguese (European)', () => {
      const result = formatLocalizedDate(testDate, 'pt')
      expect(result).toBe('23 de dezembro de 2025')
    })

    it('should fall back to English for unsupported language', () => {
      const result = formatLocalizedDate(testDate, 'unknown')
      expect(result).toBe('December 23rd, 2025')
    })
  })

  // ------------------------------
  // formatDateHeader
  // ------------------------------
  describe('formatDateHeader', () => {
    const mockTEn = (key: string) => {
      const translations: Record<string, string> = {
        'dates.today': 'Today',
        'dates.yesterday': 'Yesterday',
      }
      return translations[key] || key
    }

    const mockTFr = (key: string) => {
      const translations: Record<string, string> = {
        'dates.today': "Aujourd'hui",
        'dates.yesterday': 'Hier',
      }
      return translations[key] || key
    }

    const mockTPt = (key: string) => {
      const translations: Record<string, string> = {
        'dates.today': 'Hoje',
        'dates.yesterday': 'Ontem',
      }
      return translations[key] || key
    }

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-12-30T12:00:00'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    // ---------- EN tests ----------
    it('should return translated "Today" for today (EN)', () => {
      const result = formatDateHeader('2025-12-30', mockTEn, 'en')
      expect(result).toBe('Today')
    })

    it('should return translated "Yesterday" for yesterday (EN)', () => {
      const result = formatDateHeader('2025-12-29', mockTEn, 'en')
      expect(result).toBe('Yesterday')
    })

    it('should return localized date in English for older dates', () => {
      const result = formatDateHeader('2025-12-23', mockTEn, 'en')
      expect(result).toBe('December 23rd, 2025')
    })

    it('should return localized date for dates from previous months (EN)', () => {
      const result = formatDateHeader('2025-11-15', mockTEn, 'en')
      expect(result).toBe('November 15th, 2025')
    })

    it('should return localized date for dates from previous years (EN)', () => {
      const result = formatDateHeader('2024-06-01', mockTEn, 'en')
      expect(result).toBe('June 1st, 2024')
    })

    // ---------- FR tests ----------
    it('should return translated "Aujourd\'hui" for today (FR)', () => {
      const result = formatDateHeader('2025-12-30', mockTFr, 'fr')
      expect(result).toBe("Aujourd'hui")
    })

    it('should return translated "Hier" for yesterday (FR)', () => {
      const result = formatDateHeader('2025-12-29', mockTFr, 'fr')
      expect(result).toBe('Hier')
    })

    it('should return localized date in French for older dates', () => {
      const result = formatDateHeader('2025-12-23', mockTFr, 'fr')
      expect(result).toBe('23 décembre 2025')
    })

    it('should return localized date for dates from previous months (FR)', () => {
      const result = formatDateHeader('2025-11-15', mockTFr, 'fr')
      expect(result).toBe('15 novembre 2025')
    })

    it('should return localized date for dates from previous years (FR)', () => {
      const result = formatDateHeader('2024-06-01', mockTFr, 'fr')
      expect(result).toBe('1 juin 2024')
    })

    // ---------- PT tests ----------
    it('should return translated "Hoje" for today (PT)', () => {
      const result = formatDateHeader('2025-12-30', mockTPt, 'pt')
      expect(result).toBe('Hoje')
    })

    it('should return translated "Ontem" for yesterday (PT)', () => {
      const result = formatDateHeader('2025-12-29', mockTPt, 'pt')
      expect(result).toBe('Ontem')
    })

    it('should return localized date in Portuguese for older dates', () => {
      const result = formatDateHeader('2025-12-23', mockTPt, 'pt')
      expect(result).toBe('23 de dezembro de 2025')
    })

    it('should return localized date for dates from previous months (PT)', () => {
      const result = formatDateHeader('2025-11-15', mockTPt, 'pt')
      expect(result).toBe('15 de novembro de 2025')
    })
  })

  // ------------------------------
  // formatTime
  // ------------------------------
  describe('formatTime', () => {
    const testDate = new Date('2025-12-30T14:30:00')

    describe('12-hour format', () => {
      it('should format time as 12-hour with AM/PM in English', () => {
        const result = formatTime(testDate, 'en', '12h')
        expect(result).toBe('2:30 PM')
      })

      it('should format morning time as AM', () => {
        const morning = new Date('2025-12-30T08:15:00')
        const result = formatTime(morning, 'en', '12h')
        expect(result).toBe('8:15 AM')
      })

      it('should format noon correctly', () => {
        const noon = new Date('2025-12-30T12:00:00')
        const result = formatTime(noon, 'en', '12h')
        expect(result).toBe('12:00 PM')
      })

      it('should format midnight correctly', () => {
        const midnight = new Date('2025-12-30T00:00:00')
        const result = formatTime(midnight, 'en', '12h')
        expect(result).toBe('12:00 AM')
      })
    })

    describe('24-hour format', () => {
      it('should format time as 24-hour in English', () => {
        const result = formatTime(testDate, 'en', '24h')
        expect(result).toBe('14:30')
      })

      it('should format morning time with leading zero', () => {
        const morning = new Date('2025-12-30T08:15:00')
        const result = formatTime(morning, 'en', '24h')
        expect(result).toBe('08:15')
      })

      it('should format noon correctly', () => {
        const noon = new Date('2025-12-30T12:00:00')
        const result = formatTime(noon, 'en', '24h')
        expect(result).toBe('12:00')
      })

      it('should format midnight correctly', () => {
        const midnight = new Date('2025-12-30T00:00:00')
        const result = formatTime(midnight, 'en', '24h')
        expect(result).toBe('00:00')
      })
    })

    describe('localized formats', () => {
      it('should use French locale for French language', () => {
        // French uses same format as English but with French locale
        const result = formatTime(testDate, 'fr', '12h')
        expect(result).toBe('2:30 PM')
      })

      it('should use Portuguese locale for Portuguese language', () => {
        const result = formatTime(testDate, 'pt', '24h')
        expect(result).toBe('14:30')
      })

      it('should fall back to English for unknown language', () => {
        const result = formatTime(testDate, 'unknown', '12h')
        expect(result).toBe('2:30 PM')
      })
    })
  })

  // ------------------------------
  // formatConversationTime
  // ------------------------------
  describe('formatConversationTime', () => {
    const mockTEn = (key: string) => {
      const translations: Record<string, string> = {
        'dates.yesterday': 'Yesterday',
      }
      return translations[key] || key
    }

    const mockTFr = (key: string) => {
      const translations: Record<string, string> = {
        'dates.yesterday': 'Hier',
      }
      return translations[key] || key
    }

    const mockTPt = (key: string) => {
      const translations: Record<string, string> = {
        'dates.yesterday': 'Ontem',
      }
      return translations[key] || key
    }

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2025-12-30T14:00:00'))
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    // ---------- EN with 12h format ----------
    it('should show time in 12h format for messages within last 12 hours (EN)', () => {
      const date = new Date('2025-12-30T08:30:00')
      const result = formatConversationTime(date, mockTEn, 'en', '12h')
      expect(result).toBe('8:30 AM')
    })

    it('should show time in 24h format for messages within last 12 hours (EN)', () => {
      const date = new Date('2025-12-30T08:30:00')
      const result = formatConversationTime(date, mockTEn, 'en', '24h')
      expect(result).toBe('08:30')
    })

    it('should show "Yesterday" for messages from yesterday (EN)', () => {
      const date = new Date('2025-12-29T20:00:00')
      const result = formatConversationTime(date, mockTEn, 'en', '12h')
      expect(result).toBe('Yesterday')
    })

    // ---------- FR with 24h format ----------
    it('should show "Hier" for yesterday in French', () => {
      const date = new Date('2025-12-29T20:00:00')
      const result = formatConversationTime(date, mockTFr, 'fr', '24h')
      expect(result).toBe('Hier')
    })

    it('should show short date for older messages in French', () => {
      const date = new Date('2025-12-23T15:00:00')
      const result = formatConversationTime(date, mockTFr, 'fr', '24h')
      expect(result).toBe('déc. 23')
    })

    // ---------- PT with 24h format ----------
    it('should show time in 24h format for messages today in Portuguese', () => {
      const date = new Date('2025-12-30T08:30:00')
      const result = formatConversationTime(date, mockTPt, 'pt', '24h')
      expect(result).toBe('08:30')
    })

    it('should show time in 12h format for messages today in Portuguese', () => {
      const date = new Date('2025-12-30T08:30:00')
      const result = formatConversationTime(date, mockTPt, 'pt', '12h')
      expect(result).toBe('8:30 AM')
    })

    it('should show "Ontem" for messages from yesterday in Portuguese', () => {
      const date = new Date('2025-12-29T20:00:00')
      const result = formatConversationTime(date, mockTPt, 'pt', '24h')
      expect(result).toBe('Ontem')
    })

    it('should show short date for older messages in Portuguese', () => {
      const date = new Date('2025-12-23T15:00:00')
      const result = formatConversationTime(date, mockTPt, 'pt', '24h')
      expect(result).toBe('dez 23')
    })
  })
})
