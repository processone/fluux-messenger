/**
 * Identities retracted (XEP-0424), kept so a durable write that RACES the
 * retraction cannot resurrect the retracted body, in this session or a later one.
 *
 * A retraction and its target's own cache write are independent fire-and-forget
 * promises. When the retraction wins the race the cache row does not exist yet:
 * `updateMessage` finds nothing and returns, then the pending save lands and
 * stores the body, and the pending `indexMessage` writes the document the
 * retraction had just tried to remove. A cache row cannot record a retraction
 * that has no row, so the record lives here instead — consulted by every cache put
 * and by every index write.
 *
 * Identity is NOT reimplemented here. It delegates to the tiered ladder
 * (`messageIdentity.ts`): stanzaId → originId → from+id. A `from+id`-only key
 * would fail a retraction that references the stanza id only — the same lesson
 * `stores/shared/transientUnread.ts` records for unread counting, applied here to
 * the cache and index boundary.
 *
 * ## The verified ledger
 *
 * One record per retracted message per actor, carrying every alias the target is
 * known under. The in-memory ledger is the source of truth for the session and is
 * read synchronously inside cache write transactions; a sink attached by
 * `messageCache.ts` carries it across restarts (write-behind, one scoped
 * database per account) and reads the cache to classify records.
 *
 * A record is load-bearing only while no cache tombstone row carries its
 * retraction: once the row exists, every consumer reaches the row first. That is
 * what the rotation rests on. Rotation is by count only, never by age — an
 * archive page can re-deliver a message of any age, and a time limit would evict
 * the guard for exactly the messages a deep backfill brings back. Past
 * {@link RETRACTION_LEDGER_CAP}, records the sink reports as carried go first,
 * oldest first, down to {@link RETRACTION_LEDGER_LOW_WATER}; only if that is not
 * enough to reach the cap do uncarried records go, oldest first down to the cap,
 * announced through the `retraction-ledger-evicted` diagnostic. A record rotates
 * whole: an alias set is never split.
 *
 * An unresolved reference (`pending`) stays separate from the verified ledger and
 * carries its actor until a cache write can apply the authorship gate. The stores
 * persist and replay those references themselves; the map here only serves the
 * in-session write race and is not carried across restarts.
 *
 * Scoped by `{accountScope, kind, entityId}` (never a bare `entityId` — that
 * would leak retractions across accounts sharing the same room/chat id).
 *
 * @module Utils/RetractedIdentities
 */

import { mergeModerationMetadata, type ModerationMetadata } from './moderation'
import { getStorageScopeJid } from './storageScope'
import {
  archiveIdentityConflict,
  CHAT_SCOPE,
  identityKeys,
  isFallbackKey,
  roomScope,
  type IdentityFields,
  type IdentityScope,
  type RoomIdentityFields,
} from './messageIdentity'
import { publishDiagnostic, type RetractionLedgerEvictedDiagnostic } from '../diagnostics/channel'

/** Which entity a retraction belongs to. Mirrors `transientUnread.ScopeKey`. */
export interface RetractionScope {
  kind: 'chat' | 'room'
  /** `conversationId` for chat, `roomJid` for room. */
  entityId: string
  accountScope?: string | null
}

export interface PendingRetractionIdentity {
  targetId?: string
  moderation?: ModerationMetadata
  actorJid: string
  actorOccupantId?: string
  /**
   * The archive identity of the message that was retracted, when it had one.
   *
   * The `from+id` alias a record is filed under is not unique — a restarted
   * client re-issues client ids — so a lookup arriving through that rung needs to
   * corroborate WHICH message the record is about, exactly as `actorJid`
   * corroborates who retracted it. See {@link archiveIdentityConflict}.
   */
  stanzaId?: string
  originId?: string
  retractedAt: number
}

/**
 * One verified retraction, as held in memory and as stored. A persisted shape:
 * `aliases` uses the spelling of the cache's `identityKeys`, which
 * `messageIdentity.ts` locks.
 */
