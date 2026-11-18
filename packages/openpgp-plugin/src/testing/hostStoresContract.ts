/**
 * One contract for every {@link OpenPGPHostStores} adapter. The package runs it
 * against the in-memory host its own tests use; the app runs it against the
 * adapter over its real stores. Each `subscribe` must call its listener
 * synchronously inside the write, once per change of the map, with the new and
 * previous map, and never for a write that changes nothing: the base class's
 * verification publish guard (`_syncingFromRemoteCount`) relies on that.
 *
 * Imported by tests only; it is not part of the package entry.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CertRejection, KeyChangeAlert, OpenPGPHostStores, OwnKeyConflict } from '../hostStores'

/** An adapter under test, in a fresh empty state, with the probes the interface lacks. */
export interface HostStoresUnderTest {
  stores: OpenPGPHostStores
  /** Put an alert in the key-change-alerts map, as the host's own code does. */
  seedKeyChangeAlert(jid: string, alert: KeyChangeAlert): void
  /** Details stored with the latest trust-state status; undefined when none. */
  trustStateDetails(): string[] | undefined
  /** How many peer-keyset changes the host has been told of for a peer. */
  peerKeysetNotifications(jid: string): number
}

const PEER = 'peer@example.com'
const OTHER = 'other@example.com'
const FP_A = 'AAAA1111AAAA1111AAAA1111AAAA1111AAAA1111'
const FP_B = 'BBBB2222BBBB2222BBBB2222BBBB2222BBBB2222'
const alert: KeyChangeAlert = { previousFingerprint: FP_A, currentFingerprint: FP_B, observedAt: '2026-01-01T00:00:00.000Z' }
const rejection: CertRejection = { fingerprint: FP_B, code: 'fingerprint_mismatch', detail: 'announced fingerprint differs from the cert', observedAt: '2026-01-01T00:00:00.000Z' }
const conflict: OwnKeyConflict = { kind: 'primary-mismatch', localFingerprint: FP_A, publishedFingerprint: FP_B, publishedDate: '2026-01-01T00:00:00.000Z' }

