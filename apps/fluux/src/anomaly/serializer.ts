/**
 * Record serialization and the privacy gate.
 *
 * The rule is PROVENANCE, not shape: a primitive string is rejected wherever a
 * record can carry caller data, regardless of what it contains. A body equal to
 * `focus`, or matching the token format, is rejected exactly like any other body,
 * because it did not come from `values.ts`.
 *
 * Provenance also carries a CATEGORY, checked per position. An invariant id may not
 * stand in for a ctx key, nor a tag for a counter name — otherwise every constant
 * would be interchangeable and the registries would mean nothing.
 *
 * Rejection is total: the record is dropped. It is never truncated to fit, because
 * a truncated body still discloses its prefix. A rejected record is a visible bug
 * in a detector; a truncated one is a silent leak.
 *
 * @module Anomaly/Serializer
 */
import { isKind, isRecordValue, type Kind, type Opaque } from './values'

const DEFAULT_MAX_LINE_BYTES = 8192
const MAX_ARRAY = 50

/** A value admissible in a record VALUE position. */
export type Scalar = Opaque | number | boolean | null

interface Envelope {
  v: 1
  t: string
  sid: string
  build: string
  tokenKeyId: string
}

export interface AnomalyRecord extends Envelope {
  kind: 'anomaly'
  /** An `ID` registry constant, never a free string. */
  id: Opaque
  sev: 'bug' | 'suspect' | 'drift'
  expected?: Scalar
  observed?: Scalar
  /** `[CTX constant, value]` pairs — keys are opaque too. */
  ctx: Array<[Opaque, Scalar]>
  crumbs: Scalar[][]
  trunc?: boolean
}

export interface DigestRecord extends Envelope {
  kind: 'digest'
  windowMs: number
  /** `[COUNTER or METRIC constant, value]` pairs. */
  counters: Array<[Opaque, number]>
  /** Keyed by INVARIANT ID — these count suppressed anomalies, not metrics. */
  suppressed: Array<[Opaque, number]>
}

export interface SerializeOptions {
  /**
   * Byte cap for one line. Overridable so the shed-and-reject path is reachable in
   * a test: with the closed registries, a digest cannot realistically approach the
   * production cap, and an untestable backstop is one nobody knows is broken.
   */
  maxLineBytes?: number
}

/** The position a value occupies, which decides the categories it may have. */
type Position = 'value' | Kind

let rejected = 0

/** Surfaced in the digest as `recorder/rejected-value`. */
export function rejectedValueCount(): number {
  return rejected
}

/** Test-only. */
export function resetSerializerCountersForTesting(): void {
  rejected = 0
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/**
 * Convert one constrained value, or throw to reject the whole record.
 *
 * Throwing rather than returning a sentinel is deliberate: every caller below is
 * inside the same `try`, so one bad value anywhere drops the record rather than
 * producing a partially-sanitised one.
 */
function unwrap(value: unknown, position: Position): string | number | boolean | null {
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    if (position !== 'value') throw new Error('scalar in a key position')
    return value
  }

  const ok = position === 'value' ? isRecordValue(value) : isKind(value, position)
  if (!ok) throw new Error('wrong provenance or category for this position')

  const s = (value as Opaque).s
  // A newline would forge a second JSONL record. The constructors cannot produce
  // one, so this is belt-and-braces rather than the primary defence.
  if (s.includes('\n') || s.includes('\r')) throw new Error('newline in an opaque value')
  return s
}

function pairsToObject(
  pairs: Array<[Opaque, Scalar | number]>,
  keyPosition: Position,
  valuePosition: Position,
): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {}
  for (const [key, value] of pairs) {
    out[String(unwrap(key, keyPosition))] = unwrap(value, valuePosition)
  }
  return out
}

/**
 * Serialize a record to one JSONL line.
 *
 * @returns the line without its trailing newline, or `null` when the record was
 * rejected — bad provenance, wrong category, or unable to fit the byte cap.
 */
export function serialize(
  record: AnomalyRecord | DigestRecord,
  options: SerializeOptions = {},
): string | null {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES

  try {
    if (record.kind === 'digest') {
      const line = JSON.stringify({
        ...record,
        counters: pairsToObject(record.counters, 'counter', 'value'),
        // `suppressed` is keyed by invariant id, not by counter name.
        suppressed: pairsToObject(record.suppressed, 'id', 'value'),
      })
      return byteLength(line) <= maxLineBytes ? line : null
    }

    const ctx = pairsToObject(record.ctx, 'ctx', 'value')
    const crumbs = record.crumbs
      .slice(-MAX_ARRAY)
      .map((crumb) => crumb.slice(0, MAX_ARRAY).map((v) => unwrap(v, 'value')))

    const out: Record<string, unknown> = {
      v: record.v,
      t: record.t,
      sid: record.sid,
      build: record.build,
      tokenKeyId: record.tokenKeyId,
      kind: record.kind,
      id: unwrap(record.id, 'id'),
      sev: record.sev,
      ctx,
      crumbs,
    }
    if (record.expected !== undefined) out.expected = unwrap(record.expected, 'value')
    if (record.observed !== undefined) out.observed = unwrap(record.observed, 'value')

    let line = JSON.stringify(out)
    if (byteLength(line) <= maxLineBytes) return line

    // Over cap. Shed WHOLE crumbs, oldest first, keeping the most recent — they sit
    // closest to the failure. Strings are never shortened; see the module comment.
    out.trunc = true
    let kept = crumbs.length
    while (kept > 0) {
      kept = Math.floor(kept / 2)
      out.crumbs = crumbs.slice(crumbs.length - kept)
      line = JSON.stringify(out)
      if (byteLength(line) <= maxLineBytes) return line
    }

    delete out.expected
    delete out.observed
    line = JSON.stringify(out)
    return byteLength(line) <= maxLineBytes ? line : null
  } catch {
    rejected++
    return null
  }
}