export interface VerifiedRetraction {
  /**
   * `{kind}\0{entityId}\0{actorJid}\0{actorOccupantId}\0{anchor}`, where `anchor`
   * is the first alias the record was created under. Stable across merges.
   */
  key: string
  kind: 'chat' | 'room'
  /** `conversationId` for chat, `roomJid` for room. */
  entityId: string
  /** Every identity key the target is known under; the union across notes. */
  aliases: string[]
  actorJid: string
  actorOccupantId?: string
  /** The target's archive identity, when known; see {@link PendingRetractionIdentity}. */
  stanzaId?: string
  originId?: string
  /** Epoch ms; the earliest delivery of the retraction wins. */
  retractedAt: number
  /** Epoch ms on the client's own clock; the rotation order. */
  notedAt: number
  moderation?: ModerationMetadata
}

/** What carries the ledger across restarts and reads the cache on its behalf. */
export interface RetractionLedgerSink {
  /** Every stored record of the account. */
  load(accountScope: string | null): Promise<VerifiedRetraction[]>
  /** Apply the puts and the deletes; one failure fails the whole batch. */
  persist(
    accountScope: string | null,
    puts: readonly VerifiedRetraction[],
    deletes: readonly string[]
  ): Promise<void>
  /**
   * The keys of the records a cache tombstone row already carries. Only records
   * with an archive-tier alias are offered.
   */
  classifyCarried(accountScope: string | null, records: readonly VerifiedRetraction[]): Promise<Set<string>>
  /** Drop every stored record of the account. */
  clear(accountScope: string | null): Promise<void>
  resetForTesting?(): void
}

/** Records per account before rotation runs. */
export const RETRACTION_LEDGER_CAP = 5000
/** Where compaction of carried records stops, so a burst does not compact on every note. */
export const RETRACTION_LEDGER_LOW_WATER = 4000
/** Records offered to the sink per classification round. */
const CLASSIFY_BATCH_SIZE = 256

// U+0000 separator: scopes/kinds/entity ids/ids cannot contain it, so joins never collide.
const SEP = String.fromCharCode(0)

interface Ledger {
  accountScope: string | null
  records: Map<string, VerifiedRetraction>
  /** `{kind}\0{entityId}\0{alias}` -> record keys. */
  byAlias: Map<string, Set<string>>
  hydrated: boolean
  hydration: Promise<void> | null
  pendingPuts: Map<string, VerifiedRetraction>
  pendingDeletes: Set<string>
  drainScheduled: boolean
  draining: Promise<void> | null
  rotation: Promise<void> | null
  rotationDue: boolean
}

interface LedgerState {
  sink: RetractionLedgerSink | null
  ledgers: Map<string, Ledger>
}

// Shared through `globalThis` because the published package compiles this
// module into several entry points; the ledger must be one per process.
const ledgerStateKey = Symbol.for('fluux.sdk.retraction-ledger')
const ledgerGlobal = globalThis as typeof globalThis & Record<symbol, unknown>
const state = (ledgerGlobal[ledgerStateKey] ??= { sink: null, ledgers: new Map() } satisfies LedgerState) as LedgerState

function resolveAccountScope(accountScope: string | null | undefined): string | null {
  return accountScope === undefined ? getStorageScopeJid() : accountScope
}

function ledgerFor(accountScope: string | null): Ledger {
  const key = accountScope ?? ''
  let ledger = state.ledgers.get(key)
  if (!ledger) {
    ledger = {
      accountScope,
      records: new Map(),
      byAlias: new Map(),
      hydrated: false,
      hydration: null,
      pendingPuts: new Map(),
      pendingDeletes: new Set(),
      drainScheduled: false,
      draining: null,
      rotation: null,
      rotationDue: false,
    }
    state.ledgers.set(key, ledger)
  }
  return ledger
}

