/**
 * What an unread recount concluded, published on the diagnostic channel.
 *
 * `recomputeUnreadForRoom` and `recomputeUnreadForConversation` are the only code
 * that derives an unread count from the archive, and until they said so an observer
 * had two bad options: tally the deferral reasons and lose the entity, or re-walk the
 * gate chain outside the store and drift from it. Both shipped, and both are replaced
 * by the recount reporting once per invocation.
 *
 * The one-verdict-per-invocation rule is what makes the report usable: the stores
 * funnel every exit through a single seam, so a new guard cannot be added without
 * naming a reason, and a commit cannot be added without reporting the count.
 *
 * `diagnostics/channel.ts` declares the payload, the reason vocabulary, and which of
 * the recount's side effects deliberately stay private. This module only publishes.
 *
 * @module Stores/Shared/RecountDiagnostics
 */
import {
  publishDiagnostic,
  type RecountEntityKind,
  type UnreadClearedDiagnostic,
  type UnreadRecountDiagnostic,
  type UnreadRecountVerdict,
} from '../../diagnostics/channel'

interface RecountVerdictSource {
  entityKind: RecountEntityKind
  entityId: string
  verdict: UnreadRecountVerdict
}

/**
 * Report one recount's verdict.
 *
 * Call it AFTER the store update, never from inside the `set` callback: a subscriber
 * reached mid-update would read a store that is halfway through committing.
 */
export function reportRecountVerdict(
  entityKind: RecountEntityKind,
  entityId: string,
  verdict: UnreadRecountVerdict
): void {
  publishDiagnostic('unread-recount', unreadRecountEvent, { entityKind, entityId, verdict })
}

const unreadRecountEvent = (source: RecountVerdictSource): UnreadRecountDiagnostic => ({
  kind: 'unread-recount',
  entityKind: source.entityKind,
  entityId: source.entityId,
  verdict: source.verdict,
})

interface UnreadClearedSource {
  entityKind: RecountEntityKind
  entityId: string
  previousCount: number
}

/**
 * Report a count-only mark-read: the badge cleared, the read pointer untouched.
 *
 * Published only for that branch of `markAsRead`. When the pointer advances too, the
 * transition needs no name — the derived count moves with it, so the next recount has
 * nothing surprising to report.
 */
export function reportUnreadCleared(
  entityKind: RecountEntityKind,
  entityId: string,
  previousCount: number
): void {
  publishDiagnostic('unread-cleared', unreadClearedEvent, { entityKind, entityId, previousCount })
}

const unreadClearedEvent = (source: UnreadClearedSource): UnreadClearedDiagnostic => ({
  kind: 'unread-cleared',
  entityKind: source.entityKind,
  entityId: source.entityId,
  previousCount: source.previousCount,
})
