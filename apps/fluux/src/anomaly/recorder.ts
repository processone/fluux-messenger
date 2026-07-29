/**
 * Breadcrumb ring, counters, and the two bounding mechanisms.
 *
 * The ring is bounded by construction; the RECORD STREAM is not, unless made so. A
 * repeatedly failing invariant would otherwise append without limit, each record
 * duplicating 50 crumbs. Hence a per-id cooldown — with the suppressed count
 * surfaced in the digest, so coalescing never hides frequency — and a session
 * ceiling that announces itself, because a silent stop would read as a healthy day.
 *
 * @module Anomaly/Recorder
 */
import { rejectedValueCount, serialize, type Scalar } from './serializer'
import type { Sink } from './sinks/sink'
import {
  COUNTER,
  ID,
  isReservedCounter,
  localRefOverflowCount,
  releaseOpaque,
  retainOpaque,
  tokenKeyId,
  tokenUnresolvedCount,
  type Opaque,
} from './values'

const RING_SIZE = 100
const CRUMBS_PER_RECORD = 50
const COOLDOWN_MS = 60_000
const MAX_RECORDS = 500
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

export interface RecordInput {
  /** An `ID` registry constant from values.ts. */
  id: Opaque
  sev: 'bug' | 'suspect' | 'drift'
  expected?: Scalar
  observed?: Scalar
  /** `[CTX constant, value]` pairs. */
  ctx?: Array<[Opaque, Scalar]>
}

export interface Recorder {
  crumb(parts: Scalar[]): void
  record(input: RecordInput): void
  /** `key` must be a METRIC constant; recorder-reserved names are refused. */
  count(key: Opaque, by?: number): void
  flushDigest(windowMs: number): void
  /** Stable for the process, so a StrictMode remount cannot fork the session. */
  sessionId(): string
}

export interface RecorderOptions {
  sink: Sink
  /** Injected for determinism in tests. */
  now: () => number
  build: string
  sid: string
  /**
   * Byte budget. A function, not a number, so a test can raise the limit and retry
   * on the SAME recorder instance — the only way to assert that a failed flush
   * preserved its window.
   */
  maxBytes?: () => number
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const { sink, now, build, sid } = opts
  const maxBytes = opts.maxBytes ?? (() => DEFAULT_MAX_BYTES)

  const ring: Scalar[][] = []
  /** Application counters, keyed by the constant's string so repeats accumulate. */
  const counters = new Map<string, [Opaque, number]>()
  const suppressed = new Map<string, [Opaque, number]>()
  const lastEmittedAt = new Map<string, number>()

  // Health counters are CUMULATIVE at their source, but each digest describes one
  // window. Reporting the totals would double-count every window after the first.
  const lastHealth = new Map<string, number>()

  const encoder = new TextEncoder()

  let recordsWritten = 0
  let bytesWritten = 0
  let ceilingAnnounced = false

  function atCeiling(): boolean {
    return recordsWritten >= MAX_RECORDS || bytesWritten >= maxBytes()
  }

  /**
   * The ONLY path to the sink, so the ceiling and the byte accounting cannot be
   * bypassed by adding a record kind later.
   *
   * The budget check is PROSPECTIVE: testing only what is already written lets the
   * last line cross the cap, so a 2 MB budget could end up writing 2 MB plus a
   * line. `encoder.encode().length` rather than `line.length`, which counts UTF-16
   * code units and would undercount any multi-byte character.
   */
  function emit(line: string, force = false): boolean {
    const size = encoder.encode(line).length
    if (!force && (recordsWritten + 1 > MAX_RECORDS || bytesWritten + size > maxBytes())) {
      return false
    }
    sink.write(line)
    recordsWritten++
    bytesWritten += size
    return true
  }

  function envelope() {
    return {
      v: 1 as const,
      t: new Date(now()).toISOString(),
      sid,
      build,
      tokenKeyId: tokenKeyId(),
    }
  }

  /** The record that explains the silence. Forced, since the ceiling is why it exists. */
  function announceCeiling(): void {
    if (ceilingAnnounced) return
    ceilingAnnounced = true
    const line = serialize({
      ...envelope(),
      kind: 'anomaly',
      id: ID.ceilingReached,
      sev: 'drift',
      ctx: [],
      crumbs: [],
    })
    if (line) emit(line, true)
  }

