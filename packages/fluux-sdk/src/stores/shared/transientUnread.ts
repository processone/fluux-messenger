import { compareExact, isAfterBoundary, type ExactPosition, type PointerOrder } from './readState'
import { roomCanonicalKey, roomIdentityKeys, type RoomIdentityFields } from '../../utils/roomMessageIdentity'

/**
 * Transient overlay for `noLocalStore` messages (MUC ephemera, Quick Chat):
 * messages that are never written to IndexedDB but must still count as
 * unread. `unreadCount` is derived from the archive (see `readState.ts`),
 * but an archive-only count silently erases these messages — they have no
 * row to scan. This overlay holds them in memory, position-aware, so Tasks
 * 7/8 can add its contribution on top of the archive-derived count:
 * `unread = min(999, archive.unread + transient.unread)`.
 *
 * Scoped by `{accountScope, kind, entityId}` (never a bare `entityId` — that
 * would leak counts across accounts sharing the same room/chat id).
 *
 * Room identity is NOT reimplemented here. It delegates to B0's tiered
 * identity (`roomMessageIdentity.ts`): stanzaId → originId → from+id. A
 * `from+id`-only key would double-count a message once a stanza id arrives
 * on a later copy, and would fail a retraction that references the stanza id
 * only. So every entry is stored once, under its canonical (highest-tier)
 * key, indexed by every alias tier it carries — see the two-structure
 * storage shape below.
 *
 * Entries are NEVER cleared on deactivation: clearing when the user
 * switches away (while scrolled up) would silently drop unread. An entry
 * leaves only when the read pointer passes it ({@link pruneTransient}), the
 * message is retracted/removed ({@link removeTransient}), or the account is
 * torn down ({@link clearTransientScope}). Because {@link transientCounts}
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
}

/** One logical message: its position, plus every alias tier it is known under. */
interface StoredEntry {
  entry: TransientEntry
  aliases: Set<string>
}

/** Per-scope storage. Two structures, not one — see module doc. */
interface TransientScope {
  /** canonicalId -> stored entry. The ONLY thing iterated for counting/pruning. */
  entries: Map<string, StoredEntry>
  /** any alias -> canonicalId. Resolution and retraction lookup only — never iterated for counting. */
  canonicalByAlias: Map<string, string>
}

// U+0000 separator: account scopes/kinds/entity ids cannot contain it, so joins never collide.
const SEP = String.fromCharCode(0)

const scopes = new Map<string, TransientScope>()

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

/**
 * The canonical identity for a transient entry. Delegates entirely to B0's
 * room identity for rooms (the highest-tier key present); chat has no tiers,
 * so its identity is the bare message id.
 */
export function transientIdentity(msg: RoomIdentityFields, kind: 'room'): string
export function transientIdentity(msg: { id: string }, kind: 'chat'): string
export function transientIdentity(msg: RoomIdentityFields | { id: string }, kind: 'room' | 'chat'): string {
  return kind === 'room' ? roomCanonicalKey(msg as RoomIdentityFields) : (msg as { id: string }).id
}

/**
 * Every identity tier a message is known under (most-specific first for
 * rooms). Chat has exactly one tier: its id.
 */
export function transientAliases(msg: RoomIdentityFields, kind: 'room'): string[]
export function transientAliases(msg: { id: string }, kind: 'chat'): string[]
export function transientAliases(msg: RoomIdentityFields | { id: string }, kind: 'room' | 'chat'): string[] {
  return kind === 'room' ? roomIdentityKeys(msg as RoomIdentityFields) : [(msg as { id: string }).id]
}

/**
 * Note a transient (never-archived) message. Resolves every supplied alias
 * through `canonicalByAlias`:
 *
 * - none resolve → brand-new logical entry, stored under `identity`.
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
 */
