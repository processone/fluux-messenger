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
