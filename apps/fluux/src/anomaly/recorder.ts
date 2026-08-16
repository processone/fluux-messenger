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
  isKind,
  isRecordValue,
  isReservedCounter,
  isTokenizerReady,
  localRefOverflowCount,
  releaseOpaque,
  retainOpaque,
  tokenKeyId,
  tokenUnresolvedCount,
  tokenWarmFailureCount,
  type Opaque,
} from './values'

const RING_SIZE = 100
const CRUMBS_PER_RECORD = 50
const COOLDOWN_MS = 60_000
const MAX_RECORDS = 500
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
/** Widest crumb the ring will hold, matching the serializer's per-crumb cap. */
const MAX_CRUMB_WIDTH = 50
/** The sink terminates every line, so the file costs one byte more per record. */
const NEWLINE_BYTES = 1

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
   * Byte budget, read on every write.
   *
   * A function rather than a number so a test can TIGHTEN the budget partway
   * through a session and drive the recorder to its limit without writing megabytes
   * of records first. It cannot loosen one: the value is clamped to the default on
   * every read, and a budget refusal is terminal, so raising the limit afterwards
   * would not revive the recorder anyway.
   */
  maxBytes?: () => number
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const { sink, now, build, sid } = opts

  // Clamp on every read: the seam exists so a test can TIGHTEN the budget, and one
  // that could relax it is a way to disable the bound in production by mistake.
  const requested = opts.maxBytes
  const maxBytes = (): number => {
    if (!requested) return DEFAULT_MAX_BYTES
    const value = requested()
    if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_BYTES
    return Math.min(value, DEFAULT_MAX_BYTES)
  }

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
  /** Writes refused because the tokenizer had no key yet. Reported once it does. */
  let droppedNotReady = 0
  /**
   * Set once the budget has genuinely refused a write. Announcing alone was not
   * enough: a single line too large for the remaining budget produced a
   * `ceiling-reached` record while the recorder cheerfully kept writing, so the log
   * claimed it had stopped and had not.
   */
  let terminal = false

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
    // Count the newline the sink appends, or the file grows past the budget by one
    // byte per record.
    const size = encoder.encode(line).length + NEWLINE_BYTES
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
    if (terminal) return
    terminal = true
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
      if (terminal) return

      // COPY, bounded. Keeping the caller's array would let a later mutation
      // rewrite the ring retroactively, and a mutation that removed a LocalRef
      // would leave it pinned forever, since eviction releases whatever the array
      // holds THEN rather than what was retained.
      const crumb = parts.slice(0, MAX_CRUMB_WIDTH)

      // Validate before pinning: an inadmissible entry would sit in the ring and
      // poison every record that attached it, long after the call that added it.
      for (const part of crumb) {
        const admissible =
          typeof part === 'number' || typeof part === 'boolean' || part === null
            ? true
            : isRecordValue(part)
        if (!admissible) return
      }

      for (const part of crumb) retainOpaque(part)

      ring.push(crumb)

      if (ring.length > RING_SIZE) {
        const evicted = ring.shift()
        if (evicted) for (const part of evicted) releaseOpaque(part)
      }
    },

    record(input: RecordInput): void {
      if (terminal) return

      // Before the tokenizer holds a key every record would carry
      // `tokenKeyId: "unknown"`, so the record cannot be written. Validate the
      // payload anyway before filing the drop: otherwise a detector bug arriving
      // during startup is indistinguishable from a well-formed record that was
      // merely early. The placeholder key id exists only to let the real validator
      // run — this line is discarded either way.
      if (!isTokenizerReady()) {
        const probe = serialize({
          ...envelope(),
          tokenKeyId: '00000000',
          kind: 'anomaly',
          id: input.id,
          sev: input.sev,
          ...(input.expected !== undefined ? { expected: input.expected } : {}),
          ...(input.observed !== undefined ? { observed: input.observed } : {}),
          ctx: input.ctx ?? [],
          crumbs: [],
        })
        // A null probe already counted itself as a rejected value.
        if (probe) droppedNotReady++
        return
      }

      if (atCeiling()) {
        announceCeiling()
        return
      }

      // Serialize BEFORE touching the cooldown. Checking the cooldown first let a
      // repeat carrying a raw body be counted as a suppression rather than a
      // rejection, and — worse — let a forged id whose `.s` matches a real one be
      // stored as a suppressed key, which then failed to serialize and took the
      // whole digest down with it.
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

      const idKey = input.id.s
      const last = lastEmittedAt.get(idKey)
      if (last !== undefined && now() - last < COOLDOWN_MS) {
        const [, n] = suppressed.get(idKey) ?? [input.id, 0]
        suppressed.set(idKey, [input.id, n + 1])
        return
      }

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
      // Provenance first: a non-counter constant would be accepted here, then
      // rejected at serialization time and shed by the digest's fit loop —
      // disappearing silently rather than surfacing the detector bug.
      if (!isKind(key, 'counter')) {
        throw new Error('count() requires a METRIC constant')
      }
      if (isReservedCounter(key.s)) {
        throw new Error(`${key.s} is reserved for recorder health; use a METRIC constant`)
      }
      if (!Number.isFinite(by)) {
        throw new Error('count() requires a finite increment')
      }
      const [, n] = counters.get(key.s) ?? [key, 0]
      counters.set(key.s, [key, n + by])
    },

    flushDigest(windowMs: number): void {
      if (terminal) return
      if (!isTokenizerReady()) {
        droppedNotReady++
        return
      }

      // Validate the window BEFORE the shedding loop below. That loop retries
      // serialization once per shed entry, so a input that fails for a reason
      // shedding cannot fix would be re-attempted several times and inflate
      // `rejected-value` — turning the recorder's own retry into what reads like
      // several detector bugs.
      if (!Number.isFinite(windowMs) || windowMs <= 0) return

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
        [COUNTER.tokenWarmFailed, tokenWarmFailureCount()],
        [COUNTER.sinkWriteFailed, sink.failureCount()],
        [COUNTER.droppedNotReady, droppedNotReady],
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

      // A digest that could not be SERIALIZED is a malformed digest, not a budget
      // event — announcing the ceiling here would claim the recorder had stopped
      // when nothing was exhausted. The window is preserved either way.
      if (!line) return

      if (!emit(line)) {
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
