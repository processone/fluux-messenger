import { createStore } from 'zustand/vanilla'
import { sameSavedMessage, savedCandidateKeys } from '../utils/savedMessageKeys'
import { buildScopedStorageKey } from '../utils/storageScope'
import type { SavedIdentity } from '../utils/savedMessageKeys'
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
  /** Bumped on every local change to an id's operation, so a late acknowledgement of an older one is ignored. */
  revisions: Record<string, number>
  /** True once a fetch was answered in this session; false means the list may be incomplete. */
  loaded: boolean
  /** The node's effective item limit, when known. */
  limit: number | undefined
  /** The queue stored for this account has been merged in. */
  hydrated: boolean
  /** The server refused to store the last entry (counts up so a view can react once per refusal). */
  refusals: number

  /** Save an entry (replaces an entry naming the same message). Returns false at the server limit. */
  save: (entry: SavedMessage) => boolean
  remove: (id: string) => void
  /** The original was retracted or moderated: drop the text and republish. */
  markDeleted: (id: string) => void
  /** Replace the list with an answered fetch, keeping pending operations and the ids in `keepCurrent` (changed since the fetch began). */
  reconcileFetch: (entries: SavedMessage[], keepCurrent?: ReadonlySet<string>) => void
  /** Apply a `+notify` event, leaving ids with a pending local operation alone. */
  applyNotify: (update: { upserts: SavedMessage[]; removedIds: string[] }) => void
  /** The server took (or no longer needs) the operation for this id. */
  settle: (id: string, op: SavedPendingOp, revision?: number) => void
  setLimit: (limit: number | undefined) => void
  /** The server definitively refused this operation: undo a refused save, note the refusal. */
  refuse: (id: string, op: SavedPendingOp, revision?: number) => void
  /** Merge the queue stored by an earlier session of this account (local operations win). */
  hydratePending: () => void
  reset: () => void
}

const PENDING_KEY = 'fluux-saved-pending'

/** What survives a reload: the unsent operations and the entries still to publish. */
interface StoredQueue { pending: Record<string, SavedPendingOp>; entries: Record<string, SavedMessage> }

function readQueue(): StoredQueue | null {
  try {
    const raw = localStorage.getItem(buildScopedStorageKey(PENDING_KEY))
    if (!raw) return null
    const parsed = JSON.parse(raw) as StoredQueue
    return parsed && typeof parsed.pending === 'object' && parsed.pending ? { pending: parsed.pending, entries: parsed.entries ?? {} } : null
  } catch { return null }
}

function writeQueue(state: Pick<SavedState, 'pending' | 'entries'>): void {
  try {
    const key = buildScopedStorageKey(PENDING_KEY)
    if (Object.keys(state.pending).length === 0) { localStorage.removeItem(key); return }
    const entries: Record<string, SavedMessage> = {}
    for (const [id, op] of Object.entries(state.pending)) if (op === 'publish' && state.entries[id]) entries[id] = state.entries[id]
    localStorage.setItem(key, JSON.stringify({ pending: state.pending, entries } satisfies StoredQueue))
  } catch { /* storage unavailable: the queue stays in memory only */ }
}

const initial = { entries: {}, pending: {}, revisions: {}, loaded: false, limit: undefined, refusals: 0, hydrated: false }

/** Is this message already saved (by any of its identities)? */
export function findSavedEntry(entries: Record<string, SavedMessage>, probe: SavedIdentity): SavedMessage | undefined {
  return Object.values(entries).find((entry) => sameSavedMessage(entry, probe))
}

/**
 * Entries naming the same message are shown once: keep the one with an archive id
 * (the stronger identity), else the earlier save, and report the rest to retract.
 */
function dedupe(entries: Record<string, SavedMessage>): { entries: Record<string, SavedMessage>; weaker: string[] } {
  const byKey = new Map<string, SavedMessage[]>()
  const weaker: string[] = []
  const ordered = Object.values(entries).sort((a, b) =>
    Number(Boolean(b.stanzaId)) - Number(Boolean(a.stanzaId)) || a.savedAt - b.savedAt || a.id.localeCompare(b.id))
  const kept: Record<string, SavedMessage> = {}
  for (const entry of ordered) {
    const keys = savedCandidateKeys(entry)
    const twin = keys.flatMap((key) => byKey.get(key) ?? []).find((other) => sameSavedMessage(other, entry))
    if (twin) { weaker.push(entry.id); continue }
    for (const key of keys) byKey.set(key, [...(byKey.get(key) ?? []), entry])
    kept[entry.id] = entry
  }
  return { entries: kept, weaker }
}

