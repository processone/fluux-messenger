/**
 * Contract of the app adapter behind {@link OpenPGPHostStores}: each member
 * must change the real zustand store that owns the state, and each
 * `subscribe` must call its listener synchronously, once per change of the
 * map, with no call for a write that changes nothing. The base class's
 * verification publish guard (`_syncingFromRemoteCount`) relies on that
 * synchronous delivery.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CertRejection, KeyChangeAlert, OwnKeyConflict } from '@fluux/openpgp-plugin'
import { createAppHostStores } from './appHostStores'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useCertRejectionStore } from '@/stores/certRejectionStore'
import { useOwnKeyConflictStore } from '@/stores/ownKeyConflictStore'
import { useTrustStateStatusStore } from '@/stores/trustStateStatusStore'
import { usePeerKeysetRevisionStore } from '@/stores/peerKeysetRevisionStore'

const PEER = 'peer@example.com'
const OTHER = 'other@example.com'
const FP_A = 'AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111'
const FP_B = 'BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222'

const alert: KeyChangeAlert = {
  previousFingerprint: FP_A,
  currentFingerprint: FP_B,
  observedAt: '2026-01-01T00:00:00.000Z',
}
const rejection: CertRejection = {
  fingerprint: FP_B,
  code: 'fingerprint_mismatch',
  detail: 'announced fingerprint differs from the cert',
  observedAt: '2026-01-01T00:00:00.000Z',
}
const conflict: OwnKeyConflict = {
  kind: 'primary-mismatch',
  localFingerprint: FP_A,
  publishedFingerprint: FP_B,
  publishedDate: '2026-01-01T00:00:00.000Z',
}

beforeEach(() => {
  localStorage.clear()
  useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
  useKeyChangeAlertsStore.setState({ alertsByJid: {} })
  usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: {}, pinnedAtByJid: {} })
  useCertRejectionStore.setState({ rejectionsByJid: {} })
  useOwnKeyConflictStore.setState({ conflict: null })
  useTrustStateStatusStore.getState().clear()
  usePeerKeysetRevisionStore.setState({ revisionByJid: {} })
})

describe('app host stores: verifiedPeers', () => {
  it('set and clear change the real store and getAll reads it back', () => {
    const { verifiedPeers } = createAppHostStores()
    verifiedPeers.set(PEER, FP_A)
    expect(useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid).toEqual({ [PEER]: FP_A })
    expect(verifiedPeers.getAll()).toEqual({ [PEER]: FP_A })
    verifiedPeers.clear(PEER)
    expect(useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid).toEqual({})
    expect(verifiedPeers.getAll()).toEqual({})
  })

  it('isVerified ignores case and whitespace and rejects another fingerprint', () => {
    const { verifiedPeers } = createAppHostStores()
    useVerifiedPeerKeysStore.getState().setVerified(PEER, FP_A)
    expect(verifiedPeers.isVerified(PEER, FP_A.toLowerCase())).toBe(true)
    expect(verifiedPeers.isVerified(PEER, FP_B)).toBe(false)
    expect(verifiedPeers.isVerified(OTHER, FP_A)).toBe(false)
  })

  it('calls the listener synchronously, once per change, with the new and previous map', () => {
    const { verifiedPeers } = createAppHostStores()
    const listener = vi.fn()
    verifiedPeers.subscribe(listener)
    verifiedPeers.set(PEER, FP_A)
    // Delivered before set() returned: no await between the write and this read.
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({ [PEER]: FP_A }, {})
    verifiedPeers.clear(PEER)
    expect(listener).toHaveBeenCalledTimes(2)
    expect(listener).toHaveBeenLastCalledWith({}, { [PEER]: FP_A })
  })

  it('does not call the listener for a write that changes nothing or for another store', () => {
    const { verifiedPeers } = createAppHostStores()
    verifiedPeers.set(PEER, FP_A)
    const listener = vi.fn()
    verifiedPeers.subscribe(listener)
    verifiedPeers.set(PEER, FP_A)
    verifiedPeers.clear(OTHER)
    usePinnedPrimaryFingerprintsStore.getState().setPinned(PEER, FP_A)
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops calling the listener after unsubscribe', () => {
    const { verifiedPeers } = createAppHostStores()
    const listener = vi.fn()
    const unsubscribe = verifiedPeers.subscribe(listener)
    unsubscribe()
    verifiedPeers.set(PEER, FP_A)
    expect(listener).not.toHaveBeenCalled()
  })

  it('lets a listener observe a write made while a remote sync guard is held', () => {
    // The base class skips a publish while it applies a remote list; that only
    // works if the listener runs inside the write, before the guard drops.
    const { verifiedPeers } = createAppHostStores()
    let syncing = 1
    const published: string[] = []
    verifiedPeers.subscribe(() => { if (syncing === 0) published.push('publish') })
    verifiedPeers.set(PEER, FP_A)
    syncing--
    expect(published).toEqual([])
    verifiedPeers.set(OTHER, FP_B)
    expect(published).toEqual(['publish'])
  })
})

describe('app host stores: pinnedPrimaryFingerprints', () => {
  it('set changes the real store and getAll reads it back', () => {
    const { pinnedPrimaryFingerprints } = createAppHostStores()
    pinnedPrimaryFingerprints.set(PEER, FP_A)
    expect(usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid).toEqual({ [PEER]: FP_A })
    expect(pinnedPrimaryFingerprints.getAll()).toEqual({ [PEER]: FP_A })
  })

  it('calls the listener synchronously once per change and not for the same pin', () => {
    const { pinnedPrimaryFingerprints } = createAppHostStores()
    const listener = vi.fn()
    pinnedPrimaryFingerprints.subscribe(listener)
    pinnedPrimaryFingerprints.set(PEER, FP_A)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({ [PEER]: FP_A }, {})
    pinnedPrimaryFingerprints.set(PEER, FP_A)
    expect(listener).toHaveBeenCalledTimes(1)
    pinnedPrimaryFingerprints.set(PEER, FP_B)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('app host stores: keyChangeAlerts', () => {
  it('get, getAll and clear read and change the real store', () => {
    const { keyChangeAlerts } = createAppHostStores()
    expect(keyChangeAlerts.get(PEER)).toBeNull()
    useKeyChangeAlertsStore.getState().setAlert(PEER, alert)
    expect(keyChangeAlerts.get(PEER)).toEqual(alert)
    expect(keyChangeAlerts.getAll()).toEqual({ [PEER]: alert })
    keyChangeAlerts.clear(PEER)
    expect(useKeyChangeAlertsStore.getState().alertsByJid).toEqual({})
    expect(keyChangeAlerts.get(PEER)).toBeNull()
  })

  it('calls the listener synchronously once per change, and not when nothing changes', () => {
    const { keyChangeAlerts } = createAppHostStores()
    const listener = vi.fn()
    keyChangeAlerts.subscribe(listener)
    useKeyChangeAlertsStore.getState().setAlert(PEER, alert)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenLastCalledWith({ [PEER]: alert }, {})
    keyChangeAlerts.clear(OTHER)
    expect(listener).toHaveBeenCalledTimes(1)
    keyChangeAlerts.clear(PEER)
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('app host stores: certRejections', () => {
  it('record, get and clear change the real store; get defaults to an empty list', () => {
    const { certRejections } = createAppHostStores()
    expect(certRejections.get(PEER)).toEqual([])
    certRejections.record(PEER, [rejection])
    expect(useCertRejectionStore.getState().rejectionsByJid).toEqual({ [PEER]: [rejection] })
    expect(certRejections.get(PEER)).toEqual([rejection])
    certRejections.clear(PEER)
    expect(useCertRejectionStore.getState().rejectionsByJid).toEqual({})
    expect(certRejections.get(PEER)).toEqual([])
  })
})

describe('app host stores: ownKeyConflict', () => {
  it('record, get and clear change the real store', () => {
    const { ownKeyConflict } = createAppHostStores()
    expect(ownKeyConflict.get()).toBeNull()
    ownKeyConflict.record(conflict)
    expect(useOwnKeyConflictStore.getState().conflict).toEqual(conflict)
    expect(ownKeyConflict.get()).toEqual(conflict)
    ownKeyConflict.clear()
    expect(useOwnKeyConflictStore.getState().conflict).toBeNull()
    expect(ownKeyConflict.get()).toBeNull()
  })
})

describe('app host stores: trustStateStatus', () => {
  it('set stores the status with its details and get reads it', () => {
    const { trustStateStatus } = createAppHostStores()
    expect(trustStateStatus.get()).toBe('uninitialized')
    trustStateStatus.set('compromised', ['verified peers differ'])
    expect(useTrustStateStatusStore.getState().status).toBe('compromised')
    expect(useTrustStateStatusStore.getState().mismatchDetails).toEqual(['verified peers differ'])
    expect(trustStateStatus.get()).toBe('compromised')
    trustStateStatus.set('sealed')
    expect(useTrustStateStatusStore.getState().mismatchDetails).toBeUndefined()
  })
})

describe('app host stores: peerKeysets', () => {
  it('notifyChanged bumps the revision of that peer only', () => {
    const { peerKeysets } = createAppHostStores()
    peerKeysets.notifyChanged(PEER)
    peerKeysets.notifyChanged(PEER)
    peerKeysets.notifyChanged(OTHER)
    expect(usePeerKeysetRevisionStore.getState().revisionByJid).toEqual({ [PEER]: 2, [OTHER]: 1 })
  })
})
