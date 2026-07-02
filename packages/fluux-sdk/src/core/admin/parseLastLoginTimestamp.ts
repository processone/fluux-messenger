/**
 * Parse ejabberd's `get-user-lastlogin` raw value when it's the confirmed
 * "YYYY-MM-DD HH:MM:SS" server-local timestamp shape, as opposed to a
 * localized phrase like "En ligne"/"Online" for an online account. Returns
 * null when the value doesn't match — callers should fall back to
 * displaying the raw string rather than guessing a format.
 *
 * The timestamp has no timezone info (per confirmed live traffic), so it's
 * interpreted in the browser's local timezone. This can skew the computed
 * "time ago" by the server/client timezone offset — acceptable given the
 * coarse (day/week/month) granularity this feeds into.
 */
export function parseAdminLastLoginTimestamp(raw: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim())
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const ms = new Date(year, month - 1, day, hour, minute, second).getTime()
  return Number.isNaN(ms) ? null : ms
}
