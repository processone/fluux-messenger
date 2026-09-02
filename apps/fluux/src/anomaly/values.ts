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
import type { QueryKind } from './detectors/stanzaFacts'

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
export type Kind = 'tag' | 'id' | 'ctx' | 'counter' | 'token' | 'ref' | 'rate'

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

/**
 * The categories admissible as a record VALUE (as opposed to a key or an id).
 *
 * Deliberately NOT exported. An exported array is mutable whatever its declared
 * type — a caller could `VALUE_KINDS.push('id')` and make every invariant id
 * admissible as a value. Freezing the array would stop that one case but not the
 * pattern; keeping the policy private and exporting a predicate does.
 */
const VALUE_KINDS: readonly Kind[] = Object.freeze(['tag', 'token', 'ref'] as const)

/** True for a value admissible in a record VALUE position. */
export function isRecordValue(v: unknown): v is Opaque {
  return isKind(v, ...VALUE_KINDS)
}

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
  // The message list's re-assert loop kinds. Closed constants rather than the
  // caller's label string: the label is code-controlled today, but an unmapped
  // free string reaching a record is exactly the hole the registries close.
  loopPinBottom: mint('loop:pin-bottom', 'tag'),
  loopMediaAnchor: mint('loop:media-anchor', 'tag'),
  loopDividerAnchor: mint('loop:divider-anchor', 'tag'),
  loopInsertionAnchor: mint('loop:insertion-anchor', 'tag'),
  loopPrepend: mint('loop:prepend', 'tag'),
  loopRestoreAnchor: mint('loop:restore-anchor', 'tag'),
  loopMarker: mint('loop:marker', 'tag'),
  loopTarget: mint('loop:target', 'tag'),
  loopResidentTop: mint('loop:resident-top', 'tag'),
  // Environment values. Closed constants rather than the strings the platform and
  // the user-agent hand over: a UA string is free text of exactly the kind the
  // registries exist to keep out of a record, and its precision buys nothing a
  // comparison needs.
  platformMacos: mint('macos', 'tag'),
  platformLinux: mint('linux', 'tag'),
  platformWindows: mint('windows', 'tag'),
  platformWeb: mint('web', 'tag'),
  engineWebkit: mint('webkit', 'tag'),
  engineBlink: mint('blink', 'tag'),
  engineGecko: mint('gecko', 'tag'),
  engineUnknown: mint('engine-unknown', 'tag'),
  sizeSm: mint('sm', 'tag'),
  sizeMd: mint('md', 'tag'),
  sizeLg: mint('lg', 'tag'),
  sizeXl: mint('xl', 'tag'),
  // Store operations timed by the SDK. The name arrives as a string on a
  // performance entry, and this is where it becomes a constant.
  perfPersist: mint('perf:persist', 'tag'),
  perfMergeArchive: mint('perf:merge-archive', 'tag'),
  // Outbound query kinds. A payload namespace is free text of exactly the sort the
  // registries keep out of a record, so it becomes a constant here.
  qDiscoInfo: mint('q:disco-info', 'tag'),
  qDiscoItems: mint('q:disco-items', 'tag'),
  qVcard: mint('q:vcard', 'tag'),
  qAvatar: mint('q:avatar', 'tag'),
  qMam: mint('q:mam', 'tag'),
  qRoster: mint('q:roster', 'tag'),
  qOther: mint('q:other', 'tag'),
})

/**
 * The TAG for a query kind.
 *
 * Total over the union rather than a lookup that can miss: an unmapped kind would
 * reach a record as `undefined`, and the serializer would drop the whole record
 * rather than the one field.
 */
export function queryKindTag(kind: QueryKind): Opaque {
  switch (kind) {
    case 'disco-info':
      return TAG.qDiscoInfo
    case 'disco-items':
      return TAG.qDiscoItems
    case 'vcard':
      return TAG.qVcard
    case 'avatar':
      return TAG.qAvatar
    case 'mam':
      return TAG.qMam
    case 'roster':
      return TAG.qRoster
    case 'other':
      return TAG.qOther
  }
}

