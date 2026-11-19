import { createStore } from 'zustand/vanilla'
import { savedMessageKeys } from '../utils/savedMessageKeys'
import type { SavedMessage, SavedPendingOp } from '../core/types/saved'

/**
 * Saved messages of the connected account (docs/XEP-SAVED_MESSAGES.md).
 *
 * The list shown is `entries`. Local saves and removals apply at once and wait
 * in `pending` until the server has taken them, so a save made while offline
 * shows immediately and is sent on reconnect. Only an answered fetch replaces
 * the list, and it keeps whatever is still pending.
 *
 * @category Stores
 */
export interface SavedState {
  entries: Record<string, SavedMessage>
  /** Operations not yet confirmed by the server, by item id. */
  pending: Record<string, SavedPendingOp>
  /** True once a fetch was answered in this session; false means the list may be incomplete. */
  loaded: boolean
  /** The node's effective item limit, when known. */
  limit: number | undefined
  /** The server refused to store the last entry (counts up so a view can react once per refusal). */
  refusals: number

  /** Save an entry (replaces an entry naming the same message). Returns false at the server limit. */
  save: (entry: SavedMessage) => boolean
  remove: (id: string) => void
  /** The original was retracted or moderated: drop the text and republish. */
  markDeleted: (id: string) => void
  /** Replace the list with an answered fetch, keeping pending operations. */
  reconcileFetch: (entries: SavedMessage[]) => void
  /** Apply a `+notify` event, leaving ids with a pending local operation alone. */
  applyNotify: (update: { upserts: SavedMessage[]; removedIds: string[] }) => void
  /** The server took (or no longer needs) the operation for this id. */
  settle: (id: string, op: SavedPendingOp) => void
  setLimit: (limit: number | undefined) => void
  /** The server definitively refused this operation: undo a refused save, note the refusal. */
  refuse: (id: string, op: SavedPendingOp) => void
  reset: () => void
}

const initial = { entries: {}, pending: {}, loaded: false, limit: undefined, refusals: 0 }

/** Is this message already saved (by any of its identities)? */
export function findSavedEntry(entries: Record<string, SavedMessage>, probe: Pick<SavedMessage, 'conversationJid' | 'stanzaId' | 'stanzaIdBy' | 'originId' | 'messageId'>): SavedMessage | undefined {
  const keys = new Set(savedMessageKeys(probe))
  if (keys.size === 0) return undefined
  return Object.values(entries).find((entry) => savedMessageKeys(entry).some((key) => keys.has(key)))
}

/**
 * Entries naming the same message are shown once: keep the one with an archive id
 * (the stronger identity), else the earlier save, and report the rest to retract.
 */
function dedupe(entries: Record<string, SavedMessage>): { entries: Record<string, SavedMessage>; weaker: string[] } {
  const owner = new Map<string, string>()
  const weaker: string[] = []
  const ordered = Object.values(entries).sort((a, b) =>
    Number(Boolean(b.stanzaId)) - Number(Boolean(a.stanzaId)) || a.savedAt - b.savedAt || a.id.localeCompare(b.id))
  const kept: Record<string, SavedMessage> = {}
  for (const entry of ordered) {
    const keys = savedMessageKeys(entry)
    if (keys.some((key) => owner.has(key))) { weaker.push(entry.id); continue }
    keys.forEach((key) => owner.set(key, entry.id))
    kept[entry.id] = entry
  }
  return { entries: kept, weaker }
}

export const savedStore = createStore<SavedState>()((set, get) => ({
  ...initial,

  save: (entry) => {
    const state = get()
    const existing = findSavedEntry(state.entries, entry)
    if (existing) return true
    if (state.limit !== undefined && Object.keys(state.entries).length >= state.limit) return false
    set({ entries: { ...state.entries, [entry.id]: entry }, pending: { ...state.pending, [entry.id]: 'publish' } })
    return true
  },

  remove: (id) => {
    const { entries, pending } = get()
    if (!entries[id]) return
    const next = { ...entries }
    delete next[id]
    set({ entries: next, pending: { ...pending, [id]: 'retract' } })
  },

  markDeleted: (id) => {
    const { entries, pending } = get()
    const entry = entries[id]
    if (!entry || (!entry.text && !entry.encrypted)) return
    set({ entries: { ...entries, [id]: { ...entry, text: '', encrypted: undefined } }, pending: { ...pending, [id]: 'publish' } })
  },

  reconcileFetch: (fetched) => {
    const { entries, pending } = get()
    const merged: Record<string, SavedMessage> = {}
    for (const entry of fetched) if (pending[entry.id] !== 'retract') merged[entry.id] = entry
    for (const [id, op] of Object.entries(pending)) {
      if (op === 'publish' && entries[id]) merged[id] = entries[id]
    }
    const { entries: unique, weaker } = dedupe(merged)
    const nextPending = { ...pending }
    for (const id of weaker) if (nextPending[id] === undefined) nextPending[id] = 'retract'
    set({ entries: unique, pending: nextPending, loaded: true })
  },

  applyNotify: ({ upserts, removedIds }) => {
    const { entries, pending } = get()
    const next = { ...entries }
    for (const id of removedIds) if (pending[id] === undefined) delete next[id]
    for (const entry of upserts) if (pending[entry.id] === undefined) next[entry.id] = entry
    const { entries: unique, weaker } = dedupe(next)
    const nextPending = { ...pending }
    for (const id of weaker) if (nextPending[id] === undefined) nextPending[id] = 'retract'
    set({ entries: unique, pending: nextPending })
  },

  settle: (id, op) => {
    const { pending } = get()
    if (pending[id] !== op) return
    const next = { ...pending }
    delete next[id]
    set({ pending: next })
  },

  setLimit: (limit) => set({ limit }),

  refuse: (id, op) => {
    const { entries, pending, refusals } = get()
    if (pending[id] !== op) return
    const nextPending = { ...pending }
    delete nextPending[id]
    if (op === 'publish') {
      const next = { ...entries }
      delete next[id]
      set({ entries: next, pending: nextPending, refusals: refusals + 1 })
    } else {
      set({ pending: nextPending })
    }
  },

  reset: () => set({ ...initial }),
}))
