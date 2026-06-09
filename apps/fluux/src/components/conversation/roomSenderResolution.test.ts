import { describe, it, expect } from 'vitest'
import { selectSelfOccupant, stableNickSet } from './roomSenderResolution'
import type { RoomOccupant } from '@fluux/sdk'

const occ = (nick: string, extra: Partial<RoomOccupant> = {}): RoomOccupant =>
  ({ nick, role: 'participant', affiliation: 'none', ...extra } as RoomOccupant)

describe('selectSelfOccupant', () => {
  it('returns the occupant matching myNick', () => {
    const map = new Map([['me', occ('me')], ['you', occ('you')]])
    expect(selectSelfOccupant(map, 'me')?.nick).toBe('me')
  })
  it('returns undefined when myNick is undefined or absent', () => {
    const map = new Map([['you', occ('you')]])
    expect(selectSelfOccupant(map, undefined)).toBeUndefined()
    expect(selectSelfOccupant(map, 'me')).toBeUndefined()
  })
})

describe('stableNickSet', () => {
  it('returns the SAME set ref when the nick set is unchanged across calls', () => {
    const a = new Map([['x', occ('x')], ['y', occ('y')]])
    const first = stableNickSet(a, undefined)
    const b = new Map([['x', occ('x', { show: 'away' })], ['y', occ('y')]])
    const second = stableNickSet(b, first)
    expect(second).toBe(first)
  })
  it('returns a NEW set ref when a nick is added or removed', () => {
    const a = new Map([['x', occ('x')]])
    const first = stableNickSet(a, undefined)
    const b = new Map([['x', occ('x')], ['z', occ('z')]])
    const second = stableNickSet(b, first)
    expect(second).not.toBe(first)
    expect(second.has('z')).toBe(true)
  })
})
