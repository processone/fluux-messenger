import { describe, it, expect } from 'vitest'
import { RoomJoinError, roomJoinReasonFor } from './errors'

describe('RoomJoinError', () => {
  it('carries roomJid, condition, errorType, and text', () => {
    const err = new RoomJoinError('room@conf.example.org', 'not-authorized', 'auth', 'Password required')
    expect(err.roomJid).toBe('room@conf.example.org')
    expect(err.condition).toBe('not-authorized')
    expect(err.errorType).toBe('auth')
    expect(err.text).toBe('Password required')
  })

  it('is an instanceof Error and RoomJoinError', () => {
    const err = new RoomJoinError('room@conf.example.org', 'conflict')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(RoomJoinError)
    expect(err.name).toBe('RoomJoinError')
  })

  it('uses server text as the message when present, else a condition fallback', () => {
    expect(new RoomJoinError('r@x', 'forbidden', 'auth', 'You are banned').message).toBe('You are banned')
    expect(new RoomJoinError('r@x', 'timeout').message).toBe('Room join failed: timeout')
  })
})

describe('roomJoinReasonFor', () => {
  it.each([
    ['conflict', 'nickname-taken'],
    ['registration-required', 'members-only'],
    ['forbidden', 'banned'],
    ['service-unavailable', 'room-full'],
    ['not-acceptable', 'registered-nickname-required'],
    ['item-not-found', 'room-not-found'],
    ['not-joined', 'not-in-room'],
    ['timeout', 'timed-out'],
  ])('resolves %s to %s', (condition, reason) => {
    expect(roomJoinReasonFor(condition)).toBe(reason)
  })

  it('separates the two not-authorized cases by whether a password was sent', () => {
    expect(roomJoinReasonFor('not-authorized')).toBe('password-required')
    expect(roomJoinReasonFor('not-authorized', true)).toBe('wrong-password')
  })

  it('reads a condition it does not know as unknown', () => {
    expect(roomJoinReasonFor('resource-constraint')).toBe('unknown')
  })

  it('only lets the password flag change not-authorized', () => {
    expect(roomJoinReasonFor('conflict', true)).toBe('nickname-taken')
  })
})
