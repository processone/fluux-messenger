/**
 * Contract of {@link OpenPGPHostStores}, run against the in-memory host the
 * package's own tests use. The app adapter's suite (appHostStores.test.ts)
 * checks the same behaviours against the real stores, so both stay
 * interchangeable: reads see writes, and a `subscribe` listener runs
 * synchronously inside the write, once per change, never for a no-op write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeyChangeAlert } from '../hostStores'
import { createMockHostStores } from './mockHostStores'

const PEER = 'peer@example.com'
const OTHER = 'other@example.com'
const FP_A = 'AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111'
const FP_B = 'BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222'
const alert: KeyChangeAlert = { previousFingerprint: FP_A, currentFingerprint: FP_B, observedAt: '2026-01-01T00:00:00.000Z' }

let stores = createMockHostStores()
beforeEach(() => { stores = createMockHostStores() })

describe('mock host stores: verifiedPeers', () => {
  it('set and clear change the map and getAll reads it back', () => {
    stores.verifiedPeers.set(PEER, FP_A)
    expect(stores.verifiedPeers.getAll()).toEqual({ [PEER]: FP_A })
    stores.verifiedPeers.clear(PEER)
    expect(stores.verifiedPeers.getAll()).toEqual({})
  })

  it('isVerified ignores case and whitespace and rejects another fingerprint', () => {
    stores.verifiedPeers.set(PEER, FP_A)
    expect(stores.verifiedPeers.isVerified(PEER, FP_A.toLowerCase())).toBe(true)
    expect(stores.verifiedPeers.isVerified(PEER, FP_B)).toBe(false)
    expect(stores.verifiedPeers.isVerified(OTHER, FP_A)).toBe(false)
  })

  it('calls the listener synchronously, once per change, with the new and previous map', () => {
    const listener = vi.fn()
    stores.verifiedPeers.subscribe(listener)
    stores.verifiedPeers.set(PEER, FP_A)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({ [PEER]: FP_A }, {})
    stores.verifiedPeers.clear(PEER)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith({}, { [PEER]: FP_A })
  })

  it('does not call the listener for a write that changes nothing', () => {
    stores.verifiedPeers.set(PEER, FP_A)
    const listener = vi.fn()
    stores.verifiedPeers.subscribe(listener)
    stores.verifiedPeers.set(PEER, FP_A)
    stores.verifiedPeers.clear(OTHER)
    stores.pinnedPrimaryFingerprints.set(PEER, FP_A)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops calling the listener after unsubscribe', () => {
    const listener = vi.fn()
    stores.verifiedPeers.subscribe(listener)()
    stores.verifiedPeers.set(PEER, FP_A)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('mock host stores: other groups', () => {
  it('pinnedPrimaryFingerprints set and subscribe', () => {
    const listener = vi.fn()
    stores.pinnedPrimaryFingerprints.subscribe(listener)
    stores.pinnedPrimaryFingerprints.set(PEER, FP_A)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(stores.pinnedPrimaryFingerprints.getAll()).toEqual({ [PEER]: FP_A })
  })

  it('keyChangeAlerts get, getAll, clear and subscribe', () => {
    const listener = vi.fn()
    stores.keyChangeAlerts.subscribe(listener)
    expect(stores.keyChangeAlerts.get(PEER)).toBeNull()
    stores.setKeyChangeAlerts({ [PEER]: alert })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(stores.keyChangeAlerts.get(PEER)).toEqual(alert)
    expect(stores.keyChangeAlerts.getAll()).toEqual({ [PEER]: alert })
    stores.keyChangeAlerts.clear(OTHER)
    expect(listener).toHaveBeenCalledTimes(1)
    stores.keyChangeAlerts.clear(PEER)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(stores.keyChangeAlerts.get(PEER)).toBeNull()
  })

  it('certRejections record, get and clear; get defaults to an empty list', () => {
    const rejection = { fingerprint: FP_A, code: 'validation_failed' as const, detail: 'bad', observedAt: alert.observedAt }
    expect(stores.certRejections.get(PEER)).toEqual([])
    stores.certRejections.record(PEER, [rejection])
    expect(stores.certRejections.get(PEER)).toEqual([rejection])
    stores.certRejections.clear(PEER)
    expect(stores.certRejections.get(PEER)).toEqual([])
  })

  it('ownKeyConflict record, get and clear', () => {
    const conflict = { kind: 'primary-mismatch' as const, localFingerprint: FP_A, publishedFingerprint: FP_B, publishedDate: alert.observedAt }
    expect(stores.ownKeyConflict.get()).toBeNull()
    stores.ownKeyConflict.record(conflict)
    expect(stores.ownKeyConflict.get()).toEqual(conflict)
    stores.ownKeyConflict.clear()
    expect(stores.ownKeyConflict.get()).toBeNull()
  })

  it('trustStateStatus starts uninitialized and reads back what was set', () => {
    expect(stores.trustStateStatus.get()).toBe('uninitialized')
    stores.trustStateStatus.set('compromised')
    expect(stores.trustStateStatus.get()).toBe('compromised')
  })

  it('reset empties every group', () => {
    stores.verifiedPeers.set(PEER, FP_A)
    stores.trustStateStatus.set('sealed')
    stores.reset()
    expect(stores.verifiedPeers.getAll()).toEqual({})
    expect(stores.trustStateStatus.get()).toBe('uninitialized')
  })
})
