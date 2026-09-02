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
 * Declared beside `recountDiagnostics` rather than in `core/types`: it names a
 * `RecountDeferralReason`, and `core/types` is the leaf layer that must not reach
 * into a store — `core/types/layering.test.ts` enforces it.
 *
 * @category Read state
 */
import type { RecountDeferralReason } from './recountDiagnostics'

export interface UnreadDiagnostic {
  status: 'exact' | 'deferred' | 'stale'
  /** Archive-derived, including the transient overlay. Present only on `exact`. */
  archiveCount?: number
  /** What the badge currently displays. Present only on `exact`. */
  badgeCount?: number
  /** Which gate stood down. Present only on `deferred`. */
  reason?: RecountDeferralReason
}
