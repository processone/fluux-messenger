import * as messageCache from './messageCache'
import { logInfo } from '../core/logger'
import type { Message } from '../core/types/chat'
import type { RoomMessage } from '../core/types/room'
import type { HistoryQueryOptions, HistoryResult, RoomHistoryQueryOptions, RoomHistoryResult } from '../core/types/pagination'

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
 * Three sources, cheapest first. The messages loaded on screen (`resident`, in
 * chronological order) and then the cache answer alone when they hold a message of
 * that day and one before it, so the day's beginning is known. Otherwise the archive
 * is asked for the page that starts at `start`; what it returns lands in the cache,
 * so the list can then load the window around the message. The earliest message any
 * source found wins. When the day is empty the first later message is returned, and
 * the caller can tell from its timestamp.
 */
export async function findFirstMessageOfDay(
  archive: DayArchive,
  kind: 'chat' | 'room',
  conversationId: string,
  start: Date,
  end: Date,
  resident: readonly AnyMessage[] = [],
): Promise<FirstMessageOfDay> {
  const from = start.getTime()
  const inDay = (message: AnyMessage | undefined) => !!message && message.timestamp.getTime() < end.getTime()
  const log = (outcome: string) => logInfo(`Jump to date: ${kind} ${start.toISOString()} → ${outcome}`)

  const loaded = firstFrom(resident, from)
  if (loaded.covered && inDay(loaded.first)) {
    log('loaded window')
    return { kind: 'found', message: loaded.first!, source: 'resident' }
  }

  // `after` is exclusive; one millisecond earlier keeps a message sent exactly at midnight
  const [fromStart, beforeStart] = await Promise.all([
    messageCache.readMessages(kind, conversationId, { after: new Date(from - 1), limit: 1 }),
    messageCache.readMessages(kind, conversationId, { before: start, limit: 1 }),
  ])
  const cached = fromStart.status === 'ok' ? fromStart.value[0] as AnyMessage | undefined : undefined
  const covered = beforeStart.status === 'ok' && beforeStart.value.length > 0
  if (cached && covered && inDay(cached)) {
    log('cache')
    return { kind: 'found', message: cached, source: 'cache' }
  }

  let archived: AnyMessage | undefined
  let complete = false
  let failed = false
  try {
    const at = start.toISOString()
    // maxAutoPages makes a 1:1 query page forward from `start`; without it the page is the newest one
    const result = kind === 'room'
      ? await archive.queryRoomMAM({ roomJid: conversationId, start: at, max: ARCHIVE_PAGE, maxAutoPages: 1, preserveGapMarker: true })
      : await archive.queryMAM({ with: conversationId, start: at, max: ARCHIVE_PAGE, maxAutoPages: 1, preserveGapMarker: true })
    archived = (result.messages as AnyMessage[]).find((message) => message.timestamp.getTime() >= from)
    complete = result.complete
    log(`archive page of ${result.messages.length}, complete=${complete}`)
  } catch (error) {
    failed = true
    log(`archive failed: ${error instanceof Error ? error.message : String(error)}`)
  }

  // A message only this device holds (archiving off, or sent before it was on) can come first
  const candidates: Array<[AnyMessage | undefined, 'resident' | 'cache' | 'archive']> = [[loaded.first, 'resident'], [cached, 'cache'], [archived, 'archive']]
  let best: [AnyMessage, 'resident' | 'cache' | 'archive'] | undefined
  for (const [message, source] of candidates) {
    if (message && (!best || message.timestamp.getTime() < best[0].timestamp.getTime())) best = [message, source]
  }
  if (best) return { kind: 'found', message: best[0], source: best[1] }
  return complete && !failed ? { kind: 'none' } : { kind: 'unknown' }
}
