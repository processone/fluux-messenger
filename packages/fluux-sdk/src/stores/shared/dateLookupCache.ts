import type { GapInterval, Message, RoomMessage } from '../../core/types'
import { isNoLocalStore } from '../../core/types/message-internal'
import * as cache from '../../utils/messageCache'
import { indexMessages } from '../../utils/searchIndex'
import { captureStorageScope } from '../../utils/storageScope'
import { splitGapsAroundDatePage, type GapList } from './mamGap'

/** Store a detached date page without attaching it to the currently open timeline. */
export async function saveDateLookupPage(
  kind: 'chat' | 'room',
  id: string,
  messages: (Message | RoomMessage)[],
  reachesLive: boolean,
  isCurrent: () => boolean,
  updateGaps: (transition: (held: GapList) => GapList) => void,
  writeRows: () => Promise<boolean>,
): Promise<boolean> {
  const scope = captureStorageScope()
  const stillCurrent = () => scope.isCurrent() && isCurrent()
  const first = messages[0]
  const last = messages.at(-1)
  if (!first || !last) return true
  // A no-store row cannot be made a durable landing target.
  if (messages.some(isNoLocalStore) || !stillCurrent()) return false
  const [older, newer, identities] = await Promise.all([
    cache.readMessages(kind, id, { before: first.timestamp, limit: 1 }),
    cache.readMessages(kind, id, { after: last.timestamp, limit: 1 }),
    // Match the same identity tiers as a cache upsert, including a sender's
    // optimistic copy that has not received its archive ID yet.
    cache.resolveMessagesForIndex(first === last ? [first] : [first, last], scope.jid).catch(() => null),
  ])
  if (older.status !== 'ok' || newer.status !== 'ok' || !identities || !stillCurrent()) return false
  const heldFirst = identities[0]?.cached
  const heldLast = identities.at(-1)?.cached
  const lower = older.value.at(-1)
  const upper = newer.value[0]
  const gaps: GapInterval[] = []
  if (lower && !heldFirst) gaps.push({ start: +lower.timestamp, end: +first.timestamp, startId: lower.stanzaId, endId: first.stanzaId })
  if (!heldLast && !reachesLive) gaps.push({ start: +last.timestamp, end: upper && +upper.timestamp, startId: last.stanzaId, endId: upper?.stanzaId })
  // Record a seam before exposing its rows in the cache. A failed write can
  // leave a conservative gap, never a false claim of adjacent history.
  if (gaps.length > 0) updateGaps(held => [...held, ...gaps])
  if (!stillCurrent() || !await writeRows() || !stillCurrent()) return false
  // Only a durable page can fill part of a previously recorded gap.
  updateGaps(held => splitGapsAroundDatePage(held, first, last))
  void indexMessages(messages, {}, scope.jid).catch(error => console.warn('[searchIndex] Date lookup indexing failed:', error))
  return true
}
