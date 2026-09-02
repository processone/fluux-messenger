/**
 * The two invariants observable from the outbound application stanza seam.
 *
 * `redundant-query` says a query already answered was asked again inside a window;
 * `iq-unanswered` says a request was never answered at all. Both are pure and
 * clock-injected: `install.ts` supplies the stanzas, the clock and the sink.
 *
 * @module Anomaly/Detectors/XmppTraffic
 */
import type { RecordInput } from '../recorder'
import { CTX, ID, queryKindTag, type Opaque } from '../values'
import type { InFacts, OutFacts } from './stanzaFacts'

const REDUNDANT_WINDOW_MS = 60_000
const UNANSWERED_MS = 30_000
const MAX_SWEEP_STEP_MS = 1_000
/**
 * How many requests and answered keys are remembered.
 *
 * A detector that grows without bound is a leak shipped as a diagnostic. Evicting
 * the oldest entry loses a record; keeping everything loses the session.
 */
const MAX_TRACKED = 200

export interface TrafficDetector {
  observeOut(facts: OutFacts, now: number): void
  observeIn(facts: InFacts, now: number): void
  /** Report requests that have now been pending too long. */
  sweep(now: number): void
  /** Forget everything: a connection boundary makes every pending request moot. */
  reset(): void
}

export interface TrafficOptions {
  record: (input: RecordInput) => void
  /** Tokenizes a JID at the recorder boundary. Never the raw value. */
  token: (jid: string) => Opaque
  redundantWindowMs?: number
  unansweredMs?: number
  maxSweepStepMs?: number
  maxTracked?: number
}

interface Pending {
  facts: OutFacts
  at: number
  observedAge: number
}

function evictOldest<K, V>(
  map: Map<K, V>,
  limit: number,
  onEvict?: (value: V) => void
): void {
  while (map.size > limit) {
    const oldest = map.keys().next()
    if (oldest.done) return
    const value = map.get(oldest.value)
    map.delete(oldest.value)
    if (value !== undefined) onEvict?.(value)
  }
}

export function createTrafficDetector(opts: TrafficOptions): TrafficDetector {
  const redundantWindowMs = opts.redundantWindowMs ?? REDUNDANT_WINDOW_MS
  const unansweredMs = opts.unansweredMs ?? UNANSWERED_MS
  const maxSweepStepMs = opts.maxSweepStepMs ?? MAX_SWEEP_STEP_MS
  const maxTracked = opts.maxTracked ?? MAX_TRACKED

  /** Requests still waiting for a reply, keyed by stanza id. */
  const pending = new Map<string, Pending>()
  /** When each dedupable query episode was first answered, and how many were sent. */
  const answered = new Map<string, { at: number; sent: number }>()
  let lastObservedAt: number | null = null

  const advanceObservedAges = (now: number): void => {
    const sinceObservation = lastObservedAt === null ? 0 : now - lastObservedAt
    lastObservedAt = now
    const observedStep = Number.isFinite(sinceObservation)
      ? Math.max(0, Math.min(sinceObservation, maxSweepStepMs))
      : 0
    for (const request of pending.values()) {
      const sinceRequest = Math.max(0, now - request.at)
      request.observedAge += Math.min(observedStep, sinceRequest)
    }
  }

  const recordUnanswered = (id: string, request: Pending): void => {
    pending.delete(id)
    if (request.facts.dedupe) answered.delete(request.facts.dedupe)
    opts.record({
      id: ID.iqUnanswered,
      sev: 'bug',
      expected: unansweredMs,
      observed: request.observedAge,
      ctx: [
        [CTX.query, queryKindTag(request.facts.kind)],
        [CTX.target, opts.token(request.facts.to)],
      ],
    })
  }

  return {
    observeOut(facts, now) {
      if (pending.size === 0) lastObservedAt = now
      pending.set(facts.id, { facts, at: now, observedAge: 0 })
      evictOldest(pending, maxTracked, (request) => {
        if (request.facts.dedupe) answered.delete(request.facts.dedupe)
      })

      if (!facts.dedupe) return
      const previous = answered.get(facts.dedupe)
      if (!previous) return
      const elapsed = now - previous.at
      if (elapsed > redundantWindowMs) {
        // Out of the window: this query starts a new episode rather than extending
        // one, and it will re-arm when its own reply arrives.
        answered.delete(facts.dedupe)
        return
      }
      previous.sent++
      opts.record({
        id: ID.redundantQuery,
        sev: 'suspect',
        expected: 1,
        observed: previous.sent,
        ctx: [
          [CTX.query, queryKindTag(facts.kind)],
          [CTX.target, opts.token(facts.to)],
          [CTX.elapsedMs, elapsed],
        ],
      })
    },

    observeIn(facts, now) {
      const request = pending.get(facts.id)
      if (!request) return
      advanceObservedAges(now)
      if (request.observedAge >= unansweredMs) {
        recordUnanswered(facts.id, request)
        return
      }
      pending.delete(facts.id)
      // Only a RESULT establishes that the answer is now known. An error leaves the
      // caller with nothing cached, so its retry is not a redundancy.
      if (facts.type !== 'result') {
        if (request.facts.dedupe) answered.delete(request.facts.dedupe)
        return
      }
      if (!request.facts.dedupe) return
      if (!answered.has(request.facts.dedupe)) {
        answered.set(request.facts.dedupe, { at: now, sent: 1 })
      }
      evictOldest(answered, maxTracked)
    },

    sweep(now) {
      advanceObservedAges(now)
      for (const [id, request] of pending) {
        if (request.observedAge < unansweredMs) continue
        recordUnanswered(id, request)
      }
    },

    reset() {
      pending.clear()
      answered.clear()
      lastObservedAt = null
    },
  }
}
