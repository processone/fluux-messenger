/**
 * Date Formatting Utilities
 *
 * Shared utilities for formatting dates with i18n locale support.
 */

import { format, isToday, isYesterday, type Locale } from 'date-fns'
import { enUS, fr, pt } from 'date-fns/locale'

// Map language codes to date-fns locales
const dateLocales: Record<string, Locale> = {
  en: enUS,
  fr,
  pt,
}

/**
 * Get the date-fns locale for a given language code.
 * Falls back to English if the language is not supported.
 */
export function getDateLocale(lang: string): Locale {
  return dateLocales[lang] || enUS
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
 * @returns Formatted timestamp string
 */
export function formatConversationTime(
  date: Date,
  t: (key: string) => string,
  lang: string
): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = diffMs / (1000 * 60 * 60)
  const locale = getDateLocale(lang)

  // If within last 12 hours or today, show time
  if (diffHours < 12 || isToday(date)) {
    return format(date, 'p', { locale }) // e.g., "2:30 PM" or "14:30"
  }

  // If yesterday, show "Yesterday"
  if (isYesterday(date)) {
    return t('dates.yesterday')
  }

  // Otherwise show short date (e.g., "Dec 23" or "23 déc.")
  return format(date, 'MMM d', { locale })
}
