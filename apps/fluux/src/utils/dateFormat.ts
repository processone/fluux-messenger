/**
 * Date Formatting Utilities
 *
 * Shared utilities for formatting dates with i18n locale support.
 */

import { format, isToday, isYesterday, type Locale } from 'date-fns'
import { de, enUS, es, fr, it, nl, pl, pt, ro } from 'date-fns/locale'
import type { TimeFormat } from '@/stores/settingsStore'

// Map language codes to date-fns locales
const dateLocales: Record<string, Locale> = {
  en: enUS,
  de,
  es,
  fr,
  it,
  nl,
  pl,
  pt,
  ro,
}

// Cache for system locale 12-hour detection
let _systemUses12Hour: boolean | null = null

/**
 * Get the date-fns locale for a given language code.
 * Falls back to English if the language is not supported.
 */
export function getDateLocale(lang: string): Locale {
  return dateLocales[lang] || enUS
}

/**
 * Detect if the system locale uses 12-hour time format.
 * Uses Intl.DateTimeFormat to check the actual system preference.
 *
 * @returns true if the system locale uses 12-hour format
 */
export function systemUses12Hour(): boolean {
  if (_systemUses12Hour !== null) {
    return _systemUses12Hour
  }

  try {
    // Format a test time and check for AM/PM markers
    const testDate = new Date(2024, 0, 1, 14, 30) // 2:30 PM
    const formatted = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: 'numeric',
    }).format(testDate)

    // Check if the formatted time contains AM/PM (or localized equivalents)
    // 12-hour format will show "2:30 PM" or similar
    // 24-hour format will show "14:30" or similar
    _systemUses12Hour = !/^1?[4-9]|^2[0-3]/.test(formatted.replace(/\D/g, '').slice(0, 2))

    // More reliable: check if hour is less than 13 (would be 2, not 14)
    const hourMatch = formatted.match(/\d+/)
    if (hourMatch) {
      const hour = parseInt(hourMatch[0], 10)
      _systemUses12Hour = hour < 13
    }
  } catch {
    // Default to 24-hour format if detection fails
    _systemUses12Hour = false
  }

  return _systemUses12Hour
}

/**
 * Get the effective time format, resolving 'auto' to actual format.
 *
 * @param timeFormat - User's time format preference
 * @returns '12h' or '24h' (never 'auto')
 */
export function getEffectiveTimeFormat(timeFormat: TimeFormat): '12h' | '24h' {
  if (timeFormat === 'auto') {
    return systemUses12Hour() ? '12h' : '24h'
  }
  return timeFormat
}

/**
 * Format a time according to user preference.
 *
 * @param date - Date to format
 * @param lang - Current language code (used for locale-specific AM/PM text)
 * @param timeFormat - User's time format preference ('12h', '24h', or 'auto')
 * @returns Formatted time string (e.g., "2:30 PM" or "14:30")
 */
export function formatTime(
  date: Date,
  lang: string,
  timeFormat: TimeFormat = 'auto'
): string {
  const locale = getDateLocale(lang)

  // Determine whether to use 12-hour format
  let use12Hour: boolean
  if (timeFormat === '12h') {
    use12Hour = true
  } else if (timeFormat === '24h') {
    use12Hour = false
  } else {
    // 'auto' - use system locale preference
    use12Hour = systemUses12Hour()
  }

  if (use12Hour) {
    // 12-hour format with AM/PM (e.g., "2:30 PM")
    return format(date, 'h:mm a', { locale })
  } else {
    // 24-hour format (e.g., "14:30")
    return format(date, 'HH:mm', { locale })
  }
}

/**
 * Format a date string for use as a message group header.
 * Returns translated "Today" or "Yesterday" for recent dates,
 * or a localized full date for older dates.
 *
 * @param dateStr - Date string in 'yyyy-MM-dd' format
 * @param t - Translation function from i18next
 * @param lang - Current language code (e.g., 'en', 'fr', 'pt')
 * @returns Formatted date string
 */
export function formatDateHeader(
  dateStr: string,
  t: (key: string) => string,
  lang: string
): string {
  // Parse yyyy-MM-dd as LOCAL midnight (not UTC)
  // new Date('2026-02-01') parses as UTC midnight, which can be the previous day
  // in western timezones. Explicitly constructing with year/month/day ensures local time.
  const [year, month, day] = dateStr.split('-').map(Number)
  const date = new Date(year, month - 1, day)

  if (isToday(date)) return t('dates.today')
  if (isYesterday(date)) return t('dates.yesterday')

  const locale = getDateLocale(lang)
  return format(date, 'PPP', { locale })
}

/**
 * Format a date for display with locale support.
 * Uses the 'PPP' format pattern which produces localized long dates
 * like "December 23, 2025" (en) or "23 décembre 2025" (fr).
 *
 * @param date - Date to format
 * @param lang - Current language code
 * @returns Formatted date string
 */
export function formatLocalizedDate(date: Date, lang: string): string {
  const locale = getDateLocale(lang)
  return format(date, 'PPP', { locale })
}

/**
 * Format a timestamp for conversation list display.
 * Shows time if within last 12 hours or today, "Yesterday" for yesterday,
 * or a short date for older messages.
 *
 * @param date - Timestamp to format
 * @param t - Translation function from i18next
 * @param lang - Current language code
 * @param timeFormat - User's time format preference ('12h', '24h', or 'auto')
 * @returns Formatted timestamp string
 */
export function formatConversationTime(
  date: Date,
  t: (key: string) => string,
  lang: string,
  timeFormat: TimeFormat = 'auto'
): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)
  const locale = getDateLocale(lang)

  // If within last 12 hours or today, show time
  if (diffHours < 12 || isToday(date)) {
    return formatTime(date, lang, timeFormat)
  }

  // If yesterday, show "Yesterday"
  if (isYesterday(date)) {
    return t('dates.yesterday')
  }

  // Otherwise show short date (e.g., "Dec 23" or "23 déc.")
  return format(date, 'MMM d', { locale })
}
