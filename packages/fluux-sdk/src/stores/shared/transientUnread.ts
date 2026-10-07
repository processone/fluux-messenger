import { compareExact, isAfterBoundary, type ExactPosition, type PointerOrder } from './readState'
import {
  CHAT_SCOPE,
  archiveIdentityConflict,
  sameChatMessage,
  canonicalKey,
  identityKeys,
  mergeableOccupantCandidates,
  roomScope,
  sameLogicalMessage,
  type RoomIdentityFields,
} from '../../utils/messageIdentity'
import type { Message } from '../../core/types/chat'
import type { RoomMessage } from '../../core/types/room'
import { backfillRoomStanzaId, roomStanzaIdsMergeable } from '../../utils/roomStanzaId'

/**
 * Transient overlay for unread messages that have no durable IndexedDB row:
 * permanently for `noLocalStore` messages, and while an ordinary live write
 * is pending or after it fails. `unreadCount` is derived from the archive (see
 * `readState.ts`), but an archive-only count silently erases these messages.
 * This overlay holds them in memory, position-aware, so callers can add its
 * contribution on top of the archive-derived count:
 * `unread = min(999, archive.unread + transient.unread)`.
 *
 * Scoped by `{accountScope, kind, entityId}` (never a bare `entityId` — that
 * would leak counts across accounts sharing the same room/chat id).
 *
 * Chat and room identity delegate to `messageIdentity.ts`. A
 * `from+id`-only key would double-count a message once a stanza id arrives
 * on a later copy, and would fail a retraction that references the stanza id
 * only. Every entry is stored once under a unique settlement key derived from
 * its canonical identity and indexed by every alias tier it carries. Shared
 * aliases locate candidates; message identity decides whether they can merge.
 * The settlement key lets a pending write clear its own arrival even when a
 * twin shares an alias — see the two-structure storage shape below.
 *
 * Entries are NEVER cleared on deactivation: clearing when the user
 * switches away (while scrolled up) would silently drop unread. An entry
 * leaves only when the read pointer passes it ({@link pruneTransient}), the
 * message becomes durable or is retracted/removed ({@link removeTransient}),
 * or the account is torn down ({@link clearTransientScope}). Because {@link transientCounts}
 * compares each entry against the *current* boundary, a partial pointer
 * advance reduces the count correctly with no clearing at all — pruning is
 * a memory bound, not a correctness mechanism.
 *
 * @module Stores/Shared/TransientUnread
 */

export interface ScopeKey {
  accountScope: string
  kind: 'chat' | 'room'
  entityId: string
}

/**
 * A transient entry's only payload: the position it counts at. Exact, because
 * every entry is noted from a real message, so its tie-break always resolves.
 */
export interface TransientEntry {
  position: ExactPosition
}

export interface NoteTransientResult {
  /** True only for a brand-new logical entry — drives the caller's fast `+1`. */
  added: boolean
  /**
   * True when the overlay's contribution to the count may have changed even
   * though nothing was added — a coalesce (two entries became one) or the
   * retained position moving earlier (may now cross the boundary
   * differently). Independent of `added`: drives a scheduled recount, not a
   * `+1`/`-1`.
   */
  requiresRecount: boolean
  settlementKey?: string
}

/** One logical message: its position, plus every alias tier it is known under. */
interface StoredEntry {
  entry: TransientEntry
  aliases: Set<string>
  occupantId?: string
  message?: Message | RoomMessage
}

function matchingEntries(message: Message | RoomMessage | undefined, occupantId: string | undefined, entries: StoredEntry[]): StoredEntry[] | undefined {
  const candidates = mergeableOccupantCandidates({ occupantId }, entries).filter(({ message: held }) => {
    if (!message || !held) return true
    if (message.type === 'chat' && held.type === 'chat') return sameChatMessage(message, held)
    return message.type === 'groupchat' && held.type === 'groupchat' &&
      roomStanzaIdsMergeable(message, held) && sameLogicalMessage(roomScope(message.roomJid), message, held)
  })
  if (message?.type === 'chat' && candidates.some(({ message: a }, index) =>
    a && candidates.slice(index + 1).some(({ message: b }) => b && archiveIdentityConflict(a, b)))) return undefined
  return candidates
}

function backfillMessage(held: Message | RoomMessage, incoming: Message | RoomMessage): Message | RoomMessage {
  if (held.type === 'groupchat' && incoming.type === 'groupchat') return backfillRoomStanzaId(held, incoming)
  return { ...held, stanzaId: held.stanzaId ?? incoming.stanzaId, originId: held.originId ?? incoming.originId }
}

