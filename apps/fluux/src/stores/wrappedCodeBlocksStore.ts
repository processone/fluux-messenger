import { create } from 'zustand'

/**
 * Identity of a message for session UI state that must survive archive
 * enrichment (see {@link wrapIdentityMatches}). `scope`, `id`, `from` and
 * `instant` are fixed from the first render; the other three may be learned later.
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

/**
 * Two identities are the same message when the fixed fields are equal and every
 * late field known to both agrees. A field known to one side only is treated as
 * not yet learned, so archive backfill (which supplies stanzaId or originId
 * later) keeps the choice, while two messages whose known ids differ stay apart.
 */
export function wrapIdentityMatches(a: WrapIdentity, b: WrapIdentity): boolean {
  if (a.scope !== b.scope || a.id !== b.id || a.from !== b.from || a.instant !== b.instant) return false
  return LATE_FIELDS.every((f) => a[f] === undefined || b[f] === undefined || a[f] === b[f])
}

/** The same identity with any late field it lacked taken from `other`. */
function learn(known: WrapIdentity, other: WrapIdentity): WrapIdentity {
  let learned = known
  for (const f of LATE_FIELDS) {
    if (known[f] === undefined && other[f] !== undefined) learned = { ...learned, [f]: other[f] }
  }
  return learned
}

interface WrapEntry {
  identity: WrapIdentity
  blocks: ReadonlySet<number>
}

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

  /** Record ids the message has learned since a choice was stored, so twins are told apart from then on */
  claim: (identity: WrapIdentity) => void

  /** Clear all wrapped states */
  clear: () => void
}

export const useWrappedCodeBlocksStore = create<WrappedCodeBlocksState>((set, get) => ({
  entries: [],

  toggle: (identity, blockIndex) => {
    set(({ entries }) => {
      const at = entries.findIndex((e) => wrapIdentityMatches(e.identity, identity))
      if (at === -1) return { entries: [...entries, { identity, blocks: new Set([blockIndex]) }] }
      const blocks = new Set(entries[at].blocks)
      if (!blocks.delete(blockIndex)) blocks.add(blockIndex)
      const next = entries.slice()
      if (blocks.size === 0) next.splice(at, 1)
      else next[at] = { identity: learn(entries[at].identity, identity), blocks }
      return { entries: next }
    })
  },

  isWrapped: (identity, blockIndex) =>
    get().entries.some((e) => e.blocks.has(blockIndex) && wrapIdentityMatches(e.identity, identity)),

  countFor: (identity) =>
    get().entries.reduce((n, e) => n + (wrapIdentityMatches(e.identity, identity) ? e.blocks.size : 0), 0),

  claim: (identity) => {
    const { entries } = get()
    let changed = false
    const next = entries.map((e) => {
      if (!wrapIdentityMatches(e.identity, identity)) return e
      const learned = learn(e.identity, identity)
      if (learned === e.identity) return e
      changed = true
      return { ...e, identity: learned }
    })
    if (changed) set({ entries: next })
  },

  clear: () => set({ entries: [] }),
}))
