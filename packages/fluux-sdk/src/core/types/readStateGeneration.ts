/**
 * Which generation of read state a pointer belongs to.
 *
 * A read pointer is forward-only WITHIN one generation. Several ordinary
 * transitions replace it wholesale, and a consumer caching anything derived from
 * it — a badge, a divider, a diagnostic — needs to know precisely what to discard:
 *
 * - `store` moves on logout and on an account switch. Everything is new.
 * - `entity` moves when THAT conversation or room is deleted. Nothing else is
 *   affected, which is why this is not one global counter: a single number would
 *   make deleting one conversation look like a lifecycle change for every other,
 *   and a consumer would forgive a stale value it should have dropped.
 *
 * Both counters only ever move forward within their own scope, but `entity`
 * restarts at 0 when `store` moves, so the PAIR is the identity — never `entity`
 * alone.
 *
 * @category Read state
 */
export interface ReadStateGeneration {
  store: number
  entity: number
}