/** Per-scope storage. Two structures, not one — see module doc. */
interface TransientScope {
  /** canonicalId -> stored entry. The ONLY thing iterated for counting/pruning. */
  entries: Map<string, StoredEntry>
  /** any alias -> canonicalId. Resolution and retraction lookup only — never iterated for counting. */
  canonicalByAlias: Map<string, Set<string>>
}

// U+0000 separator: account scopes/kinds/entity ids cannot contain it, so joins never collide.
const SEP = String.fromCharCode(0)

const scopes = new Map<string, TransientScope>()
let nextEntryId = 0

function scopeKeyString(key: ScopeKey): string {
  return `${key.accountScope}${SEP}${key.kind}${SEP}${key.entityId}`
}

function getScope(key: ScopeKey): TransientScope | undefined {
  return scopes.get(scopeKeyString(key))
}

function getOrCreateScope(key: ScopeKey): TransientScope {
  const k = scopeKeyString(key)
  let scope = scopes.get(k)
  if (!scope) {
    scope = { entries: new Map(), canonicalByAlias: new Map() }
    scopes.set(k, scope)
  }
  return scope
}

export function transientIdentity(msg: RoomIdentityFields, kind: 'room'): string
export function transientIdentity(msg: { id: string; from?: string; stanzaId?: string; originId?: string }, kind: 'chat'): string
export function transientIdentity(msg: RoomIdentityFields | { id: string; from?: string; stanzaId?: string; originId?: string }, kind: 'room' | 'chat'): string {
  if (kind !== 'room') return canonicalKey(CHAT_SCOPE, { ...msg, from: msg.from ?? '' })
  const room = msg as RoomIdentityFields
  return canonicalKey(roomScope(room.roomJid), room)
}

export function transientAliases(msg: RoomIdentityFields, kind: 'room'): string[]
export function transientAliases(msg: { id: string; from?: string; stanzaId?: string; originId?: string }, kind: 'chat'): string[]
export function transientAliases(msg: RoomIdentityFields | { id: string; from?: string; stanzaId?: string; originId?: string }, kind: 'room' | 'chat'): string[] {
  if (kind !== 'room') return identityKeys(CHAT_SCOPE, { ...msg, from: msg.from ?? '' })
  const room = msg as RoomIdentityFields
  return identityKeys(roomScope(room.roomJid), room)
}

/**
 * Note a message that is not yet represented by a durable archive row. Resolves supplied aliases
 * through `canonicalByAlias`, then filters candidates by message identity. An ambiguous chat copy
 * matching conflicting twins leaves the overlay unchanged. For the remaining candidates:
 *
 * - none resolve → brand-new logical entry, stored under a unique settlement key.
 *   `{ added: true, requiresRecount: false }`.
 * - exactly one resolves → the message is already known (possibly under a
 *   lower identity tier). Register any newly-seen aliases (does not, by
 *   itself, change what `transientCounts` reports — same entry, same
 *   count). If the new position is strictly earlier than the retained one,
 *   adopt it (a message can be re-noted with a position no boundary
 *   comparison has seen yet). `{ added: false, requiresRecount: <moved earlier> }`.
 * - more than one resolves → a later alias bridges two (or more)
 *   previously-distinct entries (e.g. a copy carrying both an origin-id and
 *   a stanza-id that were each noted separately first). Coalesce all of them
 *   into one survivor: union every alias set, keep the earliest position
 *   across all coalesced entries and the incoming one, re-point every alias
 *   at the survivor, and drop the losing entries. This always changes the
 *   overlay's contribution (N entries become 1), so
 *   `{ added: false, requiresRecount: true }` even though nothing was added.
 *
 * An accepted note returns `settlementKey` for removing that entry when its write commits.
 */
