import { describe, it, expect, beforeEach } from 'vitest'
import { loadRoomReadState, saveRoomReadState, type RoomReadState } from './readStateStorage'
import { makeReadPointer } from './readPointer'
import { _resetStorageScopeForTesting, setStorageScopeJid } from '../../utils/storageScope'
import { localStorageMock } from '../../core/sideEffects.testHelpers'

Object.defineProperty(globalThis, 'localStorage', {
  value: localStorageMock,
})

const JID = 'me@example.com'
const at = (ms: number) => new Date(ms)

beforeEach(() => {
  localStorage.clear()
  _resetStorageScopeForTesting()
  setStorageScopeJid(JID)
})

describe('room read-state persistence', () => {
  it('round-trips a pointer and a history floor', () => {
    const state = new Map<string, RoomReadState>([
      ['room@conf.example.com', {
        readPointer: makeReadPointer({ id: 'm7', timestamp: at(7000) }),
        historyFloor: at(100),
      }],
    ])
    saveRoomReadState(state, JID)

    const restored = loadRoomReadState(JID)
    expect(restored.get('room@conf.example.com')).toEqual({
      readPointer: { messageId: 'm7', timestamp: at(7000) },
      historyFloor: at(100),
    })
  })

  it('returns an empty map when nothing was ever saved', () => {
    expect(loadRoomReadState(JID).size).toBe(0)
  })

  it('persists to localStorage under an account-scoped key', () => {
    saveRoomReadState(
      new Map([['r@c', { historyFloor: at(1) }]]),
      JID
    )
    expect(localStorage.getItem(`fluux-room-read-state:${JID}`)).not.toBeNull()
  })

  it("keeps one account's read state out of another's", () => {
    saveRoomReadState(new Map([['r@c', { historyFloor: at(1) }]]), JID)
    expect(loadRoomReadState('other@example.com').size).toBe(0)
  })

  it('survives a room with a floor but no pointer (joined, never read)', () => {
    saveRoomReadState(new Map([['r@c', { historyFloor: at(42) }]]), JID)
    const restored = loadRoomReadState(JID)
    expect(restored.get('r@c')).toEqual({ historyFloor: at(42) })
    expect(restored.get('r@c')?.readPointer).toBeUndefined()
  })

  // Control: an implementation that returns { readPointer: undefined } for a
  // corrupt row passes a naive `toBeUndefined()` check on the pointer while
  // still claiming the room HAS read state. The row also carries a VALID
  // historyFloor, so the final "drop if both fields are empty" guard cannot
  // drop it on its own — only the corrupt-pointer `continue` branch can.
  // Assert the row is dropped entirely, so the room falls back to its history
  // floor rather than to a phantom entry.
  it('drops a row whose pointer is corrupt rather than keeping a hollow entry', () => {
    localStorage.setItem(
      `fluux-room-read-state:${JID}`,
      JSON.stringify([['r@c', { readPointer: { messageId: 'm1' }, historyFloor: 42 }]])
    )
    expect(loadRoomReadState(JID).has('r@c')).toBe(false)
  })

  it('returns an empty map for unparseable storage rather than throwing', () => {
    localStorage.setItem(`fluux-room-read-state:${JID}`, '{not json')
    expect(loadRoomReadState(JID).size).toBe(0)
  })

  // Control: a row carrying neither a valid readPointer nor a valid
  // historyFloor must never be written into the result map as a hollow `{}`
  // entry. Unlike the corrupt-pointer test above, `raw.readPointer` is
  // `undefined` here, so the corrupt-pointer `continue` branch is never
  // reached — only the final "drop if both fields are empty" guard can drop
  // this row. Deleting that guard would let this row survive.
  it('drops a row with neither a valid pointer nor a valid history floor', () => {
    localStorage.setItem(
      `fluux-room-read-state:${JID}`,
      JSON.stringify([['r@c', {}]])
    )
    expect(loadRoomReadState(JID).has('r@c')).toBe(false)
  })
})