  return {
    crumb(parts: Scalar[]): void {
      // Pin every LocalRef this crumb carries, so a ref cannot be evicted and
      // reassigned while the ring can still surface it. A no-op for tags and entity
      // tokens. Without this the value layer's own tests pass while the SYSTEM
      // property — a ref stays stable as long as anything can refer to it — does
      // not exist.
      for (const part of parts) retainOpaque(part)

      ring.push(parts)

      if (ring.length > RING_SIZE) {
        const evicted = ring.shift()
        if (evicted) for (const part of evicted) releaseOpaque(part)
      }
    },

    record(input: RecordInput): void {
      if (atCeiling()) {
        announceCeiling()
        return
      }

      const idKey = input.id.s
      const last = lastEmittedAt.get(idKey)
      if (last !== undefined && now() - last < COOLDOWN_MS) {
        const [, n] = suppressed.get(idKey) ?? [input.id, 0]
        suppressed.set(idKey, [input.id, n + 1])
        return
      }

      const line = serialize({
        ...envelope(),
        kind: 'anomaly',
        id: input.id,
        sev: input.sev,
        ...(input.expected !== undefined ? { expected: input.expected } : {}),
        ...(input.observed !== undefined ? { observed: input.observed } : {}),
        ctx: input.ctx ?? [],
        crumbs: ring.slice(-CRUMBS_PER_RECORD),
      })

      // A rejected record is a detector bug, surfaced through the digest's
      // rejected-value counter rather than by writing something unsafe.
      if (!line) return

      // A prospective refusal means nothing was written, so `atCeiling()` would stay
      // false and the explanatory record would never appear.
      if (!emit(line)) {
        announceCeiling()
        return
      }

      // Only after a real write: otherwise a refused record would suppress its own
      // retry for the next minute.
      lastEmittedAt.set(idKey, now())
    },

    count(key: Opaque, by = 1): void {
      // The digest appends the recorder's own health counters under these names. An
      // application counter sharing one would be silently overwritten by the health
      // delta when the pairs are folded into an object — a wrong number rather than
      // a visible error.
      if (isReservedCounter(key.s)) {
        throw new Error(`${key.s} is reserved for recorder health; use a METRIC constant`)
      }
      const [, n] = counters.get(key.s) ?? [key, 0]
      counters.set(key.s, [key, n + by])
    },

    flushDigest(windowMs: number): void {
      if (atCeiling()) {
        announceCeiling()
        return
      }

      // Health totals are READ but not committed yet: if the digest fails to
      // serialize or does not fit, advancing the baselines here would lose the whole
      // window — the counters would be cleared and the next digest would report a
      // delta measured from a report that was never written.
      const health: Array<[Opaque, number]> = [
        [COUNTER.rejectedValue, rejectedValueCount()],
        [COUNTER.localRefOverflow, localRefOverflowCount()],
        [COUNTER.tokenUnresolved, tokenUnresolvedCount()],
        [COUNTER.sinkWriteFailed, sink.failureCount()],
      ]

      const all: Array<[Opaque, number]> = [...counters.values()]
      for (const [constant, total] of health) {
        all.push([constant, total - (lastHealth.get(constant.s) ?? 0)])
      }

      const base = {
        ...envelope(),
        kind: 'digest' as const,
        windowMs,
        suppressed: [...suppressed.values()],
      }

      // Shed WHOLE counter entries — smallest first, so the largest signals survive
      // — until the line fits. A digest that simply vanished would read as a quiet
      // window rather than a dropped one.
      let entries = [...all].sort((a, b) => b[1] - a[1])
      let line: string | null = null
      while (entries.length > 0) {
        line = serialize({ ...base, counters: entries })
        if (line) break
        entries = entries.slice(0, entries.length - 1)
      }
      if (!line) line = serialize({ ...base, counters: [] })

      const written = line ? emit(line) : false
      if (!written) {
        announceCeiling()
        return
      }

      // Commit the window ONLY on a successful write.
      for (const [constant, total] of health) lastHealth.set(constant.s, total)
      counters.clear()
      suppressed.clear()
    },

    sessionId: () => sid,
  }
}
