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

/** The only admissible severities. Validated at runtime, not merely typed. */
const SEVERITIES: ReadonlySet<string> = new Set(['bug', 'suspect', 'drift'])

/**
 * Exact key sets per record kind.
 *
 * A record is rejected when it carries a key not listed here. The anomaly path
 * builds its output field by field and would silently drop an extra property, but
 * silence hides the detector bug that produced it, and a spread-based digest
 * path would emit such a property verbatim. One rule for both.
 */
const ANOMALY_KEYS: ReadonlySet<string> = new Set([
  'v', 't', 'sid', 'build', 'tokenKeyId', 'kind', 'id', 'sev', 'expected', 'observed', 'ctx',
  'crumbs', 'trunc',
])
const DIGEST_KEYS: ReadonlySet<string> = new Set([
  'v', 't', 'sid', 'build', 'tokenKeyId', 'kind', 'windowMs', 'counters', 'suppressed',
  'rates', 'env',
])

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
  /**
   * `[RATE constant, numerator, denominator, informational?]` tuples.
   *
   * Optional because a digest with no rates is a real state — an embedder that
   * wires no metrics produces one every window — and treating it as malformed
   * would drop the counters it does carry.
   */
  rates?: Array<[Opaque, number, number, boolean?]>
  /** `[ENV constant, value]` pairs describing the session, not one observation. */
  env?: Array<[Opaque, Scalar]>
}

export interface SerializeOptions {
  /**
   * Byte cap for one line. Overridable so the shed-and-reject path is reachable in
   * a test: with the closed registries, a digest cannot realistically approach the
   * production cap, and an untestable backstop is one nobody knows is broken.
   *
   * It can only ever LOWER the cap. A test hook that could raise or remove a
   * privacy-adjacent bound is a way to disable it in production by mistake, so a
   * non-finite, non-positive, or larger value falls back to the default.
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

/** Clamp the override so it can only tighten the bound, never loosen it. */
function resolveMaxLineBytes(requested: number | undefined): number {
  if (requested === undefined) return DEFAULT_MAX_LINE_BYTES
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_MAX_LINE_BYTES
  return Math.min(requested, DEFAULT_MAX_LINE_BYTES)
}

/** Reject a record carrying any key outside its kind's exact set. */
function assertNoUnknownKeys(record: object, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`unknown record property: ${key}`)
  }
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
    if (position !== 'value' || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('invalid scalar value')
    }
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

/**
 * Rate tuples to `{ rate: { n, d, informational? } }`.
 *
 * The denominator is kept ALONGSIDE the numerator rather than divided into it: it is
 * the sample count, and the review tool refuses a drift verdict without it. A
 * quotient emitted here would discard the one number that says whether the quotient
 * is worth believing.
 */
function ratesToObject(
  rates: Array<[Opaque, number, number, boolean?]>,
): Record<string, { n: number; d: number; informational?: true }> {
  if (rates.length > MAX_ARRAY) throw new Error('too many rates for one record')

  const out: Record<string, { n: number; d: number; informational?: true }> = {}
  for (const [key, numerator, denominator, informational] of rates) {
    if (informational !== undefined && typeof informational !== 'boolean') {
      throw new Error('invalid informational rate flag')
    }
    // Both positions are plain numbers, but they still go through `unwrap` so a
    // non-finite value is rejected here rather than becoming `null` in the file.
    const value: { n: number; d: number; informational?: true } = {
      n: unwrap(numerator, 'value') as number,
      d: unwrap(denominator, 'value') as number,
    }
    if (informational) value.informational = true
    out[String(unwrap(key, 'rate'))] = value
  }
  return out
}

function pairsToObject(
  pairs: Array<[Opaque, Scalar | number]>,
  keyPosition: Position,
  valuePosition: Position,
): Record<string, string | number | boolean | null> {
  // Bound the walk BEFORE it starts. Repeated keys collapse into a small object,
  // so the byte cap cannot catch a pathological pair list — and with the closed
  // registries there are only a handful of legal keys, so exceeding the limit can
  // only mean a detector bug worth surfacing.
  if (pairs.length > MAX_ARRAY) throw new Error('too many pairs for one record')

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
  const maxLineBytes = resolveMaxLineBytes(options.maxLineBytes)

  try {
    // The envelope's key id is the correlation boundary; an unattributable record
    // is not worth writing. Checked here so every path is covered, not only the
    // recorder's.
    if (!/^[0-9a-f]{8}$/.test(record.tokenKeyId)) throw new Error('invalid tokenKeyId')

    if (record.kind === 'digest') {
      assertNoUnknownKeys(record, DIGEST_KEYS)
      // `windowMs` is a plain number on the record, so its type is erased by any
      // cast — the same threat as `sev`. It reaches the line verbatim otherwise.
      if (!Number.isFinite(record.windowMs) || record.windowMs <= 0) {
        throw new Error('invalid windowMs')
      }
      // Built field by field, NEVER spread: a spread emits any unexpected property
      // verbatim, which is exactly how a body would reach the log.
      const line = JSON.stringify({
        v: record.v,
        t: record.t,
        sid: record.sid,
        build: record.build,
        tokenKeyId: record.tokenKeyId,
        kind: record.kind,
        windowMs: record.windowMs,
        counters: pairsToObject(record.counters, 'counter', 'value'),
        // `suppressed` is keyed by invariant id, not by counter name.
        suppressed: pairsToObject(record.suppressed, 'id', 'value'),
        rates: ratesToObject(record.rates ?? []),
        // Environment keys are minted as `ctx`, so they reuse the pair walk.
        env: pairsToObject(record.env ?? [], 'ctx', 'value'),
      })
      return byteLength(line) <= maxLineBytes ? line : null
    }

    assertNoUnknownKeys(record, ANOMALY_KEYS)
    // `sev` reaches the serializer straight from a detector, so its union type is
    // erased by any cast. Check it like any other untrusted value.
    if (!SEVERITIES.has(record.sev)) throw new Error('invalid severity')

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