/** Invariant ids. One entry per row in docs/ANOMALY_INVARIANTS.md. */
export const ID = Object.freeze({
  sessionStart: mint('recorder/session-start', 'id'),
  ceilingReached: mint('recorder/ceiling-reached', 'id'),
  entityWarmFailing: mint('recorder/entity-warm-failing', 'id'),
  reassertOverlap: mint('scroll/reassert-overlap', 'id'),
  reassertNonConverging: mint('scroll/reassert-nonconverging', 'id'),
  resizeLoop: mint('scroll/resize-loop', 'id'),
  slowCorrection: mint('scroll/slow-correction', 'id'),
  mainThreadStall: mint('perf/main-thread-stall', 'id'),
  unreadSurvivesFocus: mint('read-state/unread-survives-focus', 'id'),
  unreadPersists: mint('read-state/unread-persists', 'id'),
  unreadFocusCleared: mint('read-state/unread-focus-cleared', 'id'),
  fabAtLiveEdge: mint('scroll/fab-at-live-edge', 'id'),
  jumpTargetMiss: mint('scroll/jump-target-miss', 'id'),
  redundantQuery: mint('xmpp-traffic/redundant-query', 'id'),
  iqUnanswered: mint('xmpp-traffic/iq-unanswered', 'id'),
  mamWriteFailed: mint('xmpp-traffic/mam-write-failed', 'id'),
  pointerRegression: mint('read-state/pointer-regression', 'id'),
})

/** Permitted `ctx` keys. */
export const CTX = Object.freeze({
  conv: mint('conv', 'ctx'),
  room: mint('room', 'ctx'),
  route: mint('route', 'ctx'),
  msg: mint('msg', 'ctx'),
  query: mint('query', 'ctx'),
  /** Which re-assert loop kind — a TAG constant, never the raw label. */
  loop: mint('loop', 'ctx'),
  /** Rendered message rows at the time of the observation. */
  rows: mint('rows', 'ctx'),
  /** Measured window length, where a count alone would not be interpretable. */
  elapsedMs: mint('elapsedMs', 'ctx'),
  /** Independently measured distance from the content bottom, in px. */
  distFromBottom: mint('distFromBottom', 'ctx'),
  /** How long a condition had held continuously when it was reported. */
  heldMs: mint('heldMs', 'ctx'),
  /** The worst unread count reached during an episode. */
  peak: mint('peak', 'ctx'),
  /** Signed px by which a jump target sat outside the viewport. */
  offBy: mint('offBy', 'ctx'),
  /** The queried entity, as an entity token — never the JID. */
  target: mint('target', 'ctx'),
  /** Rows delivered to this archive merge. */
  returned: mint('returned', 'ctx'),
  /** How far back a read pointer moved, in milliseconds. */
  behindMs: mint('behindMs', 'ctx'),
})

/**
 * Keys for the digest's environment block.
 *
 * Separate from `CTX` because these describe the SESSION rather than one
 * observation, and mixing them would let an environment key be used as an anomaly's
 * context. They are minted as `ctx` so the digest can reuse the existing pair
 * serialization rather than growing a second key category the serializer must learn.
 */
export const ENV = Object.freeze({
  /** A platform TAG. */
  platform: mint('platform', 'ctx'),
  /** A WebView engine TAG. */
  engine: mint('engine', 'ctx'),
  /** Engine major version, as a number — enough to separate two series. */
  engineVersion: mint('engineVersion', 'ctx'),
  /** A window size-class TAG, never raw geometry. */
  sizeClass: mint('sizeClass', 'ctx'),
  /** How many accounts the session holds. */
  accounts: mint('accounts', 'ctx'),
  /** Fraction of the window the document was visible, 0..1. */
  foreground: mint('foreground', 'ctx'),
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
  tokenWarmFailed: mint('recorder/token-warm-failed', 'counter'),
  sinkWriteFailed: mint('recorder/sink-write-failed', 'counter'),
  droppedNotReady: mint('recorder/dropped-not-ready', 'counter'),
})

/** Counter names available to application code and detectors. */
export const METRIC = Object.freeze({
  mamQueries: mint('mam.queries', 'counter'),
  mamRowsRetained: mint('mam.rowsRetained', 'counter'),
  mamRowsReturned: mint('mam.rowsReturned', 'counter'),
  roomJoins: mint('room.joins', 'counter'),
  scrollWrites: mint('scroll.writes', 'counter'),
  probe: mint('probe.metric', 'counter'),
  // Numerators and denominators for the rates below. A denominator is an ordinary
  // counter: it is a real quantity in its own right, and keeping it one means the
  // raw number survives even when its rate is shed.
  renderMessageList: mint('render.MessageList', 'counter'),
  messageArrivals: mint('message.arrivals.conversation', 'counter'),
  roomMessageArrivals: mint('message.arrivals.room', 'counter'),
  roomSwitches: mint('room.switches', 'counter'),
  scrollPositioningOps: mint('scroll.positioningOps', 'counter'),
})

