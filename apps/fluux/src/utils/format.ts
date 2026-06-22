/**
 * Pure, dependency-free value formatters — the reusable "friendly kit" shared
 * by admin functions (and beyond). No i18n coupling: callers pass localized
 * unit labels where wording matters (e.g. formatDuration).
 */

export interface DurationUnits {
  d: string
  h: string
  m: string
  s: string
}

const DEFAULT_DURATION_UNITS: DurationUnits = { d: 'd', h: 'h', m: 'm', s: 's' }

/**
 * Format a duration in seconds, showing the two largest non-zero units
 * (e.g. 90061 → "1d 1h"). Always returns at least seconds ("0s").
 */
export function formatDuration(totalSeconds: number, units: DurationUnits = DEFAULT_DURATION_UNITS): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  const seconds = s % 60
  const parts: string[] = []
  if (days) parts.push(`${days}${units.d}`)
  if (hours) parts.push(`${hours}${units.h}`)
  if (minutes) parts.push(`${minutes}${units.m}`)
  if (seconds || parts.length === 0) parts.push(`${seconds}${units.s}`)
  return parts.slice(0, 2).join(' ')
}

/** Localized integer (thousands separators). */
export function formatCount(n: number): string {
  return n.toLocaleString()
}

/** Human-readable byte size. */
export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  const value = bytes / Math.pow(k, i)
  const rounded = Math.round(value * 10) / 10
  return `${rounded} ${sizes[i]}`
}

/** Boolean → compact symbol (locale-neutral). */
export function formatBoolean(value: boolean): string {
  return value ? '✓' : '—'
}

/** Epoch ms → locale date-time string. */
export function formatDateTime(epochMs: number): string {
  return new Date(epochMs).toLocaleString()
}

/** Epoch ms → locale time string (hours:minutes, no date). */
export function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export interface RelativeTimeLabels {
  justNow: string
  minute: string
  hour: string
  day: string
  week: string
  month: string
  year: string
}

/**
 * Seconds-ago to a friendly single-unit relative string ("just now", "5m ago",
 * "2d ago"). Pure: the caller passes localized unit labels. The "{n}{unit} ago"
 * shape is intentionally compact for admin scanning, not precise.
 */
export function formatRelativeTime(secondsAgo: number, labels: RelativeTimeLabels): string {
  const s = Math.floor(secondsAgo)
  if (s < 60) return labels.justNow
  const minute = 60, hour = 3600, day = 86400, week = 604800, month = 2592000, year = 31536000
  const pick = (value: number, unit: string) => `${value}${unit} ago`
  if (s < hour) return pick(Math.floor(s / minute), labels.minute)
  if (s < day) return pick(Math.floor(s / hour), labels.hour)
  if (s < week) return pick(Math.floor(s / day), labels.day)
  if (s < month) return pick(Math.floor(s / week), labels.week)
  if (s < year) return pick(Math.floor(s / month), labels.month)
  return pick(Math.floor(s / year), labels.year)
}
