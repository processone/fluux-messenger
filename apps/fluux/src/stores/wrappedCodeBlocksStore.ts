import { create } from 'zustand'

/**
 * Identity of a message for session UI state. `scope`, `id`, `from` and
 * `instant` are fixed from the first render; the other three may be learned
 * later, which a mounted message reports through `promote`.
 */
export interface WrapIdentity {
  scope: string | null
  id: string
  from: string | null
  /** Room receipt instant (ms), null for direct chats */
  instant: number | null
  originId?: string
  occupantId?: string
  stanzaId?: string
}

const LATE_FIELDS = ['originId', 'occupantId', 'stanzaId'] as const

/** Strict equality: every field, late ones included, must be the same. */
export function sameWrapIdentity(a: WrapIdentity, b: WrapIdentity): boolean {
  return a.scope === b.scope && a.id === b.id && a.from === b.from && a.instant === b.instant &&
    LATE_FIELDS.every((f) => a[f] === b[f])
}

/**
 * Whether `to` is `from` after archive backfill: same fixed fields, and every late
 * id `from` already had is unchanged (ids may only be added, never changed).
 */
export function isWrapIdentityEnrichment(from: WrapIdentity, to: WrapIdentity): boolean {
  return from.scope === to.scope && from.id === to.id && from.from === to.from && from.instant === to.instant &&
    LATE_FIELDS.every((f) => from[f] === undefined || from[f] === to[f])
}

interface WrapEntry {
  identity: WrapIdentity
  blocks: ReadonlySet<number>
  /**
   * Look-alike twins seen next to this message while it was in a list: same fixed fields,
   * different late ids. They are never this message's enriched self, whatever they learn later.
   */
  siblings?: readonly WrapIdentity[]
}

const sameFixedFields = (a: WrapIdentity, b: WrapIdentity) =>
  a.scope === b.scope && a.id === b.id && a.from === b.from && a.instant === b.instant
const includesIdentity = (list: readonly WrapIdentity[], identity: WrapIdentity) =>
  list.some((candidate) => sameWrapIdentity(candidate, identity))

/**
 * Tracks which code blocks the user switched to "Wrap lines" (display only).
 *
 * In-memory only, like expandedMessagesStore: the choice survives scrolling
 * and switching conversations within the session and resets on restart or
 * account change. A block is identified by its message identity and its
 * position among that message's code blocks, so two blocks in one message wrap
 * independently.
 */
interface WrappedCodeBlocksState {
  entries: readonly WrapEntry[]

  /** Flip the wrapped state of one code block */
  toggle: (identity: WrapIdentity, blockIndex: number) => void

  /** Check whether a code block is wrapped */
  isWrapped: (identity: WrapIdentity, blockIndex: number) => boolean

  /** Number of wrapped blocks in a message (changes whenever one is toggled) */
  countFor: (identity: WrapIdentity) => number

  /**
   * A mounted message learned ids from archive backfill: its stored choice follows it.
   * Only that exact identity moves, and only through an enrichment of the same
   * occurrence, so a twin that merely looks like it is never handed the choice.
   */
  promote: (from: WrapIdentity, to: WrapIdentity) => void

  /**
   * A conversation's list became resident (or changed) carrying the given identities, which are
   * only those sharing a fixed-field key with a stored choice. For each stored choice of `scope`:
   *  - if the message is in the list as stored, its look-alike twins are remembered as siblings;
   *  - if it is absent, the choice follows the one identity in the list that is an enrichment of
   *    it and is neither a remembered sibling nor claimed by another choice. Zero or several such
   *    identities leave the choice where it is: the list cannot say which copy is the original.
   * This is how a choice survives a chat switch that evicts the list and an enrichment that
   * arrives while the message is off screen.
   */
  reconcile: (scope: string, identities: readonly WrapIdentity[]) => void

  /** Clear all wrapped states */
  clear: () => void
}

export const useWrappedCodeBlocksStore = create<WrappedCodeBlocksState>((set, get) => ({
  entries: [],

  toggle: (identity, blockIndex) => {
    set(({ entries }) => {
      const at = entries.findIndex((e) => sameWrapIdentity(e.identity, identity))
      if (at === -1) return { entries: [...entries, { identity, blocks: new Set([blockIndex]) }] }
      const blocks = new Set(entries[at].blocks)
      if (!blocks.delete(blockIndex)) blocks.add(blockIndex)
      const next = entries.slice()
      if (blocks.size === 0) next.splice(at, 1)
      else next[at] = { ...entries[at], blocks }
      return { entries: next }
    })
  },

  isWrapped: (identity, blockIndex) =>
    get().entries.some((e) => e.blocks.has(blockIndex) && sameWrapIdentity(e.identity, identity)),

  countFor: (identity) =>
    get().entries.reduce((n, e) => n + (sameWrapIdentity(e.identity, identity) ? e.blocks.size : 0), 0),

  promote: (from, to) => {
    if (!isWrapIdentityEnrichment(from, to) || sameWrapIdentity(from, to)) return
    set(({ entries }) => {
      const at = entries.findIndex((e) => sameWrapIdentity(e.identity, from))
      if (at === -1) return { entries }
      const existing = entries.findIndex((e) => sameWrapIdentity(e.identity, to))
      const next = entries.slice()
      if (existing === -1) next[at] = { ...entries[at], identity: to }
      else {
        next[existing] = { ...entries[existing], identity: to, blocks: new Set([...entries[existing].blocks, ...entries[at].blocks]) }
        next.splice(at, 1)
      }
      return { entries: next }
    })
  },

  reconcile: (scope, identities) => {
    set(({ entries }) => {
      const claims = new Map<WrapIdentity, number>()
      const present = (e: WrapEntry) => identities.some((i) => sameWrapIdentity(i, e.identity))
      const successor = (e: WrapEntry): WrapIdentity | null => {
        if (e.identity.scope !== scope || present(e)) return null
        const fresh = identities.filter((i) =>
          isWrapIdentityEnrichment(e.identity, i) && !includesIdentity(e.siblings ?? [], i) &&
          !entries.some((other) => sameWrapIdentity(other.identity, i)))
        if (fresh.length !== 1) return null
        claims.set(fresh[0], (claims.get(fresh[0]) ?? 0) + 1)
        return fresh[0]
      }
      const successors = entries.map(successor)
      let changed = false
      const next = entries.map((e, index): WrapEntry => {
        if (e.identity.scope !== scope) return e
        const to = successors[index]
        if (to && claims.get(to) === 1) {
          changed = true
          return { ...e, identity: to, siblings: (e.siblings ?? []).filter((s) => !sameWrapIdentity(s, to)) }
        }
        if (!present(e)) return e
        const known = e.siblings ?? []
        const learned = identities.filter((i) => sameFixedFields(i, e.identity) && !sameWrapIdentity(i, e.identity) && !includesIdentity(known, i))
        if (learned.length === 0) return e
        changed = true
        return { ...e, siblings: [...known, ...learned] }
      })
      return changed ? { entries: next } : { entries }
    })
  },

  clear: () => set({ entries: [] }),
}))