/** A numerator and the denominator that makes it comparable across sessions. */
export interface RateSpec {
  readonly id: Opaque
  readonly numerator: Opaque
  readonly denominator: Opaque
  readonly informational?: boolean
}

/**
 * Drift is judged on RATES, never on raw counters.
 *
 * `render.MessageList: 1840` compared against a committed number mostly measures how
 * much the app was used that day: a quiet day and a fixed regression look the same,
 * and so do a busy day and a new one. Dividing by something that scales with use is
 * what makes the two distinguishable.
 *
 * The pairing lives HERE rather than in the review tool so that the log carries its
 * own meaning. A skill holding the pairings would have to be kept in step with this
 * file by hand, and a mismatch would silently compare the wrong two numbers.
 *
 * The archive-merge seam now supplies `mam.rowsRetained/rowsReturned` from one
 * report. The pairing remains informational until the build-stamp question below
 * is settled. `idb.writes` and `mam.queries` still have no sound normalized pairing.
 *
 * MessageList renders have several causes: arrivals, typing, presence, read-state,
 * scroll and resize. Conversation and room arrival signals now exist, while renders
 * per switch remains informational. Whether a future renders-per-arrival rate is
 * judgeable is a separate decision.
 *
 * The reassert-loop monitor's `wrote` flag mixes "a scroll call was issued" with
 * "geometry moved". A redundant write landing at the same offset therefore reads as
 * no write, so scroll writes per positioning is informational too. It becomes
 * judgeable once the frame loop carries write-issued and movement as separate
 * signals. The counters remain useful raw evidence and inputs for that later rate.
 *
 * Build stamps contain the app version and short HEAD, so dirty rebuilds from the
 * same HEAD share a review series. Before making any rate judgeable, choose
 * either a content-derived fingerprint or a clean-tree requirement. Current
 * informational rates issue no per-build verdicts, so the shared series cannot
 * dilute a verdict today.
 */
export const RATE: Readonly<Record<string, RateSpec>> = Object.freeze({
  renderPerRoomSwitch: Object.freeze({
    id: mint('render.MessageList/roomSwitch', 'rate'),
    numerator: METRIC.renderMessageList,
    denominator: METRIC.roomSwitches,
    informational: true,
  }),
  scrollWritesPerPositioning: Object.freeze({
    id: mint('scroll.writes/positioning', 'rate'),
    numerator: METRIC.scrollWrites,
    denominator: METRIC.scrollPositioningOps,
    informational: true,
  }),
  // The archive merge seam's yield: of the rows this merge received, how many the
  // store wrote durably. Both halves come from ONE report, so the pairing
  // cannot mix a numerator and a denominator measured at different moments.
  //
  // Informational for now, and NOT because the quantity is doubtful: seeding it
  // requires settling the build-stamp question in docs/anomaly-baseline.json, since
  // dirty rebuilds from one short HEAD currently share a review series.
  //
  // Read it with the registry's warning: `retained` means WRITTEN, not new to the
  // archive. A backgrounded entity keeps no resident array, so its pages dedupe
  // against nothing and are rewritten in full — a yield near 1 there says the
  // catch-up wrote, not that it learned anything.
  mamPageYield: Object.freeze({
    id: mint('mam.rowsRetained/rowsReturned', 'rate'),
    numerator: METRIC.mamRowsRetained,
    denominator: METRIC.mamRowsReturned,
    informational: true,
  }),
})

/**
 * Counter names for `recomputeUnread*` deferrals (issue #1211).
 *
 * Built from two literal unions rather than writing out every kind/reason pair. That
 * is still a CLOSED registry in the sense that matters: every part is a literal in
 * this file, so no caller data can reach a counter name. The alternative — accepting
 * the SDK's reason string directly — would be a free-text path into the log.
 *
 * Dotted, so `values.test.ts`'s slash-form parity check correctly treats them as
 * application metrics rather than invariant ids.
 */
const RECOUNT_DEFERRAL_REASONS = [
  'active-skipped',
  'no-meta',
  'pointerless-defer',
  'pending-remote-displayed',
  'no-floor',
  'history-not-caught-up',
  'context-changed',
  'coverage-missing',
  'coverage-unresolvable',
  'coverage-short-of-floor',
  'cache-unavailable',
  'recount-superseded',
  'input-version-changed',
  'pointer-changed',
] as const

