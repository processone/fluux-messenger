import { describe, it, expect, vi } from 'vitest'
import { roomTooltipParts, type RoomTooltipRoom } from './roomTooltip'

// Echoes the key back, with the interpolation options appended when present, so
// assertions can check both WHICH key was chosen and WHAT was interpolated
// without depending on real locale copy. Real plural resolution is covered in
// i18n.test.ts against the actual locale files.
const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key}(${JSON.stringify(options)})` : key

const occupants = (n: number) =>
  new Map(Array.from({ length: n }, (_, i) => [`user${i}`, {}])) as RoomTooltipRoom['occupants']

const makeRoom = (over: Partial<RoomTooltipRoom> = {}): RoomTooltipRoom => ({
  joined: true,
  isJoining: false,
  unreadCount: 0,
  occupants: occupants(2),
  nickname: 'me',
  ...over,
})

describe('roomTooltipParts', () => {
  it('announces the unread count as the headline', () => {
    const parts = roomTooltipParts(makeRoom({ unreadCount: 37 }), t)
    expect(parts.headline).toBe('rooms.unreadMessages({"count":37})')
  })

  it('passes the raw count to the translator so i18next can pick the plural form', () => {
    const spy = vi.fn((key: string) => key)
    roomTooltipParts(makeRoom({ unreadCount: 1 }), spy)
    expect(spy).toHaveBeenCalledWith('rooms.unreadMessages', { count: 1 })
  })

  it('has no headline when the room is fully read', () => {
    expect(roomTooltipParts(makeRoom({ unreadCount: 0 }), t).headline).toBeNull()
  })

  it('composes occupant count and nickname into the detail line', () => {
    expect(roomTooltipParts(makeRoom({ unreadCount: 37 }), t).detail).toBe('2 rooms.users • me')
  })

  it('drops the nickname segment when the room has no nickname', () => {
    const parts = roomTooltipParts(makeRoom({ nickname: undefined }), t)
    expect(parts.detail).toBe('2 rooms.users')
  })

  it('uses the singular occupant key for a room of one', () => {
    expect(roomTooltipParts(makeRoom({ occupants: occupants(1) }), t).detail).toBe('1 rooms.user • me')
  })

  it('reports joining state with no headline, even with unread messages', () => {
    // isJoining wins over joined — preserves the precedence of the previous
    // getTooltipContent, which checked isJoining first.
    const parts = roomTooltipParts(makeRoom({ isJoining: true, unreadCount: 37 }), t)
    expect(parts).toEqual({ headline: null, detail: 'rooms.joining' })
  })

  it('prompts to join an unjoined room, with no headline', () => {
    const parts = roomTooltipParts(makeRoom({ joined: false, unreadCount: 37 }), t)
    expect(parts).toEqual({ headline: null, detail: 'rooms.doubleClickToJoin' })
  })
})