export function noteTransient(key: ScopeKey, entry: TransientEntry, identity: string, aliases?: string[]): NoteTransientResult {
  const scope = getOrCreateScope(key)
  const allAliases = new Set(aliases ?? [])
  allAliases.add(identity)

  const matchedCanonicalIds = new Set<string>()
  for (const alias of allAliases) {
    const canonicalId = scope.canonicalByAlias.get(alias)
    if (canonicalId !== undefined) matchedCanonicalIds.add(canonicalId)
  }

  // Case 1: brand-new logical entry.
  if (matchedCanonicalIds.size === 0) {
    scope.entries.set(identity, { entry: { position: entry.position }, aliases: new Set(allAliases) })
    for (const alias of allAliases) scope.canonicalByAlias.set(alias, identity)
    return { added: true, requiresRecount: false }
  }

  // Case 2: exactly one existing entry — plain alias registration, or the
  // retained position moves earlier.
  if (matchedCanonicalIds.size === 1) {
    const [canonicalId] = matchedCanonicalIds
    const stored = scope.entries.get(canonicalId)!
    for (const alias of allAliases) {
      if (!stored.aliases.has(alias)) {
        stored.aliases.add(alias)
        scope.canonicalByAlias.set(alias, canonicalId)
      }
    }
    const movedEarlier = compareExact(entry.position, stored.entry.position) < 0
    if (movedEarlier) stored.entry = { position: entry.position }
    return { added: false, requiresRecount: movedEarlier }
  }

  // Case 3: two or more existing entries are the same logical message —
  // coalesce them all into one survivor.
  const ids = [...matchedCanonicalIds]
  const unionAliases = new Set<string>(allAliases)
  let earliestPosition = entry.position
  for (const id of ids) {
    const stored = scope.entries.get(id)!
    for (const alias of stored.aliases) unionAliases.add(alias)
    if (compareExact(stored.entry.position, earliestPosition) < 0) earliestPosition = stored.entry.position
  }

  const survivorId = ids[0]
  for (const id of ids) if (id !== survivorId) scope.entries.delete(id)
  scope.entries.set(survivorId, { entry: { position: earliestPosition }, aliases: unionAliases })
  for (const alias of unionAliases) scope.canonicalByAlias.set(alias, survivorId)

  return { added: false, requiresRecount: true }
}

/**
 * Count entries strictly past the boundary — the overlay's contribution to
 * `unreadCount`. Iterates `entries` only (never the alias index), so each
 * logical message counts exactly once regardless of how many aliases it is
 * known under. A `undefined` boundary counts everything (no floor yet).
 */
export function transientCounts(key: ScopeKey, boundary: PointerOrder | undefined): { unread: number } {
  const scope = getScope(key)
  if (!scope) return { unread: 0 }
  let unread = 0
  for (const { entry } of scope.entries.values()) {
    if (boundary === undefined || isAfterBoundary(entry.position, boundary)) unread++
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
      for (const alias of stored.aliases) scope.canonicalByAlias.delete(alias)
      removed++
    }
  }
  return { removed }
}

/**
 * Remove the entry an alias resolves to (retraction/removal). Accepts ANY
 * alias tier — a retraction referencing only a stanza-id still resolves to
 * the entry stored under its canonical (possibly different) key. Reports
 * whether an entry actually went away so the caller can schedule a recount.
 */
export function removeTransient(key: ScopeKey, alias: string): { removed: boolean } {
  const scope = getScope(key)
  if (!scope) return { removed: false }
  const canonicalId = scope.canonicalByAlias.get(alias)
  if (canonicalId === undefined) return { removed: false }
  const stored = scope.entries.get(canonicalId)
  scope.entries.delete(canonicalId)
  if (stored) for (const a of stored.aliases) scope.canonicalByAlias.delete(a)
  else scope.canonicalByAlias.delete(alias)
  return { removed: true }
}

/** Drop every scope for an account. Account teardown / scope switch ONLY — never on deactivation. */
export function clearTransientScope(accountScope: string): void {
  const prefix = `${accountScope}${SEP}`
  for (const k of scopes.keys()) {
    if (k.startsWith(prefix)) scopes.delete(k)
  }
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
