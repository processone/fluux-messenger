import { createStore } from 'zustand/vanilla'
import { sameSavedMessage, savedCandidateKeys, savedItemId } from '../utils/savedMessageKeys'
import { buildScopedStorageKey, getStorageScopeJid } from '../utils/storageScope'
import { retractedAtForIdentity } from '../utils/retractedIdentities'
import { getBareJid } from '../core/jid'
import type { SavedIdentity } from '../utils/savedMessageKeys'
import { generateUUID } from '../utils/uuid'
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
  /** Item ids the server is known to hold (fetched, notified or acknowledged), whatever this device has queued. */
  remote: Record<string, true>
  /** Entries removed here whose retract the server has not yet taken, kept to restore them if it refuses. */
  removed: Record<string, SavedMessage>
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
  /** Counts up when a stored copy of a message was durably changed (an edit or a deletion), so rows read it again. */
  copyVersion: number
  /** Counts up on every reset, so work started before a wipe can tell it must not land. */
  generation: number
  /** OpenPGP sealing of entries (docs/XEP-SAVED_MESSAGES.md §7): `unavailable` means plain entries, `locked` means the list waits for the key. */
  sealState: 'unavailable' | 'locked' | 'ready'
  /** Items the server holds that this device cannot list yet because the key is not available. */
  lockedIds: Record<string, true>
  /** Plain entries being sealed, by the id of the sealed copy: the plain item stays on the server (and listed again if the copy is refused) until the copy is stored. */
  migrating: Record<string, SavedMessage>

  /** Save an entry (replaces an entry naming the same message). Returns false at the server limit. */
  save: (entry: SavedMessage) => boolean
  remove: (id: string) => void
  /** The original was retracted or moderated: drop the text and republish. */
  markDeleted: (id: string) => void
  /** Replace the list with an answered fetch, keeping pending operations and every id changed since {@link beginFetch}. */
  /** A fresh read of the node begins: its list is unknown until it lands, and changes from now on outrank its answer. */
  beginFetch: () => SavedFetch
  /** Land a read. A read that a reset or a newer owner outlived is dropped (returns false). */
  reconcileFetch: (entries: SavedMessage[], fetch?: SavedFetch, deleted?: ReadonlySet<string>, hidden?: SavedHidden) => boolean
  /** The read is over without landing (refused, unanswered or abandoned). */
  endFetch: (fetch: SavedFetch) => void
  /** Is this read still the one the store is waiting for? */
  fetchCurrent: (fetch: SavedFetch) => boolean
  /** The server took (or lost) this item, whatever this device has queued since. */
  confirm: (id: string, op: SavedPendingOp) => void
  /** Apply a `+notify` event, leaving ids with a pending local operation alone. */
  applyNotify: (update: { upserts: SavedMessage[]; removedIds: string[] }, deleted?: ReadonlySet<string>, hidden?: SavedHidden) => void
  /** The server took (or no longer needs) the operation for this id. */
  settle: (id: string, op: SavedPendingOp, revision?: number) => void
  setLimit: (limit: number | undefined) => void
  setSealState: (state: 'unavailable' | 'locked' | 'ready') => void
  /** Give a not yet published entry a new item id (a hash id made while OpenPGP was off must not reach the server). */
  reid: (oldId: string, newId: string) => void
  /** Re-save a plain entry sealed under a new id; the plain item is retracted only once the sealed copy is stored. */
  migrate: (id: string) => void
  /** The server definitively refused this operation: undo a refused save, note the refusal. */
  refuse: (id: string, op: SavedPendingOp, revision?: number, silent?: boolean) => void
  /** Merge the queue stored by an earlier session of this account (local operations win). */
  hydratePending: () => void
  reset: () => void
}

/** Items the server holds that are not listed: `locked` ones wait for the key, `rejected` ones failed the signature check. */
export interface SavedHidden { locked: string[]; rejected: string[] }

