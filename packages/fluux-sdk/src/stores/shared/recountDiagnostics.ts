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
 * the recount's side effects deliberately stay private. This module holds the rules
 * the two stores would otherwise each restate: the one-verdict ledger, what counts as
 * a count-only clear, and the publication itself. Chat and room differ only in the
 * entity kind they name, so the kind is a parameter.
 *
 * @module Stores/Shared/RecountDiagnostics
 */
import { sameMessageRow } from '../../utils/messageIdentity'
import type { EntityNotificationState } from './notificationState'
import { pointerRowRef } from './readPointer'
import {
  publishDiagnostic,
  type RecountDeferralReason,
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

/**
 * The ledger one recount invocation writes its single verdict into.
 *
 * A recount is a chain of about twenty guards, most of which stand down. What makes
 * the verdict trustworthy is that EVERY exit goes through {@link RecountLedger.defer}
 * or {@link RecountLedger.counted} and the result is published once — so a new guard
 * cannot be added without naming a reason, and the commit cannot change without
 * saying what it committed. Holding that rule here rather than in each store is what
 * keeps the two recounts from drifting into two different rules.
 *
 * `scheduleRetry` stays with the caller: the bounded trailing retry an
 * `input-version-changed` deferral earns is driven by the store's own retry state and
 * readiness predicate, which the ledger has no business knowing.
 */
export interface RecountLedger {
  /** Stand down, naming the guard. Queues the trailing retry on an input change. */
  defer(reason: RecountDeferralReason): void
  /** Commit a count, paired with the badge it replaced in the same `set` turn. */
  counted(count: number, previousCount: number): void
  /**
   * Publish the verdict the body produced.
   *
   * Call it from the recount's outermost `finally`, AFTER the store update: a
   * subscriber reached mid-update would read a store halfway through committing.
   * Nothing is published when the body threw, which is not a verdict about anything.
   */
  publish(): void
}

export function recountLedger(
  entityKind: RecountEntityKind,
  entityId: string,
  scheduleRetry: () => void
): RecountLedger {
  let verdict: UnreadRecountVerdict | undefined
  return {
    defer(reason) {
      verdict = { status: 'deferred', reason }
      if (reason === 'input-version-changed') scheduleRetry()
    },
    counted(count, previousCount) {
      verdict = { status: 'counted', count, previousCount }
    },
    publish() {
      if (verdict) reportRecountVerdict(entityKind, entityId, verdict)
    },
  }
}

/**
 * The badge value a count-only mark-read cleared, or `undefined` when this was not
 * one.
 *
 * A count-only clear is a nonzero badge going to zero while the read position stays
 * put: above the live edge `markAsRead` cannot know which message the reader reached,
 * so it deliberately preserves the pointer (#1076). Row identity decides whether the
 * position moved, not the client message id — a reused MUC nick puts two rows under
 * one id.
 *
 * Pure, so it can be evaluated inside the store's `set` callback where both states
 * are in hand while {@link reportUnreadCleared} publishes after the update.
 */
export function countOnlyClear(
  before: EntityNotificationState,
  after: EntityNotificationState
): number | undefined {
  const readPositionStayed =
    after.readPointer && before.readPointer
      ? sameMessageRow(pointerRowRef(after.readPointer), pointerRowRef(before.readPointer))
      : after.readPointer === before.readPointer
  if (before.unreadCount > 0 && after.unreadCount === 0 && readPositionStayed) {
    return before.unreadCount
  }
  return undefined
}