export function noteTransient(
  key: ScopeKey,
  entry: TransientEntry,
  source: string | Message | RoomMessage,
  aliases?: string[],
  occupantId?: string
): NoteTransientResult {
  const message = typeof source === 'string' ? undefined : source
  if (message && (message.type === 'chat'
    ? key.kind !== 'chat' || key.entityId !== message.conversationId
    : key.kind !== 'room' || key.entityId !== message.roomJid)) return { added: false, requiresRecount: false }
  const identity = typeof source === 'string' ? source
    : source.type === 'chat' ? transientIdentity(source, 'chat') : transientIdentity(source, 'room')
  if (message) {
    aliases = message.type === 'chat' ? transientAliases(message, 'chat') : transientAliases(message, 'room')
    occupantId = message.type === 'groupchat' ? message.occupantId : undefined
  }
  const scope = getOrCreateScope(key)
  const allAliases = new Set(aliases ?? [])
  allAliases.add(identity)

  const matchedCanonicalIds = new Set<string>()
  for (const alias of allAliases) {
    for (const canonicalId of scope.canonicalByAlias.get(alias) ?? []) {
      const stored = scope.entries.get(canonicalId)
      if (stored) {
        matchedCanonicalIds.add(canonicalId)
      }
    }
  }
  const matchedEntries = [...matchedCanonicalIds]
    .map((canonicalId) => scope.entries.get(canonicalId))
    .filter((stored): stored is StoredEntry => !!stored)
  const matching = matchingEntries(message, occupantId, matchedEntries)
  if (!matching) return { added: false, requiresRecount: false }
  const mergeableEntries = new Set(matching)
  for (const canonicalId of matchedCanonicalIds) {
    const stored = scope.entries.get(canonicalId)
    if (!stored || !mergeableEntries.has(stored)) {
      matchedCanonicalIds.delete(canonicalId)
    }
  }

  // Case 1: brand-new logical entry.
  if (matchedCanonicalIds.size === 0) {
    const canonicalId = `${identity}${SEP}entry${SEP}${++nextEntryId}`
    allAliases.add(canonicalId)
    scope.entries.set(canonicalId, {
      entry: { position: entry.position },
      aliases: new Set(allAliases),
      occupantId,
      message,
    })
    for (const alias of allAliases) {
      const ids = scope.canonicalByAlias.get(alias) ?? new Set<string>()
      ids.add(canonicalId)
      scope.canonicalByAlias.set(alias, ids)
    }
    return { added: true, requiresRecount: false, settlementKey: canonicalId }
  }

  // Case 2: exactly one existing entry — plain alias registration, or the
  // retained position moves earlier.
  if (matchedCanonicalIds.size === 1) {
    const [canonicalId] = matchedCanonicalIds
    const stored = scope.entries.get(canonicalId)!
    for (const alias of allAliases) {
      if (!stored.aliases.has(alias)) {
        stored.aliases.add(alias)
        const ids = scope.canonicalByAlias.get(alias) ?? new Set<string>()
        ids.add(canonicalId)
        scope.canonicalByAlias.set(alias, ids)
      }
    }
    stored.occupantId ??= occupantId
    if (message) stored.message = stored.message ? backfillMessage(stored.message, message) : message
    const movedEarlier = compareExact(entry.position, stored.entry.position) < 0
    if (movedEarlier) stored.entry = { position: entry.position }
    return { added: false, requiresRecount: movedEarlier, settlementKey: canonicalId }
  }

  // Case 3: two or more existing entries are the same logical message —
  // coalesce them all into one survivor.
  const ids = [...matchedCanonicalIds]
  const unionAliases = new Set<string>(allAliases)
  let earliestPosition = entry.position
  let retainedOccupantId = occupantId
  let retainedMessage = message
  for (const id of ids) {
    const stored = scope.entries.get(id)!
    for (const alias of stored.aliases) unionAliases.add(alias)
    if (compareExact(stored.entry.position, earliestPosition) < 0) earliestPosition = stored.entry.position
    retainedOccupantId ??= stored.occupantId
    if (stored.message) retainedMessage = retainedMessage ? backfillMessage(stored.message, retainedMessage) : stored.message
  }

  const survivorId = ids[0]
  for (const id of ids) {
    const stored = scope.entries.get(id)
    if (!stored) continue
    for (const alias of stored.aliases) {
      const aliasIds = scope.canonicalByAlias.get(alias)
      aliasIds?.delete(id)
      if (aliasIds?.size === 0) scope.canonicalByAlias.delete(alias)
    }
    if (id !== survivorId) scope.entries.delete(id)
  }
  scope.entries.set(survivorId, {
    entry: { position: earliestPosition },
    aliases: unionAliases,
    occupantId: retainedOccupantId,
    message: retainedMessage,
  })
  for (const alias of unionAliases) {
    const aliasIds = scope.canonicalByAlias.get(alias) ?? new Set<string>()
    aliasIds.add(survivorId)
    scope.canonicalByAlias.set(alias, aliasIds)
  }

  return { added: false, requiresRecount: true, settlementKey: survivorId }
}

