/**
 * App adapter for {@link OpenPGPHostStores}: delegates each group to the
 * zustand store that owns that state. Built once per plugin by
 * `registerPlugins` (and the demo fixtures) and passed to the plugin's
 * constructor; the plugin itself imports no app store.
 *
 * Zustand delivers `subscribe` listeners synchronously inside `set`, which the
 * interface requires; `subscribeToMap` forwards only real changes of the map.
 */

import type { HostMapListener, OpenPGPHostStores } from '@fluux/openpgp-plugin'
import {
  clearPeerVerified,
  isPeerVerified,
  setPeerVerified,
  useVerifiedPeerKeysStore,
} from '@/stores/verifiedPeerKeysStore'
import { clearKeyChangeAlert, getKeyChangeAlert, useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { clearOwnKeyConflict, getOwnKeyConflict, recordOwnKeyConflict } from '@/stores/ownKeyConflictStore'
import { setPinnedPrimaryFp, usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { clearCertRejections, getCertRejections, recordCertRejections } from '@/stores/certRejectionStore'
import { notifyPeerKeysetChanged } from '@/stores/peerKeysetRevisionStore'
import { getTrustStateStatus, setTrustStateStatus } from '@/stores/trustStateStatusStore'

function subscribeToMap<S, T>(
  subscribe: (listener: (state: S, prev: S) => void) => () => void,
  select: (state: S) => Record<string, T>,
  listener: HostMapListener<T>,
): () => void {
  return subscribe((state, prev) => {
    const next = select(state)
    const before = select(prev)
    if (next !== before) listener(next, before)
  })
}

export function createAppHostStores(): OpenPGPHostStores {
  return {
    verifiedPeers: {
      isVerified: isPeerVerified,
      set: setPeerVerified,
      clear: clearPeerVerified,
      getAll: () => useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid,
      subscribe: (listener) => subscribeToMap(
        useVerifiedPeerKeysStore.subscribe, (s) => s.verifiedFingerprintByJid, listener,
      ),
    },
    certRejections: {
      record: recordCertRejections,
      clear: clearCertRejections,
      get: getCertRejections,
    },
    keyChangeAlerts: {
      get: getKeyChangeAlert,
      clear: clearKeyChangeAlert,
      getAll: () => useKeyChangeAlertsStore.getState().alertsByJid,
      subscribe: (listener) => subscribeToMap(
        useKeyChangeAlertsStore.subscribe, (s) => s.alertsByJid, listener,
      ),
    },
    ownKeyConflict: {
      record: recordOwnKeyConflict,
      clear: clearOwnKeyConflict,
      get: getOwnKeyConflict,
    },
    pinnedPrimaryFingerprints: {
      set: setPinnedPrimaryFp,
      getAll: () => usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid,
      subscribe: (listener) => subscribeToMap(
        usePinnedPrimaryFingerprintsStore.subscribe, (s) => s.pinnedFingerprintByJid, listener,
      ),
    },
    trustStateStatus: {
      set: setTrustStateStatus,
      get: getTrustStateStatus,
    },
    peerKeysets: {
      notifyChanged: notifyPeerKeysetChanged,
    },
  }
}
