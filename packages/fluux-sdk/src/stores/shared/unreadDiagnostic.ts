/**
 * The unread badge, next to the count the archive says it should be.
 *
 * A badge and its archive-derived truth legitimately disagree for a window during
 * an ordinary recount, and the recount itself declines to count in about twenty
 * situations where any number would be a guess. So a consumer cannot simply ask for
 * "the real count" and compare: it needs to know whether the two numbers it is
 * holding were ever comparable at all.
 *
 * That is what `status` says, and why both counts arrive together:
 *
 * - `exact` — both numbers come from ONE validated snapshot. Only these compare.
 * - `deferred` — a coverage or metadata gate stood down, and `reason` names it. The
 *   real recount would have declined here too, so this is not evidence of a bug.
 * - `stale` — the inputs moved while the count was being computed. Also not a bug:
 *   a newer recount is on its way with a better answer.
 *
 * One implementation, shared by chatStore and roomStore: the gate sequence is a
 * second traversal of each store's recount, and a second copy of it per store would
 * drift from its recount silently — a diagnostic that declines where the recount
 * counts reports ordinary catch-up as a bug. Each store supplies only its own
 * counters, through {@link UnreadDiagnosticConfig}.
 *
 * Declared here rather than in `core/types`: it names a `RecountDeferralReason`, and
 * `core/types` is the leaf layer that must not reach into a store —
 * `core/types/layering.test.ts` enforces it.
 *
 * @category Read state
 */
import type { RecountDeferralReason } from './recountDiagnostics'
import type { PointerOrder, ReadPointer } from '../../core/types/readState'
import { computeFloor, isAfterBoundary, pointerlessDefers } from './readState'
import { resolveCoverageBottom, type CoverageRecord } from './mamCoverage'
import { transientCounts, type ScopeKey } from './transientUnread'

export interface UnreadDiagnostic {
  status: 'exact' | 'deferred' | 'stale'
  /** Archive-derived, including the transient overlay. Present only on `exact`. */
  archiveCount?: number
  /** What the badge currently displays. Present only on `exact`. */
  badgeCount?: number
  /** Which gate stood down. Present only on `deferred`. */
  reason?: RecountDeferralReason
}

/**
 * The subset of an entity's metadata the diagnostic reads. `ConversationMetadata`
 * and `RoomMetadata` both satisfy it structurally.
 */
export interface UnreadDiagnosticMeta {
  readPointer?: ReadPointer
  historyFloor?: Date
  unreadCount: number
  pendingRemoteDisplayedStanzaId?: string
}

/**
 * One turn's worth of everything the verdict depends on, read by the store.
 *
 * `fingerprint` is the movement test: the module re-samples and compares it
 * element-wise with `Object.is` around every `await`, and any difference makes the
 * result `stale`. Which values belong in it is the STORE's decision, because the
 * store owns the counters — but it must contain every input the gates below read,
 * or the diagnostic can return an `exact` pair whose two numbers were never true at
 * the same instant. Its entries must be identity-stable: a getter that allocates a
 * fresh default on every call would make every result `stale`.
 */
export interface UnreadDiagnosticSnapshot {
  meta: UnreadDiagnosticMeta | undefined
  /** The MAM catch-up gate, already evaluated against this snapshot's query state. */
  historyCaughtUp: boolean
  coverage: CoverageRecord | undefined
  fingerprint: readonly unknown[]
}

export interface UnreadDiagnosticConfig {
  /** Selects the room flavour of coverage resolution and archive counting. */
  isRoom: boolean
  /** Samples the whole context in one synchronous turn. Must not write. */
  sample: (entityId: string) => UnreadDiagnosticSnapshot
  /** Whether a real recount is already running for this entity. */
  isRecountInFlight: (entityId: string) => boolean
  countUnreadInArchive: (
    entityId: string,
    range: { floor: Date; pointer: PointerOrder | undefined }
  ) => Promise<{ unread: number } | null>
  transientScopeKey: (entityId: string) => ScopeKey
}

/**
 * The archive-derived unread count beside the badge, for a diagnostic consumer.
 *
 * A SECOND traversal of the stores' `recomputeUnreadFor*` gates, deliberately, and
 * the two must be changed together — `unreadDiagnostic.test.ts` pins them to the
 * same verdicts. It cannot call a recount itself, because that prelude has three
 * side effects an observer must not have:
 *
 * - it bumps the latest-wins recount version, which would CANCEL a real recount in
 *   flight and make the observer a cause;
 * - it prunes the transient unread overlay;
 * - it invalidates a persisted coverage record whose bottom no longer resolves.
 *
 * It also never counts from the resident slice: that would recreate the very
 * under-count class a consumer would be comparing against, and go silent exactly
 * when the badge is wrong.
 *
 * Both counts come from one validated context: the badge is read last, and the
 * movement check runs after it, so an `exact` result holds two numbers that were
 * true at the same instant.
 */
export async function computeUnreadDiagnostic(
  config: UnreadDiagnosticConfig,
  entityId: string
): Promise<UnreadDiagnostic> {
  const start = config.sample(entityId)
  const meta = start.meta
  if (!meta) return { status: 'deferred', reason: 'no-meta' }
  if (meta.pendingRemoteDisplayedStanzaId !== undefined) {
    return { status: 'deferred', reason: 'pending-remote-displayed' }
  }
  if (pointerlessDefers(meta.readPointer, meta.unreadCount)) {
    return { status: 'deferred', reason: 'pointerless-defer' }
  }
  if (config.isRecountInFlight(entityId)) return { status: 'stale' }

  const floor = computeFloor(meta.readPointer, meta.historyFloor)
  if (!floor) return { status: 'deferred', reason: 'no-floor' }
  if (!start.historyCaughtUp) return { status: 'deferred', reason: 'history-not-caught-up' }

  const moved = (): boolean => !sameFingerprint(config.sample(entityId).fingerprint, start.fingerprint)

  const bottom = await resolveCoverageBottom(entityId, start.coverage, config.isRoom)
  if (moved()) return { status: 'stale' }
  if (bottom === 'missing') return { status: 'deferred', reason: 'coverage-missing' }
  // No `clearConversationCoverage` here, unlike the recount: an observer does not
  // repair state it is observing.
  if (bottom === 'unresolvable') return { status: 'deferred', reason: 'coverage-unresolvable' }

  const floorPos: PointerOrder = meta.readPointer?.order ?? { role: 'floor', timestamp: floor.getTime() }
  if (isAfterBoundary(bottom, floorPos)) {
    return { status: 'deferred', reason: 'coverage-short-of-floor' }
  }

  const res = await config.countUnreadInArchive(entityId, { floor, pointer: meta.readPointer?.order })
  if (moved()) return { status: 'stale' }
  if (res === null) return { status: 'deferred', reason: 'cache-unavailable' }

  // No `pruneTransient` either — read the overlay, do not edit it.
  const transient = transientCounts(config.transientScopeKey(entityId), floorPos)
  const archiveCount = Math.min(999, res.unread + transient.unread)

  const badgeCount = config.sample(entityId).meta?.unreadCount
  if (badgeCount === undefined) return { status: 'deferred', reason: 'no-meta' }
  // Last: everything above must still describe the same context as this badge.
  if (moved()) return { status: 'stale' }
  return { status: 'exact', archiveCount, badgeCount }
}

function sameFingerprint(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}
