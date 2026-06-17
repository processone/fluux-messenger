import { describe, it, expect, beforeEach } from 'vitest'
import {
  computeMediaAutoload,
  approveMediaUrl,
  isMediaUrlApproved,
  __resetApprovedMediaUrlsForTest,
  type ConversationTrust,
} from './mediaAutoload'

describe('computeMediaAutoload', () => {
  const trusts: ConversationTrust[] = ['direct-contact', 'direct-stranger', 'room-private', 'room-public']

  it('strangers never auto-load, under any policy', () => {
    expect(computeMediaAutoload('always', 'direct-stranger')).toBe(false)
    expect(computeMediaAutoload('private-only', 'direct-stranger')).toBe(false)
    expect(computeMediaAutoload('never', 'direct-stranger')).toBe(false)
  })

  it('always loads non-strangers under "always"', () => {
    for (const t of trusts.filter((x) => x !== 'direct-stranger')) {
      expect(computeMediaAutoload('always', t)).toBe(true)
    }
  })

  it('never loads anything under "never"', () => {
    for (const t of trusts) {
      expect(computeMediaAutoload('never', t)).toBe(false)
    }
  })

  it('private-only loads private contexts, defers public rooms and strangers', () => {
    expect(computeMediaAutoload('private-only', 'direct-contact')).toBe(true)
    expect(computeMediaAutoload('private-only', 'room-private')).toBe(true)
    expect(computeMediaAutoload('private-only', 'room-public')).toBe(false)
    expect(computeMediaAutoload('private-only', 'direct-stranger')).toBe(false)
  })
})

describe('session-approved media URLs', () => {
  beforeEach(() => __resetApprovedMediaUrlsForTest())

  it('round-trips an approved URL', () => {
    expect(isMediaUrlApproved('https://x/a.jpg')).toBe(false)
    approveMediaUrl('https://x/a.jpg')
    expect(isMediaUrlApproved('https://x/a.jpg')).toBe(true)
    expect(isMediaUrlApproved('https://x/b.jpg')).toBe(false)
  })
})
