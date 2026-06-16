import { describe, it, expect } from 'vitest'
import { RoomJoinError } from '@fluux/sdk'
import { getRoomJoinErrorMessage } from './roomJoinError'

// Identity translate fn: returns the key so assertions read as i18n keys.
const t = (key: string) => key

const err = (condition: string, text?: string) =>
  new RoomJoinError('room@conference.example.com', condition, undefined, text)

describe('getRoomJoinErrorMessage', () => {
  it('maps not-authorized to passwordRequired when no password was sent', () => {
    expect(getRoomJoinErrorMessage(t, err('not-authorized'))).toBe('rooms.passwordRequired')
  })

  it('maps not-authorized to incorrectPassword when a password was sent', () => {
    expect(getRoomJoinErrorMessage(t, err('not-authorized'), { passwordWasSent: true })).toBe(
      'rooms.incorrectPassword',
    )
  })

  it.each([
    ['conflict', 'rooms.nicknameInUse'],
    ['registration-required', 'rooms.membersOnly'],
    ['forbidden', 'rooms.bannedFromRoom'],
    ['service-unavailable', 'rooms.roomFull'],
    ['not-acceptable', 'rooms.registeredNicknameRequired'],
    ['item-not-found', 'rooms.roomNotFound'],
  ])('maps %s to %s', (condition, key) => {
    expect(getRoomJoinErrorMessage(t, err(condition))).toBe(key)
  })

  it('uses server text for an unmapped condition when present', () => {
    expect(getRoomJoinErrorMessage(t, err('resource-constraint', 'Try later'))).toBe('Try later')
  })

  it('falls back to failedToJoinRoom for an unmapped condition with no text', () => {
    expect(getRoomJoinErrorMessage(t, err('resource-constraint'))).toBe('rooms.failedToJoinRoom')
  })

  it('falls back to failedToJoinRoom for the synthetic timeout condition', () => {
    expect(getRoomJoinErrorMessage(t, err('timeout'))).toBe('rooms.failedToJoinRoom')
  })

  it('uses the message of a plain Error', () => {
    expect(getRoomJoinErrorMessage(t, new Error('boom'))).toBe('boom')
  })

  it('falls back to failedToJoinRoom for a non-Error value', () => {
    expect(getRoomJoinErrorMessage(t, 'nope')).toBe('rooms.failedToJoinRoom')
  })
})