/** A fresh item id nobody can recompute from the message. */
export function randomSavedItemId(): string {
  return generateUUID().replace(/-/g, '')
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

const initial = { entries: {}, pending: {}, remote: {}, removed: {}, revisions: {}, loaded: false, limit: undefined, refusals: 0, hydrated: false, copyVersion: 0, generation: 0, sealState: 'unavailable' as const, lockedIds: {}, migrating: {} }

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

/** One in-flight read of the node: the ids changed since it began. Each read owns its own set. */
export type SavedFetch = Set<string>
const fetches = new Set<SavedFetch>()
const track = (id: string) => { for (const fetch of fetches) fetch.add(id) }

/**
 * Whether the original of this entry was retracted or moderated, as the durable
 * retraction ledger (validated, kept across restarts) knows. Covers a saved copy that
 * arrives (fetched, notified, replayed) after the retraction was processed.
 */
function originalWasRetracted(entry: SavedMessage, known?: ReadonlySet<string>): boolean {
  if (entry.deleted) return false
  if (known?.has(entry.id)) return true
  try {
    const own = (record: { actorJid: string; actorOccupantId?: string; moderation?: unknown; stanzaId?: string; originId?: string }) => {
      if (entry.stanzaId && record.stanzaId && entry.stanzaId !== record.stanzaId) return false
      if (entry.originId && record.originId && entry.originId !== record.originId) return false
      if (record.moderation) return true
      if (record.actorOccupantId && entry.occupantId) return record.actorOccupantId === entry.occupantId
      return entry.type === 'groupchat' ? record.actorJid === entry.from : getBareJid(record.actorJid) === getBareJid(entry.from)
    }
    const scope = { kind: entry.type === 'groupchat' ? 'room' as const : 'chat' as const, entityId: entry.conversationJid, accountScope: getStorageScopeJid() }
    return retractedAtForIdentity(scope, savedCandidateKeys(entry), own) !== undefined
  } catch { return false }
}

/** Incoming copies of retracted originals lose their text, and the cleared item is sent back. */
function redactRetracted(entries: SavedMessage[], known?: ReadonlySet<string>): { entries: SavedMessage[]; cleared: string[] } {
  const cleared: string[] = []
  const next = entries.map((entry) => {
    if (!originalWasRetracted(entry, known)) return entry
    cleared.push(entry.id)
    return { ...entry, text: '', encrypted: undefined, deleted: true as const }
  })
  return { entries: next, cleared }
}

const bump = (revisions: Record<string, number>, id: string) => ({ ...revisions, [id]: (revisions[id] ?? 0) + 1 })

/** A stored copy of a message was durably edited or retracted: saved rows read it again. */
export function noteSavedCopyChanged(): void {
  savedStore.setState((state) => ({ copyVersion: state.copyVersion + 1 }))
}

/**
 * The original of a saved message was retracted or moderated (validated and
 * stored by the durable retraction path): drop the saved text and republish.
 */
export function redactSavedCopy(probe: SavedIdentity): void {
  noteSavedCopyChanged()
  const hit = findSavedEntry(savedStore.getState().entries, probe)
  if (hit) savedStore.getState().markDeleted(hit.id)
}

/**
 * Forget saved messages and the unsent queue kept for them, when the person clears
 * local data: one account's, or every account's.
 */
export function clearSavedLocalData(jid: string | null, allAccounts: boolean): void {
  // The list in memory belongs to the connected account: another account's wipe leaves it alone.
  const current = getStorageScopeJid()
  if (allAccounts || !jid || !current || getBareJid(jid) === getBareJid(current)) savedStore.getState().reset()
  try {
    if (allAccounts) {
      for (const key of Object.keys(localStorage)) if (key === PENDING_KEY || key.startsWith(`${PENDING_KEY}:`)) localStorage.removeItem(key)
    } else if (jid) {
      localStorage.removeItem(buildScopedStorageKey(PENDING_KEY, jid))
    } else {
      // No account named (logout clears the session first): the queue of the account this device was last signed in to,
      // and one kept before accounts were told apart.
      localStorage.removeItem(buildScopedStorageKey(PENDING_KEY))
      localStorage.removeItem(PENDING_KEY)
    }
  } catch { /* storage unavailable */ }
}

export const savedStore = createStore<SavedState>()((set, get) => ({
  ...initial,

  save: (entryIn) => {
    get().hydratePending()
    const state = get()
    // With OpenPGP on the item id must not be a hash of the message identity, which the server can recompute.
    const entry = state.sealState !== 'unavailable' && entryIn.id === savedItemId(entryIn) ? { ...entryIn, id: randomSavedItemId() } : entryIn
    const existing = findSavedEntry(state.entries, entry)
    if (existing) return true
    if (state.limit !== undefined && Object.keys(state.entries).length >= state.limit) return false
    track(entry.id)
    set({ entries: { ...state.entries, [entry.id]: entry }, pending: { ...state.pending, [entry.id]: 'publish' }, revisions: bump(state.revisions, entry.id) })
    return true
  },

  remove: (id) => {
    get().hydratePending()
    const { entries, pending, revisions } = get()
    if (!entries[id]) return
    const next = { ...entries }
    delete next[id]
    track(id)
    const nextPending: Record<string, SavedPendingOp> = { ...pending, [id]: 'retract' }
    const nextRemoved = { ...get().removed, [id]: entries[id] }
    let nextMigrating = get().migrating
    let nextRevisions = bump(revisions, id)
    // A sealed copy still being stored stands for a plain item the person saved: removing it removes that item too.
    const plain = nextMigrating[id]
    if (plain) {
      nextMigrating = { ...nextMigrating }
      delete nextMigrating[id]
      track(plain.id)
      nextPending[plain.id] = 'retract'
      nextRemoved[plain.id] = plain
      nextRevisions = bump(nextRevisions, plain.id)
    }
    set({ entries: next, pending: nextPending, removed: nextRemoved, migrating: nextMigrating, revisions: nextRevisions })
  },

  markDeleted: (id) => {
    get().hydratePending()
    const { entries, pending, revisions } = get()
    const entry = entries[id]
    if (!entry || entry.deleted) return
    track(id)
    set({ entries: { ...entries, [id]: { ...entry, text: '', encrypted: undefined, deleted: true } }, pending: { ...pending, [id]: 'publish' }, revisions: bump(revisions, id) })
  },

  beginFetch: () => {
    // One read owns the store at a time: a newer read supersedes any older one still in flight.
    const fetch: SavedFetch = new Set()
    fetches.clear()
    fetches.add(fetch)
    set({ loaded: false })
    return fetch
  },

  fetchCurrent: (fetch) => fetches.has(fetch),

  endFetch: (fetch) => { fetches.delete(fetch) },

  confirm: (id, op) => {
    const { remote, removed } = get()
    const nextRemote = { ...remote }
    const nextRemoved = { ...removed }
    if (op === 'publish') nextRemote[id] = true
    else { delete nextRemote[id]; delete nextRemoved[id] }
    track(id)
    // The sealed copy of a migrated entry is stored: now the plain item can go.
    const plain = op === 'publish' ? get().migrating[id] : undefined
    if (plain) {
      const nextMigrating = { ...get().migrating }
      delete nextMigrating[id]
      track(plain.id)
      set({ remote: nextRemote, removed: { ...nextRemoved, [plain.id]: plain }, pending: { ...get().pending, [plain.id]: 'retract' }, revisions: bump(get().revisions, plain.id), migrating: nextMigrating })
      return
    }
    set({ remote: nextRemote, removed: nextRemoved })
  },

  reconcileFetch: (fetchedRaw, fetch, deleted, hidden) => {
    if (fetch && !fetches.has(fetch)) return false
    const keepCurrent = fetch ?? new Set<string>()
    if (fetch) fetches.delete(fetch)
    const { entries, pending, remote } = get()
    const { entries: fetched, cleared: clearedFetched } = redactRetracted(fetchedRaw, deleted)
    const cleared = [...clearedFetched]
    const merged: Record<string, SavedMessage> = {}
    const removedNow: Record<string, SavedMessage> = {}
    const heldBack = new Set(Object.values(get().migrating).map((plain) => plain.id)) // plain items being sealed: not listed twice
    for (const entry of fetched) {
      if (heldBack.has(entry.id)) continue
      // A removal this device queued: keep the server's copy to bring back if the server refuses it.
      if (pending[entry.id] === 'retract') { if (!get().removed[entry.id]) removedNow[entry.id] = entry }
      else if (!keepCurrent.has(entry.id)) merged[entry.id] = entry
    }
    for (const id of keepCurrent) if (entries[id]) merged[id] = entries[id]
    for (const [id, op] of Object.entries(pending)) {
      if (op !== 'publish' || !entries[id]) continue
      // A queued copy (one restored after a reload, say) of an original since deleted loses its text too.
      const [copy] = redactRetracted([entries[id]], deleted).entries
      if (copy.deleted && !entries[id].deleted) cleared.push(id)
      merged[id] = copy
    }
    const { entries: unique, weaker } = dedupe(merged)
    const nextPending = { ...pending }
    for (const id of weaker) if (nextPending[id] === undefined) nextPending[id] = 'retract'
    for (const id of cleared) if (unique[id] && nextPending[id] === undefined) nextPending[id] = 'publish'
    // What the server holds: its answer, except for ids that changed while it was in flight.
    const nextRemote: Record<string, true> = {}
    for (const entry of fetchedRaw) if (!keepCurrent.has(entry.id)) nextRemote[entry.id] = true
    // Items that are held but not listed still count against the node's limit.
    for (const id of [...(hidden?.locked ?? []), ...(hidden?.rejected ?? [])]) if (!keepCurrent.has(id)) nextRemote[id] = true
    for (const id of keepCurrent) if (remote[id]) nextRemote[id] = true
    const lockedIds: Record<string, true> = {}
    for (const id of hidden?.locked ?? []) lockedIds[id] = true
    set({ lockedIds, entries: unique, pending: nextPending, remote: nextRemote, loaded: true, revisions: cleared.reduce(bump, get().revisions), removed: { ...get().removed, ...removedNow } })
    return true
  },

  applyNotify: ({ upserts: upsertsRaw, removedIds }, deleted, hidden) => {
    const { entries, pending, remote } = get()
    const { entries: upserts, cleared } = redactRetracted(upsertsRaw, deleted)
    const next = { ...entries }
    const nextRemote = { ...remote }
    const nextLocked = { ...get().lockedIds }
    for (const id of removedIds) { track(id); delete nextRemote[id]; delete nextLocked[id]; if (pending[id] === undefined) delete next[id] }
    for (const id of [...(hidden?.locked ?? []), ...(hidden?.rejected ?? [])]) { track(id); nextRemote[id] = true; if (hidden?.locked.includes(id)) nextLocked[id] = true }
    const heldBack = new Set(Object.values(get().migrating).map((plain) => plain.id))
    for (const entry of upserts) { track(entry.id); nextRemote[entry.id] = true; if (pending[entry.id] === undefined && !heldBack.has(entry.id)) next[entry.id] = entry }
    const { entries: unique, weaker } = dedupe(next)
    const nextPending = { ...pending }
    for (const id of weaker) if (nextPending[id] === undefined) nextPending[id] = 'retract'
    for (const id of cleared) if (unique[id] && nextPending[id] === undefined) nextPending[id] = 'publish'
    set({ entries: unique, pending: nextPending, remote: nextRemote, lockedIds: nextLocked, revisions: cleared.reduce(bump, get().revisions) })
  },

  settle: (id, op, revision) => {
    const { pending, revisions, removed } = get()
    if (pending[id] !== op || (revision !== undefined && revisions[id] !== revision)) return
    const next = { ...pending }
    delete next[id]
    const nextRemoved = { ...removed }
    if (op === 'retract') delete nextRemoved[id]
    track(id)
    set({ pending: next, removed: nextRemoved })
  },

  setLimit: (limit) => set({ limit }),

  setSealState: (sealState) => { if (get().sealState !== sealState) set({ sealState }) },

  reid: (oldId, newId) => {
    const { entries, pending, revisions, remote } = get()
    const entry = entries[oldId]
    if (!entry || remote[oldId] || pending[oldId] !== 'publish' || entries[newId]) return
    const nextEntries = { ...entries }
    delete nextEntries[oldId]
    const nextPending = { ...pending }
    delete nextPending[oldId]
    track(oldId); track(newId)
    set({ entries: { ...nextEntries, [newId]: { ...entry, id: newId } }, pending: { ...nextPending, [newId]: 'publish' }, revisions: bump(revisions, newId) })
  },

  migrate: (id) => {
    const entry = get().entries[id]
    if (!entry?.unverified || get().sealState !== 'ready') return
    // No free slot at the node: the copy could not be stored beside the plain item, which stays as it is.
    const { limit, remote } = get()
    if (limit !== undefined && Object.keys(remote).length >= limit) return
    const { unverified: _unverified, ...sealed } = entry
    get().hydratePending()
    const { entries, pending, revisions, migrating } = get()
    const newId = randomSavedItemId()
    const next = { ...entries }
    delete next[id]
    track(id); track(newId)
    set({ entries: { ...next, [newId]: { ...sealed, id: newId } }, pending: { ...pending, [newId]: 'publish' }, migrating: { ...migrating, [newId]: entry }, revisions: bump(revisions, newId) })
  },

  hydratePending: () => {
    if (get().hydrated) return
    const stored = readQueue()
    const { entries, pending } = get()
    if (!stored) { set({ hydrated: true }); return }
    const nextEntries = { ...entries }
    const nextPending = { ...pending }
    let nextRevisions = get().revisions
    const removedNow: Record<string, SavedMessage> = {}
    for (const [id, op] of Object.entries(stored.pending)) {
      if (nextPending[id] !== undefined) continue
      nextPending[id] = op
      nextRevisions = bump(nextRevisions, id)
      if (op === 'retract') { if (nextEntries[id]) removedNow[id] = nextEntries[id]; delete nextEntries[id] }
      else if (stored.entries[id]) nextEntries[id] = redactRetracted([stored.entries[id]]).entries[0]
    }
    set({ entries: nextEntries, pending: nextPending, revisions: nextRevisions, removed: { ...get().removed, ...removedNow }, hydrated: true })
  },

  refuse: (id, op, revision, silent) => {
    const { entries, pending, refusals, revisions, remote, removed } = get()
    if (pending[id] !== op || (revision !== undefined && revisions[id] !== revision)) return
    const nextPending = { ...pending }
    delete nextPending[id]
    track(id)
    if (op === 'retract') {
      // The server kept the item: bring the row back and tell the person once.
      const restored = removed[id]
      const nextRemoved = { ...removed }
      delete nextRemoved[id]
      set({ pending: nextPending, removed: nextRemoved, refusals: refusals + 1, ...(restored && { entries: { ...entries, [id]: restored } }) })
    } else if (remote[id] || entries[id]?.deleted) {
      // An item the server already holds stays listed (a deleted one keeps its tombstone); only the change was refused.
      set({ pending: nextPending, refusals: refusals + 1 })
    } else if (get().migrating[id]) {
      // A refused sealed copy: the plain entry it was to replace is still on the server, and listed again.
      const plain = get().migrating[id]
      const next = { ...entries, [plain.id]: plain }
      delete next[id]
      const nextMigrating = { ...get().migrating }
      delete nextMigrating[id]
      track(plain.id)
      set({ entries: next, pending: nextPending, migrating: nextMigrating, ...(!silent && { refusals: refusals + 1 }) })
    } else {
      const next = { ...entries }
      delete next[id]
      set({ entries: next, pending: nextPending, refusals: refusals + 1 })
    }
  },

  reset: () => { fetches.clear(); set({ ...initial, generation: get().generation + 1 }) },
}))

// Keep the unsent queue on disk, so a save or removal made offline survives a reload.
savedStore.subscribe((state, previous) => {
  if (state.hydrated && (state.pending !== previous.pending || (state.hydrated && !previous.hydrated))) writeQueue(state)
})
