import { describe, it, expect } from 'vitest'
import { roomTooltip, type RoomTooltipRoom } from './roomTooltip'

const t = (key: string) => key
const occupants = (n: number) =>
  new Map(Array.from({ length: n }, (_, i) => [`user${i}`, {}])) as RoomTooltipRoom['occupants']

const makeRoom = (over: Partial<RoomTooltipRoom> = {}): RoomTooltipRoom => ({
  joined: true,
  isJoining: false,
  occupants: occupants(2),
  nickname: 'me',
  ...over,
})

describe('roomTooltip', () => {
  it.each([0, 37, 998, 999, 1000])('keeps unread count %i out of the tooltip', (unreadCount) => {
    const room = { ...makeRoom(), unreadCount, mentionsCount: 3 }
    expect(roomTooltip(room, t)).toBe('2 rooms.users • me')
  })

  it('drops the nickname segment when the room has no nickname', () => {
    expect(roomTooltip(makeRoom({ nickname: undefined }), t)).toBe('2 rooms.users')
  })

  it('uses the singular occupant key for a room of one', () => {
    expect(roomTooltip(makeRoom({ occupants: occupants(1) }), t)).toBe('1 rooms.user • me')
  })

  it('reports joining state even when the room is joined', () => {
    expect(roomTooltip(makeRoom({ isJoining: true }), t)).toBe('rooms.joining')
  })

  it('prompts to join an unjoined room', () => {
    expect(roomTooltip(makeRoom({ joined: false }), t)).toBe('rooms.doubleClickToJoin')
  })
})