/** Whether the ledger is still the live one, or was discarded by a reset. */
function isLive(ledger: Ledger): boolean {
  return state.ledgers.get(ledger.accountScope ?? '') === ledger
}

function aliasKey(kind: 'chat' | 'room', entityId: string, alias: string): string {
  return `${kind}${SEP}${entityId}${SEP}${alias}`
}

function recordKey(
  scope: Pick<RetractionScope, 'kind' | 'entityId'>,
  actor: Pick<VerifiedRetraction, 'actorJid' | 'actorOccupantId'>,
  anchor: string
): string {
  return `${scope.kind}${SEP}${scope.entityId}${SEP}${actor.actorJid}${SEP}${actor.actorOccupantId ?? ''}${SEP}${anchor}`
}

function identityScopeOf(record: Pick<VerifiedRetraction, 'kind' | 'entityId'>): IdentityScope {
  return record.kind === 'room' ? roomScope(record.entityId) : CHAT_SCOPE
}

function hasAuthoritativeAlias(record: VerifiedRetraction): boolean {
  const scope = identityScopeOf(record)
  return record.aliases.some((alias) => !isFallbackKey(scope, alias))
}

/**
 * Whether two records are about the same retraction — same actor, and no archive
 * identity separating their targets.
 *
 * Both halves matter under one alias: an actor who retracts a message and later
 * re-uses its client id files two records under the same `from+id` key, and
 * collapsing them would let the first one's tombstone answer for the second
 * message.
 */
function sameActor(
  left: Pick<PendingRetractionIdentity, 'actorJid' | 'actorOccupantId' | 'stanzaId' | 'originId'>,
  right: Pick<PendingRetractionIdentity, 'actorJid' | 'actorOccupantId' | 'stanzaId' | 'originId'>
): boolean {
  return (
    left.actorJid === right.actorJid &&
    left.actorOccupantId === right.actorOccupantId &&
    !archiveIdentityConflict(left, right)
  )
}

function sameModeration(a?: ModerationMetadata, b?: ModerationMetadata): boolean {
  return a?.isModerated === b?.isModerated && a?.moderatedBy === b?.moderatedBy &&
    a?.moderationReason === b?.moderationReason
}

function indexRecord(ledger: Ledger, record: VerifiedRetraction): void {
  for (const alias of record.aliases) {
    const key = aliasKey(record.kind, record.entityId, alias)
    let keys = ledger.byAlias.get(key)
    if (!keys) {
      keys = new Set()
      ledger.byAlias.set(key, keys)
    }
    keys.add(record.key)
  }
}

function unindexRecord(ledger: Ledger, record: VerifiedRetraction): void {
  for (const alias of record.aliases) {
    const key = aliasKey(record.kind, record.entityId, alias)
    const keys = ledger.byAlias.get(key)
    if (!keys) continue
    keys.delete(record.key)
    if (keys.size === 0) ledger.byAlias.delete(key)
  }
}

function queuePut(ledger: Ledger, record: VerifiedRetraction): void {
  ledger.pendingDeletes.delete(record.key)
  ledger.pendingPuts.set(record.key, record)
  scheduleDrain(ledger)
}

function queueDelete(ledger: Ledger, key: string): void {
  ledger.pendingPuts.delete(key)
  ledger.pendingDeletes.add(key)
  scheduleDrain(ledger)
}

function insertRecord(ledger: Ledger, record: VerifiedRetraction, persist: boolean): void {
  ledger.records.set(record.key, record)
  indexRecord(ledger, record)
  if (persist) queuePut(ledger, record)
}

function replaceRecord(ledger: Ledger, previous: VerifiedRetraction, next: VerifiedRetraction): void {
  unindexRecord(ledger, previous)
  ledger.records.set(next.key, next)
  indexRecord(ledger, next)
  queuePut(ledger, next)
}

function removeRecord(ledger: Ledger, key: string, persist: boolean): void {
  const record = ledger.records.get(key)
  if (!record) return
  unindexRecord(ledger, record)
  ledger.records.delete(key)
  if (persist) queueDelete(ledger, key)
}

