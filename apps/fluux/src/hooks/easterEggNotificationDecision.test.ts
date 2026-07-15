import { describe, it, expect } from 'vitest'
import { decideEasterEggNotification } from './easterEggNotificationDecision'

describe('decideEasterEggNotification', () => {
  it('ignores our own egg', () => {
    expect(decideEasterEggNotification({ isOwn: true, isActive: false })).toEqual({ kind: 'none' })
  })
  it('ignores an egg for the active conversation (the binding plays it)', () => {
    expect(decideEasterEggNotification({ isOwn: false, isActive: true })).toEqual({ kind: 'none' })
  })
  it('notifies for an egg from someone else in an inactive conversation', () => {
    expect(decideEasterEggNotification({ isOwn: false, isActive: false })).toEqual({ kind: 'notify' })
  })
})
