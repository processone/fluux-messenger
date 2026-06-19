import { describe, it, expect } from 'vitest'
import { getAdminBackTarget } from './adminBackTarget'

describe('getAdminBackTarget', () => {
  it('returns "exit" when at the list level (nothing selected)', () => {
    expect(
      getAdminBackTarget({ hasSession: false, hasSelectedUser: false, hasSelectedRoom: false })
    ).toBe('exit')
  })

  it('returns "user" when a user detail is open, so back steps to the list (not the root)', () => {
    expect(
      getAdminBackTarget({ hasSession: false, hasSelectedUser: true, hasSelectedRoom: false })
    ).toBe('user')
  })

  it('returns "room" when a room detail is open, so back steps to the list (not the root)', () => {
    expect(
      getAdminBackTarget({ hasSession: false, hasSelectedUser: false, hasSelectedRoom: true })
    ).toBe('room')
  })

  it('returns "session" when a command session is active', () => {
    expect(
      getAdminBackTarget({ hasSession: true, hasSelectedUser: false, hasSelectedRoom: false })
    ).toBe('session')
  })

  it('prioritises an active session over a stale selection', () => {
    expect(
      getAdminBackTarget({ hasSession: true, hasSelectedUser: true, hasSelectedRoom: false })
    ).toBe('session')
  })
})
