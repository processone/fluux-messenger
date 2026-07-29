/**
 * The value layer: everything that may legally appear inside an anomaly record.
 *
 * Privacy is enforced by PROVENANCE. A value is admissible because THIS MODULE
 * built it, not because it looks like something this module builds — a shape check
 * would accept a message body equal to `focus`, or one matching the token format.
 *
 * Everything lives in one file because ES modules have no friend visibility: any
 * minting function exported for a sibling module is equally callable by a detector.
 * The derivation helpers below are therefore module private, and only safe wrappers
 * are exported. There is NO exported path from caller data to an `Opaque`.
 *
 * @module Anomaly/Values
 */

// ---------------------------------------------------------------------------
// Opaque values
// ---------------------------------------------------------------------------

/**
 * Provenance carries a CATEGORY, not just membership.
 *
 * A single WeakSet would make every constant interchangeable: `TAG.focus` could be
 * used as an invariant id, a token as a ctx key, a local ref as a counter name.
 * That leaks nothing, but it dissolves the registries' meaning — so the serializer
 * must be able to ask "is this an id?", not merely "did we make this?".
 */
export type Kind = 'tag' | 'id' | 'ctx' | 'counter' | 'token' | 'ref'

const KIND = new WeakMap<object, Kind>()

export interface Opaque {
  readonly s: string
}

/** Module private. Never exported, directly or via a wrapper taking free text. */
function mint(s: string, kind: Kind): Opaque {
  const value = Object.freeze({ s })
  KIND.set(value, kind)
  return value
}

/** True only for a value this module constructed. Not structural. */
export function isOpaque(v: unknown): v is Opaque {
  return typeof v === 'object' && v !== null && KIND.has(v as object)
}

/** True only for a value this module constructed WITH one of `kinds`. */
export function isKind(v: unknown, ...kinds: Kind[]): v is Opaque {
  if (typeof v !== 'object' || v === null) return false
  const kind = KIND.get(v as object)
  return kind !== undefined && kinds.includes(kind)
}

/** The categories admissible as a record VALUE (as opposed to a key or an id). */
export const VALUE_KINDS: Kind[] = ['tag', 'token', 'ref']

// ---------------------------------------------------------------------------
// Closed registries
//
// ids, ctx keys and counter names are ALSO opaque constants, not validated
// strings. A regex such as /^[a-z][a-zA-Z0-9]{0,15}$/ accepts a short body like
// "hello", so form validation cannot close these positions; a closed set can.
//
// `ID` and docs/ANOMALY_INVARIANTS.md are two independent files, so their parity
// is NOT automatic — `values.test.ts` asserts it in both directions.
// ---------------------------------------------------------------------------

/** Breadcrumb and field tags. */
export const TAG = Object.freeze({
  focus: mint('focus', 'tag'),
  blur: mint('blur', 'tag'),
  msgIn: mint('msg:in', 'tag'),
  msgOut: mint('msg:out', 'tag'),
  ptrAdvance: mint('ptr:advance', 'tag'),
  activate: mint('activate', 'tag'),
  deactivate: mint('deactivate', 'tag'),
  scrollWrite: mint('scroll:write', 'tag'),
  mamQuery: mint('mam:query', 'tag'),
  mamResult: mint('mam:result', 'tag'),
  ahead: mint('ahead', 'tag'),
  behind: mint('behind', 'tag'),
})

/** Invariant ids. One entry per row in docs/ANOMALY_INVARIANTS.md. */
export const ID = Object.freeze({
  sessionStart: mint('recorder/session-start', 'id'),
  ceilingReached: mint('recorder/ceiling-reached', 'id'),
})

/** Permitted `ctx` keys. */
export const CTX = Object.freeze({
  conv: mint('conv', 'ctx'),
  room: mint('room', 'ctx'),
  route: mint('route', 'ctx'),
  msg: mint('msg', 'ctx'),
  query: mint('query', 'ctx'),
})

