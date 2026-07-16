import { describe, it, expect, beforeEach } from 'vitest'
import type { OpenPGPHostStores } from './hostStores'
import { createMockHostStores, type MockHostStores } from './testing/mockHostStores'

describe('OpenPGPHostStores mock conformance', () => {
  let host: MockHostStores

  beforeEach(() => {
    host = createMockHostStores()
    host._reset()
  })

  it('satisfies the OpenPGPHostStores interface', () => {
    // Compile-time assignability: if the mock drifts from the interface this
    // line fails to type-check (the package typecheck is the real gate).
    const asInterface: OpenPGPHostStores = host
    expect(asInterface).toBeDefined()
  })

  it('verifiedPeers round-trips and fires subscribers with the new map', () => {
    const seen: Array<Record<string, string>> = []
    host.verifiedPeers.subscribe((m) => seen.push(m))
    host.verifiedPeers.setVerified('a@x', 'FP1')
    expect(host.verifiedPeers.isVerified('a@x', 'fp1')).toBe(true) // normalized compare
    expect(host.verifiedPeers.getAll()).toEqual({ 'a@x': 'FP1' })
    host.verifiedPeers.setVerified('a@x', 'FP1') // idempotent → no extra fire
    expect(seen).toHaveLength(1)
    host.verifiedPeers.clearVerified('a@x')
    expect(host.verifiedPeers.getAll()).toEqual({})
    expect(seen).toHaveLength(2)
  })

  it('pinned + keyChangeAlerts + ownKeyConflict + trustStateStatus behave', () => {
    host.pinnedPrimaryFingerprints.set('b@x', 'PIN')
    expect(host.pinnedPrimaryFingerprints.get('b@x')).toBe('PIN')
    host.keyChangeAlerts.record('b@x', 'OLD', 'NEW')
    expect(host.keyChangeAlerts.get('b@x')).toMatchObject({ previousFingerprint: 'OLD', currentFingerprint: 'NEW' })
    host.ownKeyConflict.record({ kind: 'primary-mismatch', localFingerprint: 'L', publishedFingerprint: 'P', publishedDate: 'd' })
    expect(host.ownKeyConflict.get()?.kind).toBe('primary-mismatch')
    host.trustStateStatus.set('sealed')
    expect(host.trustStateStatus.get()).toBe('sealed')
  })
})