export const RECOUNT_METRIC: Readonly<Record<string, Opaque>> = Object.freeze(
  Object.fromEntries(
    (['chat', 'room'] as const).flatMap((kind) =>
      RECOUNT_DEFERRAL_REASONS.map((reason) => [
        `${kind}:${reason}`,
        mint(`recount.deferred.${kind}.${reason}`, 'counter'),
      ]),
    ),
  ),
)

/**
 * The reserved set, enforced by the recorder's `count()`.
 *
 * Private for the same reason as VALUE_KINDS: `ReadonlySet` is a compile-time type
 * that erases at runtime, so an exported Set can be cleared by any caller and the
 * reservation silently stops applying.
 */
const RESERVED_COUNTERS: ReadonlySet<string> = new Set(Object.values(COUNTER).map((c) => c.s))

/** True for a counter name reserved for recorder health. */
export function isReservedCounter(name: string): boolean {
  return RESERVED_COUNTERS.has(name)
}

// ---------------------------------------------------------------------------
// Entity tokens — cross-session identity for JIDs, rooms, devices
// ---------------------------------------------------------------------------

export type TokenNs = 'jid' | 'room' | 'device'
const TOKEN_NS: ReadonlySet<string> = new Set(['jid', 'room', 'device'])

const KEY_STORAGE = 'fluux:anomaly-token-key'
const TOKEN_CACHE_LIMIT = 500
const UNRESOLVED = mint('c:unresolved', 'token')

const tokens = new Map<string, Opaque>()
const tokenWarms = new Map<string, Promise<void>>()
let hmacKey: CryptoKey | null = null
let keyId = 'unknown'
let unresolved = 0
let backgroundWarmFailures = 0

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
export function warmToken(ns: TokenNs, value: string): Promise<void> {
  if (!hmacKey || !TOKEN_NS.has(ns) || typeof value !== 'string') return Promise.resolve()
  const key = nsKey(ns, value)
  if (tokens.has(key)) return Promise.resolve()
  const existing = tokenWarms.get(key)
  if (existing) return existing

  const signingKey = hmacKey
  const pending = crypto.subtle.sign(
    'HMAC',
    signingKey,
    new TextEncoder().encode(key) as unknown as BufferSource,
  ).then((signature) => {
    if (hmacKey !== signingKey) return
    if (tokens.size >= TOKEN_CACHE_LIMIT) {
      const oldest = tokens.keys().next()
      if (!oldest.done) tokens.delete(oldest.value)
    }
    tokens.set(key, mint(`c:${toHex(signature, 8)}`, 'token'))
  }).finally(() => {
    if (tokenWarms.get(key) === pending) tokenWarms.delete(key)
  })
  tokenWarms.set(key, pending)
  return pending
}

/** Synchronous lookup. A miss returns the sentinel — never the raw value. */
export function tokenSync(ns: TokenNs, value: string): Opaque {
  if (!TOKEN_NS.has(ns)) throw new TypeError('unknown token namespace')
  const key = nsKey(ns, value)
  const hit = tokens.get(key)
  if (hit) {
    // Re-insert so the Map's iteration order reflects RECENCY, not insertion.
    // Without this the cache is FIFO: a token used on every record still ages out
    // after 500 new entities and starts resolving to the sentinel.
    tokens.delete(key)
    tokens.set(key, hit)
    return hit
  }
  unresolved++
  void warmToken(ns, value).catch(() => {
    backgroundWarmFailures++
  })
  return UNRESOLVED
}

/** Non-secret; goes in every record envelope. */
export function tokenKeyId(): string {
  return keyId
}

/**
 * True once the tokenizer holds a key.
 *
 * Until then `tokenKeyId()` is `'unknown'`, and a record carrying that is
 * unattributable to a token space — worse than a late record, since the key id is
 * the correlation boundary a review relies on.
 */
export function isTokenizerReady(): boolean {
  return hmacKey !== null
}

export function tokenUnresolvedCount(): number {
  return unresolved
}

export function tokenWarmFailureCount(): number {
  return backgroundWarmFailures
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
// Reassignable: a stale ref handed out before a reset must not be able to pin a
// NEW entry that happens to reuse its key, which would make a later test pass for
// the wrong reason.
let keyByRef = new WeakMap<Opaque, string>()
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
  tokenWarms.clear()
  refs.clear()
  keyByRef = new WeakMap<Opaque, string>()
  hmacKey = null
  keyId = 'unknown'
  unresolved = 0
  backgroundWarmFailures = 0
  nextSeq = 0
  overflow = 0
}