/**
 * Count entries strictly past the boundary — the overlay's contribution to
 * `unreadCount`. Iterates `entries` only (never the alias index), so each
 * logical message counts exactly once regardless of how many aliases it is
 * known under. An `undefined` boundary applies no read floor.
 * The optional visibility predicate filters entries with a retained message;
 * entries without one remain countable because their sender cannot be checked.
 */
export function transientCounts(
  key: ScopeKey, boundary: PointerOrder | undefined,
  isVisible?: (message: Message | RoomMessage) => boolean,
): { unread: number } {
  const scope = getScope(key)
  if (!scope) return { unread: 0 }
  let unread = 0
  for (const { entry, message } of scope.entries.values()) {
    if (message && isVisible && !isVisible(message)) continue
    if (boundary === undefined || isAfterBoundary(entry.position, boundary)) {
      unread++
    }
  }
  return { unread }
}

/**
 * Drop every entry at or behind the boundary (the read pointer has passed
 * them). A memory bound, not a correctness mechanism — {@link transientCounts}
 * already excludes them from the count without this ever being called.
 */
export function pruneTransient(key: ScopeKey, boundary: PointerOrder): { removed: number } {
  const scope = getScope(key)
  if (!scope) return { removed: 0 }
  let removed = 0
  for (const [canonicalId, stored] of scope.entries) {
    if (!isAfterBoundary(stored.entry.position, boundary)) {
      scope.entries.delete(canonicalId)
      for (const alias of stored.aliases) {
        const ids = scope.canonicalByAlias.get(alias)
        ids?.delete(canonicalId)
        if (ids?.size === 0) scope.canonicalByAlias.delete(alias)
      }
      removed++
    }
  }
  return { removed }
}

/**
 * Remove entries resolved by a settlement key or message identity. A message's
 * aliases locate candidates, then `matchingEntries` applies the identity guards;
 * an ambiguous chat copy leaves conflicting twins intact. Reports whether an
 * entry went away so the caller can schedule a recount.
 */
export function removeTransient(key: ScopeKey, source: string | Message | RoomMessage, occupantId?: string): { removed: boolean } {
  const message = typeof source === 'string' ? undefined : source
  if (message && (message.type === 'chat'
    ? key.kind !== 'chat' || key.entityId !== message.conversationId
    : key.kind !== 'room' || key.entityId !== message.roomJid)) return { removed: false }
  const aliases = typeof source === 'string' ? [source]
    : source.type === 'chat' ? transientAliases(source, 'chat') : transientAliases(source, 'room')
  if (message) occupantId = message.type === 'groupchat' ? message.occupantId : undefined
  const scope = getScope(key)
  if (!scope) return { removed: false }
  const canonicalIds = [...new Set(aliases.flatMap(alias => [...(scope.canonicalByAlias.get(alias) ?? [])]))]
  const candidates = canonicalIds
    .map((canonicalId) => ({ canonicalId, stored: scope.entries.get(canonicalId) }))
    .filter((candidate): candidate is { canonicalId: string; stored: StoredEntry } =>
      !!candidate.stored
    )
  const mergeable = new Set(matchingEntries(message, occupantId, candidates.map(({ stored }) => stored)) ?? [])
  const removable = candidates.filter(({ stored }) => mergeable.has(stored))
  let removed = false
  for (const { canonicalId, stored } of removable) {
    scope.entries.delete(canonicalId)
    for (const storedAlias of stored.aliases) {
      const ids = scope.canonicalByAlias.get(storedAlias)
      ids?.delete(canonicalId)
      if (ids?.size === 0) scope.canonicalByAlias.delete(storedAlias)
    }
    removed = true
  }
  return { removed }
}

/** Drop every scope for an account. Account teardown / scope switch ONLY — never on deactivation. */
export function clearTransientScope(accountScope: string): void {
  const prefix = `${accountScope}${SEP}`
  for (const k of scopes.keys()) {
    if (k.startsWith(prefix)) scopes.delete(k)
  }
}

export function clearTransientEntity(key: ScopeKey): void {
  scopes.delete(scopeKeyString(key))
}

/**
 * Test-only: drop every scope, across every account. This module's state is a
 * plain top-level `Map` — it is not part of any Zustand store, so resetting a
 * store's state between tests does not touch it. Now that chatStore/roomStore
 * genuinely wire `noteTransient` into the live message path, a test
 * fixture reusing the same message id/room across `it()` blocks would
 * otherwise find it already noted from an earlier test and see `added: false`
 * where the test expects `true`.
 */
export function _clearAllTransientForTesting(): void {
  scopes.clear()
}
