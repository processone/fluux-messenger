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

function getRoomReadStateStorageKey(jid?: string | null): string {
  return buildScopedStorageKey(ROOM_READ_STATE_STORAGE_KEY_BASE, jid)
}

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
    localStorage.setItem(getRoomReadStateStorageKey(jid), JSON.stringify(entries))
  } catch {
    // Ignore storage errors (quota exceeded, private mode, etc.).
  }
}