/**
 * Counter names reserved for the recorder's own health. `count()` refuses these:
 * the digest appends them itself, and an application counter sharing a key would
 * be silently overwritten by the health delta when the pairs are folded into an
 * object.
 */
export const COUNTER = Object.freeze({
  rejectedValue: mint('recorder/rejected-value', 'counter'),
  localRefOverflow: mint('recorder/localref-overflow', 'counter'),
  tokenUnresolved: mint('recorder/token-unresolved', 'counter'),
  sinkWriteFailed: mint('recorder/sink-write-failed', 'counter'),
})

/** Counter names available to application code and detectors. */
export const METRIC = Object.freeze({
  mamQueries: mint('mam.queries', 'counter'),
  mamRowsRetained: mint('mam.rowsRetained', 'counter'),
  roomJoins: mint('room.joins', 'counter'),
  scrollWrites: mint('scroll.writes', 'counter'),
  probe: mint('probe.metric', 'counter'),
})

/** The reserved set, enforced by the recorder's `count()`. */
export const RESERVED_COUNTERS: ReadonlySet<string> = new Set(
  Object.values(COUNTER).map((c) => c.s),
)

// ---------------------------------------------------------------------------
// Entity tokens — cross-session identity for JIDs, rooms, devices
// ---------------------------------------------------------------------------

export type TokenNs = 'jid' | 'room' | 'device'
const TOKEN_NS: ReadonlySet<string> = new Set(['jid', 'room', 'device'])

const KEY_STORAGE = 'fluux:anomaly-token-key'
const TOKEN_CACHE_LIMIT = 500
const UNRESOLVED = mint('c:unresolved', 'token')

const tokens = new Map<string, Opaque>()
let hmacKey: CryptoKey | null = null
let keyId = 'unknown'
let unresolved = 0

function nsKey(ns: string, value: string): string {
  return `${ns}\u0000${value}` // U+0000: cannot occur in a JID or a stanza id
}

