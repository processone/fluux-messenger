/**
 * Days as the reader sees them: from their local midnight to the next one. The
 * archive and the search index take those two instants in UTC, so a reader in
 * Tokyo and one in Paris each get their own day.
 *
 * @module LocalDay
 */

/** `yyyy-MM-dd` of a local day, the value a date input holds. */
export function localDayValue(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The local midnight that starts the day and the one that ends it; the archive gets them in UTC. */
export function localDayBounds(value: string): { start: Date; end: Date } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, day] = match.slice(1).map(Number)
  return { start: new Date(year, month - 1, day), end: new Date(year, month - 1, day + 1) }
}
