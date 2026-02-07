/**
 * Hook for time formatting with user preference support.
 *
 * Provides a formatTime function that respects the user's time format setting
 * (12-hour, 24-hour, or system default) and the current language.
 */
import { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useSettingsStore } from '@/stores/settingsStore'
import { formatTime as formatTimeUtil, getEffectiveTimeFormat } from '@/utils/dateFormat'

/**
 * Hook that returns a time formatting function using current settings.
 *
 * @returns formatTime function that takes a Date and returns a formatted time string
 *
 * @example
 * const { formatTime } = useTimeFormat()
 * const timeString = formatTime(new Date()) // "2:30 PM" or "14:30"
 */
export function useTimeFormat() {
  const { i18n } = useTranslation()
  const timeFormat = useSettingsStore((s) => s.timeFormat)

  const formatTime = useCallback(
    (date: Date): string => {
      return formatTimeUtil(date, i18n.language, timeFormat)
    },
    [i18n.language, timeFormat]
  )

  // Resolve 'auto' to actual '12h' or '24h' for layout calculations
  const effectiveTimeFormat = useMemo(
    () => getEffectiveTimeFormat(timeFormat),
    [timeFormat]
  )

  return { formatTime, timeFormat, effectiveTimeFormat }
}