const bump = (revisions: Record<string, number>, id: string) => ({ ...revisions, [id]: (revisions[id] ?? 0) + 1 })

/**
 * The original of a saved message was retracted or moderated (validated and
 * stored by the durable retraction path): drop the saved text and republish.
 */
export function redactSavedCopy(probe: SavedIdentity): void {
  const hit = findSavedEntry(savedStore.getState().entries, probe)
  if (hit) savedStore.getState().markDeleted(hit.id)
}

export const savedStore = createStore<SavedState>()((set, get) => ({
  ...initial,

  save: (entry) => {
    get().hydratePending()
    const state = get()
    const existing = findSavedEntry(state.entries, entry)
    if (existing) return true
    if (state.limit !== undefined && Object.keys(state.entries).length >= state.limit) return false
    set({ entries: { ...state.entries, [entry.id]: entry }, pending: { ...state.pending, [entry.id]: 'publish' }, revisions: bump(state.revisions, entry.id) })
    return true
  },

  remove: (id) => {
    get().hydratePending()
    const { entries, pending, revisions } = get()
    if (!entries[id]) return
    const next = { ...entries }
    delete next[id]
    set({ entries: next, pending: { ...pending, [id]: 'retract' }, revisions: bump(revisions, id) })
  },

  markDeleted: (id) => {
    get().hydratePending()
    const { entries, pending, revisions } = get()
    const entry = entries[id]
    if (!entry || entry.deleted) return
    set({ entries: { ...entries, [id]: { ...entry, text: '', encrypted: undefined, deleted: true } }, pending: { ...pending, [id]: 'publish' }, revisions: bump(revisions, id) })
  },

  reconcileFetch: (fetched, keepCurrent = new Set<string>()) => {
    const { entries, pending } = get()
    const merged: Record<string, SavedMessage> = {}
    for (const entry of fetched) if (pending[entry.id] !== 'retract' && !keepCurrent.has(entry.id)) merged[entry.id] = entry
    for (const id of keepCurrent) if (entries[id]) merged[id] = entries[id]
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

  settle: (id, op, revision) => {
    const { pending, revisions } = get()
    if (pending[id] !== op || (revision !== undefined && revisions[id] !== revision)) return
    const next = { ...pending }
    delete next[id]
    set({ pending: next })
  },

  setLimit: (limit) => set({ limit }),

  hydratePending: () => {
    if (get().hydrated) return
    const stored = readQueue()
    const { entries, pending } = get()
    if (!stored) { set({ hydrated: true }); return }
    const nextEntries = { ...entries }
    const nextPending = { ...pending }
    let nextRevisions = get().revisions
    for (const [id, op] of Object.entries(stored.pending)) {
      if (nextPending[id] !== undefined) continue
      nextPending[id] = op
      nextRevisions = bump(nextRevisions, id)
      if (op === 'retract') delete nextEntries[id]
      else if (stored.entries[id]) nextEntries[id] = stored.entries[id]
    }
    set({ entries: nextEntries, pending: nextPending, revisions: nextRevisions, hydrated: true })
  },

  refuse: (id, op, revision) => {
    const { entries, pending, refusals, revisions } = get()
    if (pending[id] !== op || (revision !== undefined && revisions[id] !== revision)) return
    const nextPending = { ...pending }
    delete nextPending[id]
    if (op === 'publish') {
      const next = { ...entries }
      delete next[id]
      set({ entries: next, pending: nextPending, refusals: refusals + 1 })
    } else {
      // The server kept the item: a later fetch brings it back; tell the person once.
      set({ pending: nextPending, refusals: refusals + 1 })
    }
  },

  reset: () => set({ ...initial }),
}))

// Keep the unsent queue on disk, so a save or removal made offline survives a reload.
savedStore.subscribe((state, previous) => {
  if (state.hydrated && (state.pending !== previous.pending || (state.hydrated && !previous.hydrated))) writeQueue(state)
})