/** The records under any of these aliases that are about the same retraction as `incoming`. */
function matchingRecords(
  ledger: Ledger,
  scope: Pick<RetractionScope, 'kind' | 'entityId'>,
  aliases: readonly string[],
  incoming: Pick<PendingRetractionIdentity, 'actorJid' | 'actorOccupantId' | 'stanzaId' | 'originId'>
): VerifiedRetraction[] {
  const matches = new Map<string, VerifiedRetraction>()
  for (const alias of aliases) {
    for (const key of ledger.byAlias.get(aliasKey(scope.kind, scope.entityId, alias)) ?? []) {
      const record = ledger.records.get(key)
      if (record && !matches.has(key) && sameActor(record, incoming)) matches.set(key, record)
    }
  }
  return [...matches.values()].sort((a, b) => a.notedAt - b.notedAt)
}

/**
 * Fold what a further note or a stored copy says into a record: the union of the
 * aliases, the earliest retraction and note, every archive tier learned, the
 * merged moderation. Returns the record itself when nothing changed.
 */
function mergeRecord(
  record: VerifiedRetraction,
  incoming: Pick<VerifiedRetraction, 'aliases' | 'retractedAt' | 'stanzaId' | 'originId' | 'moderation'> & { notedAt?: number }
): VerifiedRetraction {
  const aliases = incoming.aliases.filter((alias) => !record.aliases.includes(alias))
  const retractedAt = Math.min(record.retractedAt, incoming.retractedAt)
  const notedAt = incoming.notedAt === undefined ? record.notedAt : Math.min(record.notedAt, incoming.notedAt)
  const stanzaId = record.stanzaId ?? incoming.stanzaId
  const originId = record.originId ?? incoming.originId
  const moderation = mergeModerationMetadata(record.moderation, incoming.moderation)
  if (
    aliases.length === 0 && retractedAt === record.retractedAt && notedAt === record.notedAt &&
    stanzaId === record.stanzaId && originId === record.originId && sameModeration(moderation, record.moderation)
  ) return record
  return {
    ...record,
    aliases: [...record.aliases, ...aliases],
    retractedAt,
    notedAt,
    ...(stanzaId ? { stanzaId } : {}),
    ...(originId ? { originId } : {}),
    ...(moderation ? { moderation } : {}),
  }
}

/**
 * `persistIncoming` is false for a stored copy
 * being hydrated, which needs no write unless it changes something.
 */
function upsertRecord(
  ledger: Ledger,
  incoming: VerifiedRetraction,
  matches: readonly VerifiedRetraction[],
  persistIncoming: boolean
): void {
  if (matches.length === 0) {
    insertRecord(ledger, incoming, persistIncoming)
    return
  }
  if (matches.some((record, index) => matches.slice(index + 1).some(other => archiveIdentityConflict(record, other)))) {
    for (const record of matches) {
      const merged = mergeRecord(record, incoming)
      if (merged !== record) replaceRecord(ledger, record, merged)
    }
    return
  }
  const [primary, ...others] = matches
  let merged = mergeRecord(primary, incoming)
  for (const other of others) {
    merged = mergeRecord(merged, other)
    removeRecord(ledger, other.key, true)
  }
  if (incoming.key !== primary.key && !persistIncoming) {
    // A stored copy folded into a record held under another key: only one of
    // the two keys survives on disk.
    queueDelete(ledger, incoming.key)
    if (merged === primary) merged = { ...primary }
  }
  if (merged !== primary) replaceRecord(ledger, primary, merged)
}

// =============================================================================
// Persistence: hydration and write-behind
// =============================================================================

function scheduleDrain(ledger: Ledger): void {
  if (ledger.drainScheduled) return
  ledger.drainScheduled = true
  queueMicrotask(() => {
    ledger.drainScheduled = false
    if (!ledger.draining) ledger.draining = drain(ledger)
  })
}

