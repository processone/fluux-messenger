import type { GapInterval, Message, RoomMessage } from '../../core/types'
import { isNoLocalStore } from '../../core/types/message-internal'
import * as cache from '../../utils/messageCache'
import { indexMessages } from '../../utils/searchIndex'
import { captureStorageScope } from '../../utils/storageScope'

/** Store a detached date page without attaching it to the currently open timeline. */
export async function saveDateLookupPage(
  kind: 'chat' | 'room',
  id: string,
  messages: (Message | RoomMessage)[],
  reachesLive: boolean,
  isCurrent: () => boolean,
  recordGaps: (gaps: GapInterval[]) => void,
  writeRows: () => Promise<boolean>,
): Promise<boolean> {
  const scope = captureStorageScope()
  const stillCurrent = () => scope.isCurrent() && isCurrent()
  const first = messages[0]
  const last = messages.at(-1)
  if (!first || !last) return true
  // A no-store row cannot be made a durable landing target.
  if (messages.some(isNoLocalStore) || !stillCurrent()) return false
  const [older, newer, heldFirst, heldLast] = await Promise.all([
    cache.getMessages(kind, id, { before: first.timestamp, limit: 1 }),
    cache.getMessages(kind, id, { after: last.timestamp, limit: 1 }),
    first.stanzaId ? cache.getMessageByStanzaId(kind, id, first.stanzaId) : null,
    last.stanzaId ? cache.getMessageByStanzaId(kind, id, last.stanzaId) : null,
  ])
  if (!stillCurrent()) return false
  const lower = older.at(-1)
  const upper = newer[0]
  const gaps: GapInterval[] = []
  if (lower && !heldFirst) gaps.push({ start: +lower.timestamp, end: +first.timestamp, startId: lower.stanzaId, endId: first.stanzaId })
  if (!heldLast && !reachesLive) gaps.push({ start: +last.timestamp, end: upper && +upper.timestamp, startId: last.stanzaId, endId: upper?.stanzaId })
  // Record a seam before exposing its rows in the cache. A failed write can
  // leave a conservative gap, never a false claim of adjacent history.
  if (gaps.length > 0) recordGaps(gaps)
  if (!stillCurrent() || !await writeRows() || !stillCurrent()) return false
  void indexMessages(messages, {}, scope.jid).catch(error => console.warn('[searchIndex] Date lookup indexing failed:', error))
  return true
}
