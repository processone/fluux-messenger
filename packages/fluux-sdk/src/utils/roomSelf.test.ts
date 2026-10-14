import { describe, expect, it } from 'vitest'
import { isOwnRoomMessage, roomSelf } from './roomSelf'

describe('roomSelf', () => {
  it('reads our nick and the occupant-id the room gave us', () => {
    const occupants = new Map([['Me', { occupantId: 'own' }], ['Alice', { occupantId: 'alice' }]])
    expect(roomSelf({ nickname: 'Me', occupants })).toEqual({ nick: 'Me', occupantId: 'own' })
    expect(roomSelf({ nickname: 'Me', occupants: new Map() })).toEqual({ nick: 'Me' })
    expect(roomSelf(undefined)).toEqual({ nick: '' })
  })
})

describe('isOwnRoomMessage', () => {
  it('matches our nick, whatever its case', () => {
    expect(isOwnRoomMessage('ME', undefined, { nick: 'me' })).toBe(true)
  })

  it('matches our occupant-id under another nick', () => {
    expect(isOwnRoomMessage('me-desktop', 'own', { nick: 'me-mobile', occupantId: 'own' })).toBe(true)
    expect(isOwnRoomMessage('me-desktop', 'other', { nick: 'me-mobile', occupantId: 'own' })).toBe(false)
  })

  it('trusts no occupant-id until the room has given us ours', () => {
    expect(isOwnRoomMessage('me-desktop', 'own', { nick: 'me-mobile' })).toBe(false)
    expect(isOwnRoomMessage('me-desktop', undefined, { nick: 'me-mobile' })).toBe(false)
  })
})
