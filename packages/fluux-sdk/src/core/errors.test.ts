import { describe, it, expect } from 'vitest'
import { RoomJoinError } from './errors'

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