async function drain(ledger: Ledger): Promise<void> {
  try {
    await ensureRetractionLedger(ledger.accountScope)
    while (state.sink && isLive(ledger) && (ledger.pendingPuts.size > 0 || ledger.pendingDeletes.size > 0)) {
      const sink = state.sink
      const puts = [...ledger.pendingPuts.values()]
      const deletes = [...ledger.pendingDeletes]
      ledger.pendingPuts.clear()
      ledger.pendingDeletes.clear()
      try {
        await sink.persist(ledger.accountScope, puts, deletes)
      } catch (error) {
        console.warn('Failed to persist the retraction ledger:', error)
        // Back into the queue for the next drain, unless a later write superseded it.
        for (const record of puts) {
          if (ledger.pendingPuts.has(record.key) || ledger.pendingDeletes.has(record.key)) continue
          if (ledger.records.get(record.key) === record) ledger.pendingPuts.set(record.key, record)
        }
        for (const key of deletes) {
          if (!ledger.pendingPuts.has(key) && !ledger.records.has(key)) ledger.pendingDeletes.add(key)
        }
        return
      }
    }
  } finally {
    ledger.draining = null
  }
}

async function hydrate(ledger: Ledger): Promise<void> {
  const sink = state.sink
  if (sink) {
    try {
      const stored = await sink.load(ledger.accountScope)
      if (isLive(ledger)) {
        for (const record of stored) {
          upsertRecord(ledger, record, matchingRecords(ledger, record, record.aliases, record), false)
        }
      }
    } catch (error) {
      console.warn('Failed to load the retraction ledger:', error)
    }
  }
  ledger.hydrated = true
  ledger.hydration = null
  rotateIfNeeded(ledger)
}

/**
 * Resolve once the account's stored records are in memory. Every cache
 * connection awaits this before serving a write, so no write is judged against
 * an empty ledger after a restart. Never rejects: a ledger that cannot be
 * loaded degrades to this session's notes.
 */
export function ensureRetractionLedger(accountScope: string | null | undefined): Promise<void> {
  const ledger = ledgerFor(resolveAccountScope(accountScope))
  if (ledger.hydrated) return Promise.resolve()
  if (!ledger.hydration) ledger.hydration = hydrate(ledger)
  return ledger.hydration
}

/** Attach (or detach, with `null`) what carries the ledger across restarts. */
export function attachRetractionLedgerSink(sink: RetractionLedgerSink | null): void {
  state.sink = sink
}

/** Drop the account's records, in memory and in storage: its cache is gone too. */
export async function clearRetractionLedger(accountScope: string | null): Promise<void> {
  const ledger = state.ledgers.get(accountScope ?? '')
  if (ledger) {
    if (ledger.draining) await ledger.draining.catch(() => {})
    ledger.records.clear()
    ledger.byAlias.clear()
    ledger.pendingPuts.clear()
    ledger.pendingDeletes.clear()
    ledger.hydrated = true
  }
  try {
    await state.sink?.clear(accountScope)
  } catch (error) {
    console.warn('Failed to clear the retraction ledger:', error)
  }
}

// =============================================================================
// Rotation
// =============================================================================

function rotateIfNeeded(ledger: Ledger): void {
  if (ledger.records.size <= RETRACTION_LEDGER_CAP) return
  ledger.rotationDue = true
  if (!ledger.rotation) ledger.rotation = runRotation(ledger)
}

async function runRotation(ledger: Ledger): Promise<void> {
  try {
    while (ledger.rotationDue && isLive(ledger)) {
      ledger.rotationDue = false
      await rotateOnce(ledger)
    }
  } finally {
    ledger.rotation = null
  }
}

function retractionLedgerEvictedEvent(
  source: Omit<RetractionLedgerEvictedDiagnostic, 'kind'>
): RetractionLedgerEvictedDiagnostic {
  return { kind: 'retraction-ledger-evicted', ...source }
}