function toHex(buffer: ArrayBuffer, bytes: number): string {
  return Array.from(new Uint8Array(buffer).slice(0, bytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function loadOrCreateKeyBytes(): Uint8Array {
  try {
    const stored = localStorage.getItem(KEY_STORAGE)
    if (stored) {
      const bytes = Uint8Array.from(atob(stored), (c) => c.charCodeAt(0))
      if (bytes.length === 32) return bytes
    }
  } catch {
    // Fall through: a lost key only restarts token identity, which tokenKeyId marks.
  }
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  try {
    localStorage.setItem(KEY_STORAGE, btoa(String.fromCharCode(...bytes)))
  } catch {
    // Non-persistent key: tokens stay valid for this session only.
  }
  return bytes
}

/** Load or mint the per-install key. Await before the first record. */
export async function initTokenizer(): Promise<void> {
  const bytes = loadOrCreateKeyBytes()
  hmacKey = await crypto.subtle.importKey(
    'raw',
    bytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  // A one-way digest of the key: discloses nothing, but changes when the key does,
  // which is what lets a review refuse to correlate across two token spaces.
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as BufferSource)
  keyId = toHex(digest, 4)
}

/**
 * Compute and cache an entity token ahead of any breadcrumb using it.
 *
 * Safe despite taking caller text: the output is an HMAC digest under a key the
 * caller does not hold, so it cannot echo the input. That is the ONLY reason a
 * dynamic constructor is acceptable here — contrast the registries above.
 */
export async function warmToken(ns: TokenNs, value: string): Promise<void> {
  if (!hmacKey || !TOKEN_NS.has(ns) || typeof value !== 'string') return
  const key = nsKey(ns, value)
  if (tokens.has(key)) return

  const signature = await crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(key) as unknown as BufferSource,
  )
  if (tokens.size >= TOKEN_CACHE_LIMIT) {
    const oldest = tokens.keys().next()
    if (!oldest.done) tokens.delete(oldest.value)
  }
  tokens.set(key, mint(`c:${toHex(signature, 8)}`, 'token'))
}

/** Synchronous lookup. A miss returns the sentinel — never the raw value. */
export function tokenSync(ns: TokenNs, value: string): Opaque {
  if (!TOKEN_NS.has(ns)) throw new TypeError('unknown token namespace')
  const hit = tokens.get(nsKey(ns, value))
  if (hit) return hit
  unresolved++
  void warmToken(ns, value)
  return UNRESOLVED
}

/** Non-secret; goes in every record envelope. */
export function tokenKeyId(): string {
  return keyId
}

export function tokenUnresolvedCount(): number {
  return unresolved
}

// ---------------------------------------------------------------------------
// Local refs — session-local identity for ephemeral ids
// ---------------------------------------------------------------------------

/** m = message, q = MAM query, x = stanza. */
export type LocalNs = 'm' | 'q' | 'x'
const LOCAL_NS: ReadonlySet<string> = new Set(['m', 'q', 'x'])

const REF_CAP = 2000

interface RefEntry {
  ref: Opaque
  /** Ref-counted: one ref can be held by several crumbs AND an open request. */
  count: number
  seq: number
}

const refs = new Map<string, RefEntry>()
const keyByRef = new WeakMap<Opaque, string>()
let nextSeq = 0
let overflow = 0

function makeRoom(): boolean {
  if (refs.size < REF_CAP) return true
  let oldest: { key: string; seq: number } | null = null
  for (const [key, entry] of refs) {
    if (entry.count > 0) continue
    if (!oldest || entry.seq < oldest.seq) oldest = { key, seq: entry.seq }
  }
  if (!oldest) return false
  refs.delete(oldest.key)
  return true
}

/**
 * Get or assign the ref for `value` in `ns`.
 *
 * The namespace is validated at RUNTIME, not merely by its type: `localRef(body,
 * 'x')` behind a cast would otherwise render as `s:<body>1` and re-emit the body.
 *
 * @returns the ref, or `null` when the map is full and everything is pinned. The
 * caller must then omit the crumb — growing without limit, or reassigning a live
 * ref, are both worse than losing one breadcrumb.
 */
export function localRef(ns: LocalNs, value: string): Opaque | null {
  if (!LOCAL_NS.has(ns)) throw new TypeError('unknown local-ref namespace')
  const key = nsKey(ns, value)
  const existing = refs.get(key)
  if (existing) return existing.ref

  if (!makeRoom()) {
    overflow++
    return null
  }
  const seq = ++nextSeq
  const ref = mint(`s:${ns}${seq}`, 'ref')
  refs.set(key, { ref, count: 0, seq })
  keyByRef.set(ref, key)
  return ref
}

export function retainRef(ns: LocalNs, value: string): void {
  const entry = refs.get(nsKey(ns, value))
  if (entry) entry.count++
}

export function releaseRef(ns: LocalNs, value: string): void {
  const entry = refs.get(nsKey(ns, value))
  if (entry && entry.count > 0) entry.count--
}

function holdFor(value: unknown): RefEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const key = keyByRef.get(value as Opaque)
  return key ? refs.get(key) : undefined
}

/** Pin by value, for holders that only have the `Opaque` — the breadcrumb ring. */
export function retainOpaque(value: unknown): void {
  const entry = holdFor(value)
  if (entry) entry.count++
}

export function releaseOpaque(value: unknown): void {
  const entry = holdFor(value)
  if (entry && entry.count > 0) entry.count--
}

export function localRefOverflowCount(): number {
  return overflow
}

/** Test-only: drop all derived state so a suite starts from a known baseline. */
export function resetValuesForTesting(): void {
  tokens.clear()
  refs.clear()
  hmacKey = null
  keyId = 'unknown'
  unresolved = 0
  nextSeq = 0
  overflow = 0
}
