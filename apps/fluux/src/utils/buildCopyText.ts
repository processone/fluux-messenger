/**
 * buildCopyText — formats a multi-message clipboard selection as date-grouped text.
 *
 * Pure (no DOM) so it can serve BOTH copy paths identically:
 *  - the mounted-DOM path (`useMessageCopyFormatter`), which reads metadata from
 *    `data-message-*` attributes, and
 *  - the store-backed path, which reconstructs the metadata from the in-memory
 *    message array for the virtualized list (whose windowed DOM lacks the date
 *    separators the DOM path reads).
 *
 * Output mirrors the long-standing inline formatter: messages grouped by date,
 * each date preceded by a "— Weekday, Month D, YYYY —" header (blank line between
 * groups), each message as "From HH:MM\nbody". Returns null when fewer than two
 * messages carry a body — single-message selections fall back to the browser's
 * native copy.
 */
import { format, parseISO } from 'date-fns'

export interface CopyMessageMeta {
  id: string
  from: string
  time: string
  body: string
  /** Date-separator key ('yyyy-MM-dd'), or '' when unknown (uses the fallback). */
  date: string
}

export function buildCopyText(
  messages: CopyMessageMeta[],
  opts: { fallbackDate?: string } = {},
): string | null {
  // Only messages with a body participate (matches the legacy DOM path); a single
  // message is left to the native browser copy.
  const withBody = messages.filter((m) => m.body)
  if (withBody.length <= 1) return null

  // Fallback date for messages that carry none: caller-provided, else the earliest
  // dated message, else today. The `new Date()` branch is only reached when NOTHING
  // is dated and no fallback was given (kept deterministic in tests by those inputs).
  const dated = withBody.map((m) => m.date).filter((d) => d.length > 0)
  const earliestDate = dated.length ? dated.reduce((a, b) => (b < a ? b : a)) : undefined
  const fallbackDate = opts.fallbackDate ?? earliestDate ?? format(new Date(), 'yyyy-MM-dd')

  const byDate = new Map<string, CopyMessageMeta[]>()
  for (const msg of withBody) {
    const key = msg.date || fallbackDate
    const bucket = byDate.get(key)
    if (bucket) bucket.push(msg)
    else byDate.set(key, [msg])
  }

  const lines: string[] = []
  const sortedDates = [...byDate.keys()].sort()
  sortedDates.forEach((dateStr, dateIndex) => {
    if (dateIndex > 0) lines.push('')
    let header: string
    try {
      header = format(parseISO(dateStr), 'EEEE, MMMM d, yyyy')
    } catch {
      header = dateStr
    }
    lines.push(`— ${header} —`)
    for (const msg of byDate.get(dateStr)!) {
      if (msg.from && msg.time) lines.push(`${msg.from} ${msg.time}`)
      lines.push(msg.body)
    }
  })
  return lines.join('\n')
}