/**
 * One rotation pass: compact carried records oldest-first down to the low-water
 * mark, then, only if the ledger is still over the cap, evict uncarried records
 * oldest-first and say so. Classification reads the durable cache, so a record
 * whose tombstone write is still in flight is uncarried and cannot be compacted.
 */
async function rotateOnce(ledger: Ledger): Promise<void> {
  await ensureRetractionLedger(ledger.accountScope)
  if (!isLive(ledger) || ledger.records.size <= RETRACTION_LEDGER_CAP) return
  const ordered = [...ledger.records.values()].sort((a, b) => a.notedAt - b.notedAt)
  let compacted = 0
  const sink = state.sink
  if (sink) {
    const candidates = ordered.filter(hasAuthoritativeAlias)
    for (let offset = 0; offset < candidates.length && ledger.records.size > RETRACTION_LEDGER_LOW_WATER; offset += CLASSIFY_BATCH_SIZE) {
      const batch = candidates.slice(offset, offset + CLASSIFY_BATCH_SIZE)
      let carried: Set<string>
      try {
        carried = await sink.classifyCarried(ledger.accountScope, batch)
      } catch (error) {
        console.warn('Failed to classify retraction ledger records:', error)
        break
      }
      if (!isLive(ledger)) return
      for (const record of batch) {
        if (ledger.records.size <= RETRACTION_LEDGER_LOW_WATER) break
        // A record merged during the round is a different object: judge it next time.
        if (!carried.has(record.key) || ledger.records.get(record.key) !== record) continue
        removeRecord(ledger, record.key, true)
        compacted++
      }
    }
  }
  if (ledger.records.size <= RETRACTION_LEDGER_CAP) return
  let evicted = 0
  for (const record of ordered) {
    if (ledger.records.size <= RETRACTION_LEDGER_CAP) break
    if (!ledger.records.has(record.key)) continue
    removeRecord(ledger, record.key, true)
    evicted++
  }
  publishDiagnostic('retraction-ledger-evicted', retractionLedgerEvictedEvent, {
    accountScope: ledger.accountScope,
    compacted,
    evicted,
    remaining: ledger.records.size,
  })
}

// =============================================================================
// Aliases
// =============================================================================

/**
 * The alias a bare `<retract id="…">` reference contributes. Every message
 * contributes one per id tier it carries, so a note made from the reference alone
 * still resolves once the message itself shows up.
 */
function rawAlias(reference: string): string {
  return `ref${SEP}${reference}`
}

export interface PendingRetractionAlias {
  alias: string
  authoritative: boolean
}

function rawAliasesOf(
  m: Pick<IdentityFields, 'id' | 'stanzaId' | 'originId' | 'correctionStanzaIds'>
): PendingRetractionAlias[] {
  const aliases = new Map<string, boolean>()
  for (const [reference, authoritative] of [
    [m.id, false],
    [m.stanzaId, true],
    [m.originId, true],
    ...(m.correctionStanzaIds ?? []).map(id => [id, true] as const),
  ] as const) {
    if (!reference) continue
    const alias = rawAlias(reference)
    aliases.set(alias, (aliases.get(alias) ?? false) || authoritative)
  }
  return [...aliases].map(([alias, authoritative]) => ({ alias, authoritative }))
}

/** Every verified alias a chat message is known under. */
export function chatRetractionAliases(m: IdentityFields): string[] {
  return identityKeys(CHAT_SCOPE, m)
}

/** Every verified alias a room message is known under. */
export function roomRetractionAliases(m: RoomIdentityFields): string[] {
  return identityKeys(roomScope(m.roomJid), m)
}

export function chatPendingRetractionAliases(
  m: IdentityFields
): PendingRetractionAlias[] {
  return rawAliasesOf(m)
}

export function roomPendingRetractionAliases(m: RoomIdentityFields): PendingRetractionAlias[] {
  return rawAliasesOf(m)
}

