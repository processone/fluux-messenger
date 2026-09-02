/**
 * Identities retracted during this session, so a durable write that RACES the
 * retraction cannot resurrect the retracted body.
 *
 * A retraction (XEP-0424) and its target's own cache write are independent
 * fire-and-forget promises. When the retraction wins the race the cache row does
 * not exist yet: `updateMessage` finds nothing and returns, then the pending save
 * lands and stores the body, and the pending `indexMessage` writes the document
 * the retraction had just tried to remove. A cache row cannot record a retraction
 * that has no row, so the record lives here instead — consulted by every cache put
 * and by every index write.
 *
 * Identity is NOT reimplemented here. It delegates to the tiered ladder
 * (`messageIdentity.ts`): stanzaId → originId → from+id. A `from+id`-only key
 * would fail a retraction that references the
 * stanza id only — the same lesson `stores/shared/transientUnread.ts` records for
 * unread counting, applied here to the cache and index boundary.
 *
 * An unresolved reference stays separate from the verified identity ledger and
 * carries its actor until a cache write can apply the authorship gate.
 *
 * Scoped by `{storageScope, kind, entityId}` (never a bare `entityId` — that
 * would leak retractions across accounts sharing the same room/chat id).
 * Session-lived: once the write it guards has landed, the tombstone is in the
 * cache row itself and outlives this map.
 *
 * @module Utils/RetractedIdentities
 */

import { getStorageScopeJid } from './storageScope'
import {
  CHAT_SCOPE,
  identityKeys,
  roomScope,
  type IdentityFields,
  type RoomIdentityFields,
} from './messageIdentity'

/** Which entity a retraction belongs to. Mirrors `transientUnread.ScopeKey`. */
export interface RetractionScope {
  kind: 'chat' | 'room'
  /** `conversationId` for chat, `roomJid` for room. */
  entityId: string
  accountScope?: string | null
}

export interface PendingRetractionIdentity {
  actorJid: string
  actorOccupantId?: string
  retractedAt: number
}

// U+0000 separator: scopes/kinds/entity ids/ids cannot contain it, so joins never collide.
const SEP = String.fromCharCode(0)

/**
 * Alias cap across every scope. The cap keeps unresolved references and
 * race-protection entries bounded during a long session. More than 2,000
 * concurrent verified actor-alias entries — about 667 messages carrying three
 * identity tiers — can evict a retraction before its cache and index writes
 * land, allowing a later save to retain the original body. Closing that bounded
 * window requires an authorized lifecycle or durable state.
 */
const ALIAS_CAP = 2000

/** alias -> verified actors. Insertion-ordered, so the oldest evicts first. */
const retracted = new Map<string, PendingRetractionIdentity[]>()
const pending = new Map<string, PendingRetractionIdentity[]>()
let retractedCount = 0
let pendingCount = 0

function sameActor(
  left: PendingRetractionIdentity,
  right: Pick<PendingRetractionIdentity, 'actorJid' | 'actorOccupantId'>
): boolean {
  return left.actorJid === right.actorJid && left.actorOccupantId === right.actorOccupantId
}

function scopePrefix(scope: RetractionScope): string {
  const accountScope = scope.accountScope === undefined ? getStorageScopeJid() : scope.accountScope
  return `${accountScope ?? ''}${SEP}${scope.kind}${SEP}${scope.entityId}${SEP}`
}

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
  m: { id: string; stanzaId?: string; originId?: string }
): PendingRetractionAlias[] {
  const aliases = new Map<string, boolean>()
  for (const [reference, authoritative] of [
    [m.id, false],
    [m.stanzaId, true],
    [m.originId, true],
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
  } else if (record.retractedAt < known[actorIndex].retractedAt) {
    const next = [...known]
    next[actorIndex] = record
    pending.set(key, next)
  }
  while (pendingCount > ALIAS_CAP) {
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
  isAuthor: (record: PendingRetractionIdentity) => boolean
): number | undefined {
  const prefix = scopePrefix(scope)
  let earliest: number | undefined
  for (const { alias, authoritative } of aliases) {
    const key = `${prefix}${alias}`
    const records = pending.get(key)
    if (!records) continue
    const authorized = records.filter(isAuthor)
    if (authoritative) {
      pending.delete(key)
      pendingCount -= records.length
    } else if (authorized.length > 0) {
      const remaining = records.filter((record) => !isAuthor(record))
      pendingCount -= authorized.length
      if (remaining.length === 0) pending.delete(key)
      else pending.set(key, remaining)
    }
    for (const record of authorized) {
      if (earliest === undefined || record.retractedAt < earliest) {
        earliest = record.retractedAt
      }
    }
  }
  return earliest
}

/**
 * Record that everything reachable through these aliases is retracted. Idempotent;
 * the earliest `retractedAt` wins so a re-delivered retraction cannot move the
 * tombstone forward.
 */
export function noteRetractedIdentity(
  scope: RetractionScope,
  aliases: readonly string[],
  actor: Pick<IdentityFields, 'from' | 'occupantId'>,
  retractedAt: number
): void {
  const prefix = scopePrefix(scope)
  const record: PendingRetractionIdentity = {
    actorJid: actor.from,
    ...(actor.occupantId ? { actorOccupantId: actor.occupantId } : {}),
    retractedAt,
  }
  for (const alias of aliases) {
    const key = `${prefix}${alias}`
    const known = retracted.get(key) ?? []
    const actorIndex = known.findIndex((candidate) => sameActor(candidate, record))
    if (actorIndex === -1) {
      retracted.set(key, [...known, record])
      retractedCount++
    } else if (retractedAt < known[actorIndex].retractedAt) {
      const next = [...known]
      next[actorIndex] = record
      retracted.set(key, next)
    }
  }
  while (retractedCount > ALIAS_CAP) {
    const oldest = retracted.keys().next()
    if (oldest.done) break
    const records = retracted.get(oldest.value)!
    if (records.length === 1) retracted.delete(oldest.value)
    else retracted.set(oldest.value, records.slice(1))
    retractedCount--
  }
}

/**
 * The retraction time recorded for any of these aliases, or undefined when none
 * is known. Resolves through ANY tier — a note made from the stanza id still
 * answers a lookup carrying only `from`+`id`.
 */
export function retractedAtForIdentity(
  scope: RetractionScope,
  aliases: readonly string[],
  isAuthor: (record: PendingRetractionIdentity) => boolean
): number | undefined {
  const prefix = scopePrefix(scope)
  let earliest: number | undefined
  for (const alias of aliases) {
    const records = retracted.get(`${prefix}${alias}`) ?? []
    for (const record of records) {
      if (isAuthor(record) && (earliest === undefined || record.retractedAt < earliest)) {
        earliest = record.retractedAt
      }
    }
  }
  return earliest
}

/** Test-only: this module's state is a plain top-level Map, untouched by store resets. */
export function _clearRetractedIdentitiesForTesting(): void {
  retracted.clear()
  pending.clear()
  retractedCount = 0
  pendingCount = 0
}
