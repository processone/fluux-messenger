/**
 * Durable, account-scoped persistence for ROOM read state.
 *
 * Rooms had none. `RoomMetadata.lastSeenMessageId` was documented as
 * "persisted, only advances forward" but roomStore has no persist middleware,
 * and the app's `saveRooms` — the only writer of the `xmpp-rooms` sessionStorage
 * key — has no production caller, so the restore path read a key nothing wrote.
 * Room read position was rebuilt every session from MAM catch-up plus the
 * XEP-0490 seed, which is very likely part of what issue #1076 reported.
 *
 * Follows the pattern roomStore already uses for gaps, coverage, pending
 * retractions and drafts: one scoped localStorage key holding a serialized Map.
 *
 * `unreadCount` is deliberately NOT persisted here — it is derived from the
 * archive against this pointer, and the archive is the thing worth trusting.
 */

import { buildScopedStorageKey } from '../../utils/storageScope'
import {
  deserializeReadPointer,
  serializeReadPointer,
  type ReadPointer,
  type SerializedReadPointer,
} from './readPointer'

const ROOM_READ_STATE_STORAGE_KEY_BASE = 'fluux-room-read-state'

/** Persisted read state for one room. */
export interface RoomReadState {
  readPointer?: ReadPointer
  /** When this room entered our world (join). Not a read position. */
  historyFloor?: Date
}

interface SerializedRoomReadState {
  readPointer?: SerializedReadPointer
  historyFloor?: number
}

/**
 * The on-disk key this module reads and writes, for `jid` (or the ambient
 * storage scope when omitted).
 *
 * Exported so tests can address the same row this module writes instead of
 * re-spelling `fluux-room-read-state:<jid>` by hand — a duplicated literal would
 * survive a rename here and turn a real regression into a puzzling
 * "expected null not to be null".
 */
export function getRoomReadStateStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_READ_STATE_STORAGE_KEY_BASE, jid)
}

/**
 * Every key `saveRoomReadState` has actually written this session.
 *
 * A save builds its key from the AMBIENT storage scope, so the row's name is
 * decided at write time. A test that resets the scope first (the usual order)
 * then asks to clear would otherwise remove the UNSCOPED key — a row nothing
 * wrote — and leave `fluux-room-read-state:<jid>` on disk for the next
 * `switchAccount` to load back. Remembering what we wrote is what lets
 * `_clearAllRoomReadStateForTesting` clear the real rows; enumerating
 * `localStorage` is not an option, as the store suites install object mocks with
 * no key enumeration.
 */
const writtenRoomReadStateKeys = new Set<string>()

/**
 * Load persisted room read state.
 *
 * A row that cannot be fully reconstructed is DROPPED, not kept with undefined
 * fields: a hollow entry would claim the room has read state while carrying
 * none, and the caller would skip the history-floor fallback that should cover
 * exactly that case.
 */
export function loadRoomReadState(jid?: string | null): Map<string, RoomReadState> {
  const result = new Map<string, RoomReadState>()
  try {
    const stored = localStorage.getItem(getRoomReadStateStorageKey(jid))
    if (!stored) return result
    const entries = JSON.parse(stored) as [string, SerializedRoomReadState][]
    if (!Array.isArray(entries)) return result

    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) continue
      const [roomJid, raw] = entry
      if (typeof roomJid !== 'string' || !raw || typeof raw !== 'object') continue

      // A pointer that was written but cannot be read back means the row is
      // corrupt — drop it rather than silently downgrading to "never read".
      // This discards the row's historyFloor too, even if that field is
      // independently well-formed: a corrupt pointer means we wrote this row
      // badly, and we don't know which half to trust. Dropping the whole row
      // falls back to the caller's history-floor default, which under-counts
      // (more unread, recoverable by reading). Keeping the floor and trusting
      // it while distrusting its sibling field risks the unrecoverable
      // direction — an over-advanced read pointer — so we bias away from it.
      let readPointer: ReadPointer | undefined
      if (raw.readPointer !== undefined) {
        readPointer = deserializeReadPointer(raw.readPointer)
        if (!readPointer) continue
      }

      const historyFloor =
        typeof raw.historyFloor === 'number' && Number.isFinite(raw.historyFloor)
          ? new Date(raw.historyFloor)
          : undefined

      if (!readPointer && !historyFloor) continue
      result.set(roomJid, { ...(readPointer ? { readPointer } : {}), ...(historyFloor ? { historyFloor } : {}) })
    }
  } catch {
    // Unparseable storage — start empty rather than throwing during store init.
  }
  return result
}

/**
 * Drop the account's persisted room read state (logout).
 *
 * Mirrors what `chatStore.reset()` does to the chat storage key, which is where
 * the 1:1 read pointers live: logging out forgets read positions for both kinds
 * of conversation, rather than for one of them.
 */
export function clearRoomReadState(jid?: string | null): void {
  const key = getRoomReadStateStorageKey(jid)
  writtenRoomReadStateKeys.delete(key)
  try {
    localStorage.removeItem(key)
  } catch {
    // Ignore storage errors (private mode, etc.).
  }
}

/**
 * Test-only: drop every row this module has written, under whatever account
 * scope it was written. See `writtenRoomReadStateKeys` for why the ambient
 * scope is not enough.
 * @internal
 */
export function _clearAllRoomReadStateForTesting(): void {
  for (const key of writtenRoomReadStateKeys) {
    try {
      localStorage.removeItem(key)
    } catch {
      // Ignore storage errors (private mode, etc.).
    }
  }
  writtenRoomReadStateKeys.clear()
  // The ambient row too: a test may have hand-written a fixture we never saved.
  clearRoomReadState()
}

export function saveRoomReadState(state: Map<string, RoomReadState>, jid?: string | null): void {
  try {
    const entries: [string, SerializedRoomReadState][] = []
    for (const [roomJid, value] of state) {
      if (!value.readPointer && !value.historyFloor) continue
      entries.push([
        roomJid,
        {
          ...(value.readPointer ? { readPointer: serializeReadPointer(value.readPointer) } : {}),
          ...(value.historyFloor ? { historyFloor: value.historyFloor.getTime() } : {}),
        },
      ])
    }
    const key = getRoomReadStateStorageKey(jid)
    localStorage.setItem(key, JSON.stringify(entries))
    writtenRoomReadStateKeys.add(key)
  } catch {
    // Ignore storage errors (quota exceeded, private mode, etc.).
  }
}
