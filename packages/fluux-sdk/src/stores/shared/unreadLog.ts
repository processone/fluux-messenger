/**
 * Log lines that explain where an unread badge came from: a count raised on a
 * conversation the reader is not viewing, a recount that changed a count, and a
 * recount held back by a pending XEP-0490 read marker.
 *
 * A conversation is named by its domain only, like the archive logs; a room by
 * its JID. Raises are logged for conversations only: a busy room raises its
 * count on every message, and its badge is not the one being diagnosed.
 *
 * @module Stores/Shared/UnreadLog
 */

import { getDomain } from '../../core/jid'
import { logInfo } from '../../core/logger'
import type { RecountEntityKind, UnreadRecountVerdict } from '../../diagnostics/channel'

function label(kind: RecountEntityKind, entityId: string): string {
  return kind === 'room' ? entityId : `...@${getDomain(entityId) || '*'}`
}

interface UnreadEntry {
  unreadCount?: number
  pendingRemoteDisplayedStanzaId?: string
  lastMessage?: unknown
}

/**
 * Log every conversation whose unread count rose between `previous` and `current`,
 * except the one being viewed. Entries are compared by reference first, so an
 * unchanged entry costs nothing.
 */
export function logUnreadRaises(
  current: ReadonlyMap<string, UnreadEntry>,
  previous: ReadonlyMap<string, UnreadEntry>,
  activeId: string | null,
): void {
  if (current === previous) return
  for (const [id, entry] of current) {
    const before = previous.get(id)
    if (entry === before || id === activeId) continue
    const from = before?.unreadCount ?? 0
    const to = entry.unreadCount ?? 0
    if (to <= from) continue
    const notes = [
      ...(before && entry.lastMessage !== before.lastMessage ? ['with a new last message'] : []),
      ...(entry.pendingRemoteDisplayedStanzaId ? ['read marker pending'] : []),
    ]
    logInfo(`Unread raised ${label('chat', id)}: ${from} → ${to}${notes.map((n) => `, ${n}`).join('')}`)
  }
}

/** Entities whose recount is currently held back by a pending marker, so the hold is logged once. */
const heldByMarker = new Set<string>()

/** Log a recount verdict that explains a badge: a changed count, or a hold by a pending marker. */
export function logRecountVerdict(kind: RecountEntityKind, entityId: string, verdict: UnreadRecountVerdict): void {
  const key = `${kind}:${entityId}`
  if (verdict.status === 'deferred') {
    if (verdict.reason !== 'pending-remote-displayed' || heldByMarker.has(key)) return
    heldByMarker.add(key)
    logInfo(`Unread recount ${label(kind, entityId)} held back by a pending read marker`)
    return
  }
  heldByMarker.delete(key)
  if (verdict.count !== verdict.previousCount) {
    logInfo(`Unread recount ${label(kind, entityId)}: ${verdict.previousCount} → ${verdict.count}`)
  }
}

/** Test-only. */
export function _resetUnreadLogForTesting(): void {
  heldByMarker.clear()
}