export function runHostStoresContract(label: string, create: () => HostStoresUnderTest): void {
  let host: HostStoresUnderTest
  let stores: OpenPGPHostStores
  beforeEach(() => { host = create(); stores = host.stores })

  describe(`${label}: verifiedPeers`, () => {
    it('set and clear change the map and getAll reads it back', () => {
      stores.verifiedPeers.set(PEER, FP_A)
      expect(stores.verifiedPeers.getAll()).toEqual({ [PEER]: FP_A })
      stores.verifiedPeers.clear(PEER)
      expect(stores.verifiedPeers.getAll()).toEqual({})
    })

    it('isVerified ignores case and whitespace and rejects another fingerprint', () => {
      stores.verifiedPeers.set(PEER, FP_A)
      expect(stores.verifiedPeers.isVerified(PEER, FP_A.toLowerCase())).toBe(true)
      expect(stores.verifiedPeers.isVerified(PEER, ` ${FP_A.slice(0, 20)} ${FP_A.slice(20)}`)).toBe(true)
      expect(stores.verifiedPeers.isVerified(PEER, FP_B)).toBe(false)
      expect(stores.verifiedPeers.isVerified(OTHER, FP_A)).toBe(false)
    })

    it('calls the listener synchronously, once per change, with the new and previous map', () => {
      const listener = vi.fn()
      stores.verifiedPeers.subscribe(listener)
      stores.verifiedPeers.set(PEER, FP_A)
      // Delivered before set() returned: no await between the write and this read.
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenLastCalledWith({ [PEER]: FP_A }, {})
      stores.verifiedPeers.clear(PEER)
      expect(listener).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenLastCalledWith({}, { [PEER]: FP_A })
    })

    it('does not call the listener for a write that changes nothing or for another group', () => {
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

    it('lets a listener observe a write made while a remote sync guard is held', () => {
      // The base class skips a publish while it applies a remote list; that only
      // works if the listener runs inside the write, before the guard drops.
      let syncing = 1
      const published: string[] = []
      stores.verifiedPeers.subscribe(() => { if (syncing === 0) published.push('publish') })
      stores.verifiedPeers.set(PEER, FP_A)
      syncing--
      expect(published).toEqual([])
      stores.verifiedPeers.set(OTHER, FP_B)
      expect(published).toEqual(['publish'])
    })
  })

  describe(`${label}: pinnedPrimaryFingerprints`, () => {
    it('set changes the map and getAll reads it back', () => {
      stores.pinnedPrimaryFingerprints.set(PEER, FP_A)
      expect(stores.pinnedPrimaryFingerprints.getAll()).toEqual({ [PEER]: FP_A })
    })

    it('calls the listener synchronously once per change, with the previous map, and not for the same pin', () => {
      const listener = vi.fn()
      stores.pinnedPrimaryFingerprints.subscribe(listener)
      stores.pinnedPrimaryFingerprints.set(PEER, FP_A)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenLastCalledWith({ [PEER]: FP_A }, {})
      stores.pinnedPrimaryFingerprints.set(PEER, FP_A)
      expect(listener).toHaveBeenCalledTimes(1)
      stores.pinnedPrimaryFingerprints.set(PEER, FP_B)
      expect(listener).toHaveBeenCalledTimes(2)
      expect(listener).toHaveBeenLastCalledWith({ [PEER]: FP_B }, { [PEER]: FP_A })
    })
  })

  describe(`${label}: keyChangeAlerts`, () => {
    it('get, getAll and clear read and change the alerts', () => {
      expect(stores.keyChangeAlerts.get(PEER)).toBeNull()
      host.seedKeyChangeAlert(PEER, alert)
      expect(stores.keyChangeAlerts.get(PEER)).toEqual(alert)
      expect(stores.keyChangeAlerts.getAll()).toEqual({ [PEER]: alert })
      stores.keyChangeAlerts.clear(PEER)
      expect(stores.keyChangeAlerts.getAll()).toEqual({})
      expect(stores.keyChangeAlerts.get(PEER)).toBeNull()
    })

    it('calls the listener synchronously once per change, and not when nothing changes', () => {
      const listener = vi.fn()
      stores.keyChangeAlerts.subscribe(listener)
      host.seedKeyChangeAlert(PEER, alert)
      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenLastCalledWith({ [PEER]: alert }, {})
      stores.keyChangeAlerts.clear(OTHER)
      expect(listener).toHaveBeenCalledTimes(1)
      stores.keyChangeAlerts.clear(PEER)
      expect(listener).toHaveBeenCalledTimes(2)
    })
  })

  describe(`${label}: certRejections`, () => {
    it('record, get and clear; get defaults to an empty list', () => {
      expect(stores.certRejections.get(PEER)).toEqual([])
      stores.certRejections.record(PEER, [rejection])
      expect(stores.certRejections.get(PEER)).toEqual([rejection])
      expect(stores.certRejections.get(OTHER)).toEqual([])
      stores.certRejections.clear(PEER)
      expect(stores.certRejections.get(PEER)).toEqual([])
    })
  })

  describe(`${label}: ownKeyConflict`, () => {
    it('record, get and clear', () => {
      expect(stores.ownKeyConflict.get()).toBeNull()
      stores.ownKeyConflict.record(conflict)
      expect(stores.ownKeyConflict.get()).toEqual(conflict)
      stores.ownKeyConflict.clear()
      expect(stores.ownKeyConflict.get()).toBeNull()
    })
  })

  describe(`${label}: trustStateStatus`, () => {
    it('starts uninitialized, keeps the status with its details, and drops details on a plain set', () => {
      expect(stores.trustStateStatus.get()).toBe('uninitialized')
      stores.trustStateStatus.set('compromised', ['verified peers differ'])
      expect(stores.trustStateStatus.get()).toBe('compromised')
      expect(host.trustStateDetails()).toEqual(['verified peers differ'])
      stores.trustStateStatus.set('sealed')
      expect(stores.trustStateStatus.get()).toBe('sealed')
      expect(host.trustStateDetails()).toBeUndefined()
    })
  })

  describe(`${label}: peerKeysets`, () => {
    it('notifyChanged is counted for that peer only', () => {
      stores.peerKeysets.notifyChanged(PEER)
      stores.peerKeysets.notifyChanged(PEER)
      stores.peerKeysets.notifyChanged(OTHER)
      expect(host.peerKeysetNotifications(PEER)).toBe(2)
      expect(host.peerKeysetNotifications(OTHER)).toBe(1)
      expect(host.peerKeysetNotifications('nobody@example.com')).toBe(0)
    })
  })
}
