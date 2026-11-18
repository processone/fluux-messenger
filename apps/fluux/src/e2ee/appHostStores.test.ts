/**
 * The app adapter behind {@link OpenPGPHostStores}. The shared contract (the
 * same one the package runs on its in-memory host) checks the behaviour of
 * every member and that each `subscribe` is synchronous and once per change;
 * the tests below check that each member reaches the real zustand store that
 * owns the state.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import type { CertRejection, KeyChangeAlert, OwnKeyConflict } from '@fluux/openpgp-plugin'
import { runHostStoresContract } from '@fluux/openpgp-plugin/testing/hostStoresContract'
import { createAppHostStores } from './appHostStores'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useCertRejectionStore } from '@/stores/certRejectionStore'
import { useOwnKeyConflictStore } from '@/stores/ownKeyConflictStore'
import { useTrustStateStatusStore } from '@/stores/trustStateStatusStore'
import { usePeerKeysetRevisionStore } from '@/stores/peerKeysetRevisionStore'

const PEER = 'peer@example.com'
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

function resetStores() {
  localStorage.clear()
  useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
  useKeyChangeAlertsStore.setState({ alertsByJid: {} })
  usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: {}, pinnedAtByJid: {} })
  useCertRejectionStore.setState({ rejectionsByJid: {} })
  useOwnKeyConflictStore.setState({ conflict: null })
  useTrustStateStatusStore.getState().clear()
  usePeerKeysetRevisionStore.setState({ revisionByJid: {} })
}
beforeEach(resetStores)


runHostStoresContract('app host stores', () => {
  resetStores()
  return {
    stores: createAppHostStores(),
    seedKeyChangeAlert: (jid, a) => useKeyChangeAlertsStore.getState().setAlert(jid, a),
    trustStateDetails: () => useTrustStateStatusStore.getState().mismatchDetails,
    peerKeysetNotifications: (jid) => usePeerKeysetRevisionStore.getState().revisionByJid[jid] ?? 0,
  }
})

describe('app host stores: writes reach the real stores', () => {
  it('verifiedPeers', () => {
    const { verifiedPeers } = createAppHostStores()
    verifiedPeers.set(PEER, FP_A)
    expect(useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid).toEqual({ [PEER]: FP_A })
    verifiedPeers.clear(PEER)
    expect(useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid).toEqual({})
  })

  it('pinnedPrimaryFingerprints', () => {
    createAppHostStores().pinnedPrimaryFingerprints.set(PEER, FP_A)
    expect(usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid).toEqual({ [PEER]: FP_A })
  })

  it('keyChangeAlerts', () => {
    const { keyChangeAlerts } = createAppHostStores()
    useKeyChangeAlertsStore.getState().setAlert(PEER, alert)
    expect(keyChangeAlerts.get(PEER)).toEqual(alert)
    keyChangeAlerts.clear(PEER)
    expect(useKeyChangeAlertsStore.getState().alertsByJid).toEqual({})
  })

  it('certRejections', () => {
    const { certRejections } = createAppHostStores()
    certRejections.record(PEER, [rejection])
    expect(useCertRejectionStore.getState().rejectionsByJid).toEqual({ [PEER]: [rejection] })
    certRejections.clear(PEER)
    expect(useCertRejectionStore.getState().rejectionsByJid).toEqual({})
  })

  it('ownKeyConflict', () => {
    const { ownKeyConflict } = createAppHostStores()
    ownKeyConflict.record(conflict)
    expect(useOwnKeyConflictStore.getState().conflict).toEqual(conflict)
    ownKeyConflict.clear()
    expect(useOwnKeyConflictStore.getState().conflict).toBeNull()
  })

  it('trustStateStatus', () => {
    createAppHostStores().trustStateStatus.set('compromised', ['verified peers differ'])
    expect(useTrustStateStatusStore.getState().status).toBe('compromised')
    expect(useTrustStateStatusStore.getState().mismatchDetails).toEqual(['verified peers differ'])
  })

  it('peerKeysets bumps the revision of that peer only', () => {
    const { peerKeysets } = createAppHostStores()
    peerKeysets.notifyChanged(PEER)
    expect(usePeerKeysetRevisionStore.getState().revisionByJid).toEqual({ [PEER]: 1 })
  })
})
