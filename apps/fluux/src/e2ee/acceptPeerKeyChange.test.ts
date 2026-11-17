/**
 * acceptPeerKeyChange: the key-change banner's "accept" action. It re-pins the
 * peer's new primary fingerprint, drops the old verification, refetches the
 * cert and optionally marks the new key verified. These tests pin its effect
 * on the trust stores, which the host-store seam must not change.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createAppDesktopHost } from './appDesktopHost'
import { createAppHostStores } from './appHostStores'
import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'

const PEER = 'peer@example.com'
const OLD_FP = 'AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111'
const NEW_FP = 'BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222'

type Internals = {
  refetchAndCachePeerKey: (peer: string) => Promise<{ supported: boolean }>
}

function makePlugin(refetch: () => Promise<{ supported: boolean }>, peerFingerprints: string[]) {
  const plugin = new SequoiaPgpPlugin({ invoke: vi.fn(), stores: createAppHostStores(), ...createAppDesktopHost() })
  vi.spyOn(plugin as unknown as Internals, 'refetchAndCachePeerKey').mockImplementation(refetch)
  vi.spyOn(plugin, 'getPeerFingerprints').mockReturnValue(peerFingerprints)
  return plugin
}

const pins = () => usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid
const verified = () => useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid
const alerts = () => useKeyChangeAlertsStore.getState().alertsByJid

beforeEach(() => {
  localStorage.clear()
  usePinnedPrimaryFingerprintsStore.setState({ pinnedFingerprintByJid: {}, pinnedAtByJid: {} })
  useVerifiedPeerKeysStore.setState({ verifiedFingerprintByJid: {} })
  useKeyChangeAlertsStore.setState({ alertsByJid: {} })
  useKeyChangeAlertsStore.getState().setAlert(PEER, {
    previousFingerprint: OLD_FP,
    currentFingerprint: NEW_FP,
    observedAt: '2026-01-01T00:00:00.000Z',
  })
  usePinnedPrimaryFingerprintsStore.getState().setPinned(PEER, OLD_FP)
  useVerifiedPeerKeysStore.getState().setVerified(PEER, OLD_FP)
})

describe('acceptPeerKeyChange', () => {
  it('does nothing when the peer has no alert', async () => {
    useKeyChangeAlertsStore.setState({ alertsByJid: {} })
    const refetch = vi.fn().mockResolvedValue({ supported: true })
    await makePlugin(refetch, [NEW_FP]).acceptPeerKeyChange(PEER, true)
    expect(refetch).not.toHaveBeenCalled()
    expect(pins()[PEER]).toBe(OLD_FP)
    expect(verified()[PEER]).toBe(OLD_FP)
  })

  it('re-pins the new key, drops the old verification and clears the alert', async () => {
    await makePlugin(async () => ({ supported: true }), [NEW_FP]).acceptPeerKeyChange(PEER, false)
    expect(pins()[PEER]).toBe(NEW_FP)
    expect(verified()[PEER]).toBeUndefined()
    expect(alerts()[PEER]).toBeUndefined()
  })

  it('marks the new key verified when asked and the peer announces it', async () => {
    await makePlugin(async () => ({ supported: true }), [NEW_FP]).acceptPeerKeyChange(PEER, true)
    expect(pins()[PEER]).toBe(NEW_FP)
    expect(verified()[PEER]).toBe(NEW_FP)
    expect(alerts()[PEER]).toBeUndefined()
  })

  it('does not mark verified when the fetched keyset lacks the new fingerprint', async () => {
    await makePlugin(async () => ({ supported: true }), [OLD_FP]).acceptPeerKeyChange(PEER, true)
    expect(verified()[PEER]).toBeUndefined()
    expect(pins()[PEER]).toBe(NEW_FP)
  })

  it('keeps an alert the refetch raised for the same new key', async () => {
    const plugin = makePlugin(async () => {
      useKeyChangeAlertsStore.getState().setAlert(PEER, {
        previousFingerprint: NEW_FP,
        currentFingerprint: 'CCCC3333CCCC3333CCCC3333CCCC3333CCCC3333',
        observedAt: '2026-01-02T00:00:00.000Z',
      })
      return { supported: true }
    }, [NEW_FP])
    await plugin.acceptPeerKeyChange(PEER, false)
    expect(alerts()[PEER]?.previousFingerprint).toBe(NEW_FP)
  })

  it('rolls the pin back and throws when the new key cannot be fetched', async () => {
    const plugin = makePlugin(async () => ({ supported: false }), [])
    await expect(plugin.acceptPeerKeyChange(PEER, true)).rejects.toThrow(/pin rolled back/)
    expect(pins()[PEER]).toBe(OLD_FP)
    expect(alerts()[PEER]).toBeDefined()
    expect(verified()[PEER]).toBeUndefined()
  })
})
