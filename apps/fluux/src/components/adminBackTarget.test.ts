import { describe, it, expect } from 'vitest'
import { getAdminBackTarget } from './adminBackTarget'

const base = { hasSession: false, hasSelectedUser: false, hasSelectedRoom: false, activeCategory: null }

describe('getAdminBackTarget', () => {
  it('prioritises a command session above everything', () => {
    expect(getAdminBackTarget({ ...base, hasSession: true, hasSelectedUser: true, activeCategory: 'users' })).toBe('session')
  })

  it('steps out of a selected user before the list', () => {
    expect(getAdminBackTarget({ ...base, hasSelectedUser: true, activeCategory: 'users' })).toBe('user')
  })

  it('steps out of a selected room before the list', () => {
    expect(getAdminBackTarget({ ...base, hasSelectedRoom: true, activeCategory: 'rooms' })).toBe('room')
  })

  it('returns to the overview from the users list', () => {
    expect(getAdminBackTarget({ ...base, activeCategory: 'users' })).toBe('overview')
  })

  it('returns to the overview from the rooms list', () => {
    expect(getAdminBackTarget({ ...base, activeCategory: 'rooms' })).toBe('overview')
  })

  it('exits admin from the overview itself', () => {
    expect(getAdminBackTarget({ ...base, activeCategory: 'stats' })).toBe('exit')
  })

  it('exits admin when no category is active', () => {
    expect(getAdminBackTarget({ ...base, activeCategory: null })).toBe('exit')
  })
})
