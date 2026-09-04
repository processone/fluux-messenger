/**
 * Session totals for the unread recount's deferrals, for the XMPP console export.
 *
 * The SDK publishes one verdict per recount and keeps no running total, because two
 * consumers want two different aggregations of the same fact: the anomaly digest
 * counts per five-minute window, and the console export wants the whole session so a
 * user who hits a stale badge can open the console afterwards and still have the
 * evidence. Deciding which to keep is consumer policy, which is why the SDK reports
 * the occurrence and the total lives here.
 *
 * Keyed `<kind>:<reason>`, the shape the export renders. Reasons only — never an
 * entity id, a message id or an unread total — so the export carries no identity it
 * did not already carry.
 *
 * Started from `main.tsx` before React renders, so a deferral during startup catch-up
 * is counted. Unlike the anomaly runtime this is not Dev-gated: the console export
 * ships, and attributing a stale badge (#1211) is what it is for.
 *
 * @module Utils/RecountDeferralTally
 */
import { subscribeDiagnostics } from '@fluux/sdk'

const tallies = new Map<string, number>()
let unsubscribe: (() => void) | null = null

/** Begin counting. Idempotent: a second call keeps the first subscription. */
export function startRecountDeferralTally(): void {
  if (unsubscribe) return
  unsubscribe = subscribeDiagnostics(
    (event) => {
      if (event.kind !== 'unread-recount' || event.verdict.status !== 'deferred') return
      const key = `${event.entityKind}:${event.verdict.reason}`
      tallies.set(key, (tallies.get(key) ?? 0) + 1)
    },
    { kinds: ['unread-recount'] },
  )
}

/**
 * The session's totals so far.
 *
 * A copy, so a reader cannot mutate the source — the export renders these and must
 * never be able to change what a later export reports.
 */
export function readRecountDeferrals(): Record<string, number> {
  return Object.fromEntries(tallies)
}

/** Test-only. */
export function resetRecountDeferralTallyForTesting(): void {
  tallies.clear()
  unsubscribe?.()
  unsubscribe = null
}