// =============================================================================
// Unresolved references (session-only; the stores persist and replay them)
// =============================================================================

/**
 * Alias cap for unresolved references across every scope, so a long session
 * stays bounded. A reference only lives here until a cache write resolves it or
 * the store replays it.
 */
const PENDING_ALIAS_CAP = 2000

/** alias -> unresolved actors. Insertion-ordered, so the oldest evicts first. */
const pending = new Map<string, PendingRetractionIdentity[]>()
let pendingCount = 0

function scopePrefix(scope: RetractionScope): string {
  return `${resolveAccountScope(scope.accountScope) ?? ''}${SEP}${scope.kind}${SEP}${scope.entityId}${SEP}`
}

export function notePendingRetractionIdentity(
  scope: RetractionScope,
  targetId: string,
  record: PendingRetractionIdentity
): void {
  const key = `${scopePrefix(scope)}${rawAlias(targetId)}`
  const known = pending.get(key) ?? []
  const actorIndex = known.findIndex((candidate) => sameActor(candidate, record))
  if (actorIndex === -1) {
    pending.set(key, [...known, record])
    pendingCount++
  } else if (record.retractedAt < known[actorIndex].retractedAt || record.moderation) {
    const next = [...known]
    next[actorIndex] = { ...record, retractedAt: Math.min(record.retractedAt, known[actorIndex].retractedAt),
      moderation: mergeModerationMetadata(known[actorIndex].moderation, record.moderation) }
    pending.set(key, next)
  }
  while (pendingCount > PENDING_ALIAS_CAP) {
    const oldest = pending.keys().next()
    if (oldest.done) break
    const records = pending.get(oldest.value)!
    if (records.length === 1) pending.delete(oldest.value)
    else pending.set(oldest.value, records.slice(1))
    pendingCount--
  }
}

export function clearPendingRetractionIdentity(
  scope: RetractionScope,
  targetId: string
): void {
  const key = `${scopePrefix(scope)}${rawAlias(targetId)}`
  const records = pending.get(key)
  if (records) pendingCount -= records.length
  pending.delete(key)
}

export function consumePendingRetractionIdentity(
  scope: RetractionScope,
  targetId: string,
  record: PendingRetractionIdentity,
  authoritative: boolean
): void {
  if (authoritative) {
    clearPendingRetractionIdentity(scope, targetId)
    return
  }
  const key = `${scopePrefix(scope)}${rawAlias(targetId)}`
  const records = pending.get(key)
  if (!records) return
  const remaining = records.filter((candidate) => !sameActor(candidate, record))
  pendingCount -= records.length - remaining.length
  if (remaining.length === 0) pending.delete(key)
  else pending.set(key, remaining)
}

export function adoptPendingRetraction(
  scope: RetractionScope,
  aliases: readonly PendingRetractionAlias[],
  isAuthor: (record: PendingRetractionIdentity) => boolean,
  onMatch?: (record: PendingRetractionIdentity) => void
): number | undefined {
  const prefix = scopePrefix(scope)
  let earliest: number | undefined
  for (const { alias, authoritative } of aliases) {
    const key = `${prefix}${alias}`
    const records = pending.get(key)
    if (!records) continue
    const authorized = records.filter(isAuthor)
    if (authoritative && !records.some(record => record.moderation && !isAuthor(record))) {
      pending.delete(key)
      pendingCount -= records.length
    } else if (authorized.length > 0) {
      const remaining = records.filter((record) => !isAuthor(record))
      pendingCount -= authorized.length
      if (remaining.length === 0) pending.delete(key)
      else pending.set(key, remaining)
    }
    for (const record of authorized) {
      onMatch?.(record)
      if (earliest === undefined || record.retractedAt < earliest) {
        earliest = record.retractedAt
      }
    }
  }
  return earliest
}

// =============================================================================
// Verified retractions
// =============================================================================

