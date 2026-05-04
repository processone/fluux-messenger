import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  clearPinnedPrimaryFp,
  getPinnedPrimaryFp,
  setPinnedPrimaryFp,
  usePinnedPrimaryFingerprintsStore,
} from './pinnedPrimaryFingerprintsStore'

const STORAGE_KEY = 'fluux-e2ee-pinned-primary-fingerprints'

describe('pinnedPrimaryFingerprintsStore', () => {
  beforeEach(() => {
    localStorage.clear()
    usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: {} })
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('records a pin and reads it back', () => {
    setPinnedPrimaryFp('alice@example.com', 'FP1')
    expect(getPinnedPrimaryFp('alice@example.com')).toBe('FP1')
  })

  it('returns null for an unpinned peer', () => {
    expect(getPinnedPrimaryFp('stranger@example.com')).toBeNull()
  })

  it('clearPinnedPrimaryFp removes the entry', () => {
    setPinnedPrimaryFp('alice@example.com', 'FP1')
    clearPinnedPrimaryFp('alice@example.com')
    expect(getPinnedPrimaryFp('alice@example.com')).toBeNull()
    // No-op for an already-cleared entry.
    clearPinnedPrimaryFp('alice@example.com')
  })

  it('persists to localStorage in the shape rehydrate expects', () => {
    setPinnedPrimaryFp('alice@example.com', 'FP1')
    setPinnedPrimaryFp('bob@example.com', 'FP2')
    const raw = localStorage.getItem(STORAGE_KEY)
    expect(raw).toBeTruthy()
    expect(JSON.parse(raw!)).toEqual({
      'alice@example.com': 'FP1',
      'bob@example.com': 'FP2',
    })
  })

  it('idempotent re-pin does not churn the state object', () => {
    // Subscribers should not re-render when the same fingerprint is
    // pinned again — common in the cachePeerKey path which fires on
    // every successful probe even when the cert hasn't changed.
    setPinnedPrimaryFp('alice@example.com', 'FP1')
    const before = usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid
    setPinnedPrimaryFp('alice@example.com', 'FP1')
    const after = usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid
    expect(before).toBe(after)
  })

  it('updating to a different fingerprint replaces the entry', () => {
    // Used by the user-driven accept-rotation flow — explicit re-pin.
    setPinnedPrimaryFp('alice@example.com', 'FP1')
    setPinnedPrimaryFp('alice@example.com', 'FP2')
    expect(getPinnedPrimaryFp('alice@example.com')).toBe('FP2')
  })

  it('different peers are isolated', () => {
    setPinnedPrimaryFp('alice@example.com', 'A1')
    setPinnedPrimaryFp('bob@example.com', 'B1')
    expect(getPinnedPrimaryFp('alice@example.com')).toBe('A1')
    expect(getPinnedPrimaryFp('bob@example.com')).toBe('B1')
    clearPinnedPrimaryFp('alice@example.com')
    expect(getPinnedPrimaryFp('alice@example.com')).toBeNull()
    expect(getPinnedPrimaryFp('bob@example.com')).toBe('B1')
  })
})
