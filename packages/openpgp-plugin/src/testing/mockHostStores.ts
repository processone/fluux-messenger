// In-memory `OpenPGPHostStores` for package tests. Mirrors the app stores'
// idempotency (skip-if-equal on set) and subscribe fan-out so plugin tests
// observe the same scheduling behaviour they did against the real stores.
// Test utility only — never re-exported from the package index.
import type {
  OpenPGPHostStores,
  CertRejection,
  KeyChangeAlert,
  OwnKeyConflict,
  TrustStateStatus,
} from '../hostStores'

export interface MockHostStores extends OpenPGPHostStores {
  /** Reset all in-memory state + listeners (call in `beforeEach`). */
  _reset(): void
}

export function createMockHostStores(): MockHostStores {
  let pinned: Record<string, string> = {}
  let alerts: Record<string, KeyChangeAlert> = {}
  let rejections: Record<string, CertRejection[]> = {}
  let conflict: OwnKeyConflict | null = null
  let status: TrustStateStatus = 'uninitialized'

  const pinnedListeners = new Set<() => void>()
  const alertListeners = new Set<() => void>()

  return {
    certRejections: {
      record: (jid, r) => {
        rejections = { ...rejections, [jid]: r }
      },
      clear: (jid) => {
        if (!(jid in rejections)) return
        rejections = { ...rejections }
        delete rejections[jid]
      },
    },
    keyChangeAlerts: {
      record: (jid, prev, curr) => {
        const existing = alerts[jid]
        if (existing && existing.previousFingerprint === prev && existing.currentFingerprint === curr) return
        alerts = {
          ...alerts,
          [jid]: { previousFingerprint: prev, currentFingerprint: curr, observedAt: new Date().toISOString() },
        }
        alertListeners.forEach((l) => l())
      },
      clear: (jid) => {
        if (!(jid in alerts)) return
        alerts = { ...alerts }
        delete alerts[jid]
        alertListeners.forEach((l) => l())
      },
      get: (jid) => alerts[jid] ?? null,
      getAll: () => alerts,
      subscribe: (l) => {
        alertListeners.add(l)
        return () => alertListeners.delete(l)
      },
    },
    ownKeyConflict: {
      record: (c) => {
        conflict = c
      },
      clear: () => {
        conflict = null
      },
      get: () => conflict,
    },
    pinnedPrimaryFingerprints: {
      get: (jid) => pinned[jid] ?? null,
      set: (jid, fp) => {
        if (pinned[jid] === fp) return
        pinned = { ...pinned, [jid]: fp }
        pinnedListeners.forEach((l) => l())
      },
      getAll: () => pinned,
      subscribe: (l) => {
        pinnedListeners.add(l)
        return () => pinnedListeners.delete(l)
      },
    },
    trustStateStatus: {
      set: (s) => {
        status = s
      },
      get: () => status,
    },
    _reset: () => {
      pinned = {}
      alerts = {}
      rejections = {}
      conflict = null
      status = 'uninitialized'
      pinnedListeners.clear()
      alertListeners.clear()
    },
  }
}