/**
 * Record that everything reachable through these aliases is retracted. Idempotent;
 * the earliest `retractedAt` wins so a re-delivered retraction cannot move the
 * tombstone forward, and a note through other tiers of the same target joins the
 * existing record rather than opening a second one.
 */
export function noteRetractedIdentity(
  scope: RetractionScope,
  aliases: readonly string[],
  actor: Pick<IdentityFields, 'from' | 'occupantId' | 'stanzaId' | 'originId'>,
  retractedAt: number,
  moderation?: ModerationMetadata
): void {
  if (aliases.length === 0) return
  const ledger = ledgerFor(resolveAccountScope(scope.accountScope))
  const uniqueAliases = [...new Set(aliases)]
  const incoming: VerifiedRetraction = {
    key: '',
    kind: scope.kind,
    entityId: scope.entityId,
    aliases: uniqueAliases,
    actorJid: actor.from,
    ...(actor.occupantId ? { actorOccupantId: actor.occupantId } : {}),
    ...(actor.stanzaId ? { stanzaId: actor.stanzaId } : {}),
    ...(actor.originId ? { originId: actor.originId } : {}),
    retractedAt,
    notedAt: Date.now(),
    ...(moderation ? { moderation } : {}),
  }
  incoming.key = recordKey(scope, incoming, uniqueAliases[0])
  upsertRecord(ledger, incoming, matchingRecords(ledger, scope, uniqueAliases, incoming), true)
  rotateIfNeeded(ledger)
}

/**
 * The retraction time recorded for any of these aliases, or undefined when none
 * is known. Resolves through ANY tier — a note made from the stanza id still
 * answers a lookup carrying only `from`+`id`.
 */
export function retractedAtForIdentity(
  scope: RetractionScope,
  aliases: readonly string[],
  isAuthor: (record: PendingRetractionIdentity) => boolean,
  onMatch?: (record: PendingRetractionIdentity) => void
): number | undefined {
  const ledger = state.ledgers.get(resolveAccountScope(scope.accountScope) ?? '')
  if (!ledger) return undefined
  const seen = new Set<string>()
  let earliest: number | undefined
  for (const alias of aliases) {
    for (const key of ledger.byAlias.get(aliasKey(scope.kind, scope.entityId, alias)) ?? []) {
      if (seen.has(key)) continue
      seen.add(key)
      const record = ledger.records.get(key)
      if (!record || !isAuthor(record)) continue
      onMatch?.(record)
      if (earliest === undefined || record.retractedAt < earliest) earliest = record.retractedAt
    }
  }
  return earliest
}

// =============================================================================
// Test seams
// =============================================================================

/** Test-only: this module's state is process-wide, untouched by store resets. */
export function _clearRetractedIdentitiesForTesting(): void {
  state.ledgers.clear()
  pending.clear()
  pendingCount = 0
  state.sink?.resetForTesting?.()
}

/** Test-only: the account's records and whether its stored copy has been read. */
export function _retractionLedgerForTesting(
  accountScope: string | null
): { records: VerifiedRetraction[]; hydrated: boolean } {
  const ledger = state.ledgers.get(accountScope ?? '')
  return { records: ledger ? [...ledger.records.values()] : [], hydrated: ledger?.hydrated ?? false }
}

/** Test-only: wait until no hydration, drain or rotation is in flight. */
export async function _settleRetractionLedgerForTesting(): Promise<void> {
  for (let round = 0; round < 100; round++) {
    const ledgers = [...state.ledgers.values()]
    const inFlight = ledgers.flatMap((ledger) => [ledger.hydration, ledger.draining, ledger.rotation])
      .filter((promise): promise is Promise<void> => promise !== null)
    const scheduled = ledgers.some((ledger) => ledger.drainScheduled || ledger.rotationDue)
    if (inFlight.length === 0 && !scheduled) return
    await Promise.all(inFlight.map((promise) => promise.catch(() => {})))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}
