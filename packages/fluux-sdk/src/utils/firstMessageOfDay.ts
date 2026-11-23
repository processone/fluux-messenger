import * as messageCache from './messageCache'
import { logInfo } from '../core/logger'
import type { Message } from '../core/types/chat'
import type { RoomMessage } from '../core/types/room'
import type { GapInterval, HistoryQueryOptions, HistoryResult, RoomHistoryQueryOptions, RoomHistoryResult } from '../core/types/pagination'

/** The archive queries the lookup needs; `client.messages` provides them. */
export interface DayArchive {
  queryMAM(options: HistoryQueryOptions): Promise<HistoryResult>
  queryRoomMAM(options: RoomHistoryQueryOptions): Promise<RoomHistoryResult>
}

export type FirstMessageOfDay =
  | { kind: 'found'; message: Message | RoomMessage; source: 'resident' | 'cache' | 'archive' }
  /** Nothing at or after the start: the archive answered and holds no later message. */
  | { kind: 'none' }
  /** The cache does not cover the day and the archive could not be asked. */
  | { kind: 'unknown' }

type AnyMessage = Message | RoomMessage

/** Messages asked from the archive: the day's first rows plus room to scroll down. */
const ARCHIVE_PAGE = 50

/** The first message at or after `start` in a chronological list, and whether one comes before it. */
function firstFrom(messages: readonly AnyMessage[], start: number): { first?: AnyMessage; covered: boolean } {
  const index = messages.findIndex((message) => message.timestamp.getTime() >= start)
  return index === -1 ? { covered: messages.length > 0 } : { first: messages[index], covered: index > 0 }
}

/**
 * The first message of a conversation at or after `start`, for jumping to a date.
 * `start` and `end` are the bounds of the day the reader picked, in their own time
 * zone; the archive receives them as UTC instants.
 *
 * A resident window spanning the day’s start can answer immediately unless a
 * known gap crosses it. Cached rows may belong to separate blocks, so use them
 * only alongside the day-bounded archive request or when the archive cannot answer.
 * A page limit alone does not bound the server's count.
 */
export async function findFirstMessageOfDay(
  archive: DayArchive | undefined,
  kind: 'chat' | 'room',
  conversationId: string,
  start: Date,
  end: Date,
  resident: readonly AnyMessage[] = [],
  gaps: readonly GapInterval[] = [],
): Promise<FirstMessageOfDay> {
  const from = start.getTime()
  const inDay = (message: AnyMessage | undefined) => !!message && message.timestamp < end
  const hasGapBefore = (message: AnyMessage) => gaps.some((gap) =>
    gap.start < message.timestamp.getTime() && (gap.end ?? Infinity) > from)
  const log = (outcome: string) => logInfo(`Jump to date: ${kind} ${start.toISOString()} → ${outcome}`)

  const loaded = firstFrom(resident, from)
  if (loaded.covered && loaded.first && inDay(loaded.first) && !hasGapBefore(loaded.first)) {
    log('loaded window')
    return { kind: 'found', message: loaded.first, source: 'resident' }
  }

  // `after` is exclusive; one millisecond earlier keeps a message sent exactly at midnight
  const fromStart = await messageCache.readMessages(kind, conversationId, { after: new Date(from - 1), limit: 1 })
  const cached = fromStart.status === 'ok' ? fromStart.value[0] : undefined

  const readArchive = (archive: DayArchive, start: Date, end?: Date) => {
    const options = {
      start: start.toISOString(), ...(end ? { end: end.toISOString() } : {}),
      max: ARCHIVE_PAGE, dateLookup: true,
    }
    return kind === 'room'
      ? archive.queryRoomMAM({ roomJid: conversationId, ...options })
      : archive.queryMAM({ with: conversationId, ...options })
  }
  let archived: AnyMessage | undefined
  let dayComplete = !archive && fromStart.status === 'ok'
  let complete = dayComplete
  if (archive) {
    try {
      // MAM time bounds are inclusive. A result exactly at the next midnight
      // is already the earliest later message; the caller labels it as later.
      const day = await readArchive(archive, start, end)
      archived = day.messages.find((message) => message.timestamp >= start && message.timestamp <= end)
      dayComplete = day.complete
      log(`archive day page of ${day.messages.length}, complete=${dayComplete}`)
      if (!archived && dayComplete && !inDay(loaded.first) && !inDay(cached)) {
        // A complete day is not the live edge. Only an empty day needs a second
        // query for the next message, so busy archives don't count years of rows.
        const later = await readArchive(archive, end)
        archived = later.messages.find((message) => message.timestamp >= end)
        complete = later.complete
        log(`later archive page of ${later.messages.length}, complete=${complete}`)
      }
    } catch (error) {
      log(`archive failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // A message only this device holds (archiving off, or sent before it was on) can come first
  const candidates: Array<[AnyMessage | undefined, 'resident' | 'cache' | 'archive']> = [[loaded.first, 'resident'], [cached, 'cache'], [archived, 'archive']]
  let best: [AnyMessage, 'resident' | 'cache' | 'archive'] | undefined
  for (const [message, source] of candidates) {
    if (!message) continue
    // A later local row cannot prove an unanswered day empty. Same-day local
    // rows remain useful unless a known hole may hide an earlier result.
    if (!inDay(message) && !dayComplete && !archived) continue
    if (!archived && !complete && !(dayComplete && inDay(message)) && hasGapBefore(message)) continue
    if (!best || message.timestamp < best[0].timestamp) best = [message, source]
  }
  if (best) return { kind: 'found', message: best[0], source: best[1] }
  return complete ? { kind: 'none' } : { kind: 'unknown' }
}
