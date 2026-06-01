import { create } from 'zustand'
import { buildScopedStorageKey } from '@fluux/sdk'

/**
 * Key-change alerts: per-peer entries that say "this peer was once
 * verified, but their advertised fingerprint has changed since then —
 * the user should be told and prompted to re-verify". Alerts are a
 * companion to {@link verifiedPeerKeysStore}: when the plugin demotes
 * a verification because the cached fingerprint changed, it pushes an
 * alert here so the chat header can surface a banner.
 *
 * Two dismissal paths matter:
 *
 * - **Re-verify.** The user opens the verify dialog from the banner,
 *   compares the new fingerprint, and confirms. The verify flow writes
 *   to the verification store AND clears the alert here.
 * - **Acknowledge.** The user clicks "Dismiss" without re-verifying.
 *   The alert clears; trust drops to BTBV `unverified` (the chip's
 *   muted palette) until the user verifies later.
 *
 * Persisted to localStorage so a banner survives a reload — without
 * it, restarting the app would silently swallow a key change the user
 * hasn't acknowledged yet, which is the worst possible outcome for a
 * security-relevant signal.
 */
interface KeyChangeAlert {
  /** Fingerprint the user had previously verified. */
  previousFingerprint: string
  /** Fingerprint now cached for the peer (their current key). */
  currentFingerprint: string
  /** ISO timestamp when the rotation was first observed. Useful for
   *  ordering and for surfacing "key changed N days ago" copy later. */
  observedAt: string
}

interface KeyChangeAlertsState {
  alertsByJid: Record<string, KeyChangeAlert>
  setAlert: (jid: string, alert: KeyChangeAlert) => void
  clearAlert: (jid: string) => void
  rehydrate: () => void
}

const STORAGE_KEY_BASE = 'fluux-e2ee-key-change-alerts'

function getScopedKey(): string {
  return buildScopedStorageKey(STORAGE_KEY_BASE)
}

function loadFromStorage(): Record<string, KeyChangeAlert> {
  try {
    const scopedKey = getScopedKey()
    let raw = localStorage.getItem(scopedKey)

    // Migration: if the scoped key has no data, check the old unscoped key.
    if (!raw && scopedKey !== STORAGE_KEY_BASE) {
      const legacy = localStorage.getItem(STORAGE_KEY_BASE)
      if (legacy) {
        localStorage.setItem(scopedKey, legacy)
        localStorage.removeItem(STORAGE_KEY_BASE)
        raw = legacy
      }
    }

    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, KeyChangeAlert> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof k === 'string' &&
        v &&
        typeof v === 'object' &&
        typeof (v as KeyChangeAlert).previousFingerprint === 'string' &&
        typeof (v as KeyChangeAlert).currentFingerprint === 'string' &&
        typeof (v as KeyChangeAlert).observedAt === 'string'
      ) {
        out[k] = v as KeyChangeAlert
      }
    }
    return out
  } catch {
    return {}
  }
}

function persist(map: Record<string, KeyChangeAlert>): void {
  try {
    localStorage.setItem(getScopedKey(), JSON.stringify(map))
  } catch {
    // Best-effort persistence; in-memory state stays consistent.
  }
}

export const useKeyChangeAlertsStore = create<KeyChangeAlertsState>((set) => ({
  alertsByJid: loadFromStorage(),
  setAlert: (jid, alert) => {
    set((s) => {
      // Idempotent: re-recording the same rotation (same prev → curr
      // pair) shouldn't refresh `observedAt` and force a re-render.
      const existing = s.alertsByJid[jid]
      if (
        existing &&
        existing.previousFingerprint === alert.previousFingerprint &&
        existing.currentFingerprint === alert.currentFingerprint
      ) {
        return s
      }
      const next = { ...s.alertsByJid, [jid]: alert }
      persist(next)
      return { alertsByJid: next }
    })
  },
  clearAlert: (jid) => {
    set((s) => {
      if (!(jid in s.alertsByJid)) return s
      const next = { ...s.alertsByJid }
      delete next[jid]
      persist(next)
      return { alertsByJid: next }
    })
  },
  rehydrate: () => set({ alertsByJid: loadFromStorage() }),
}))

// ---- Imperative helpers ----------------------------------------------
// Used from non-React code (the plugin) just like the verification
// store's helpers.

/**
 * Record a verified-peer key rotation. Called by the plugin when it
 * observes a cached fingerprint change for a previously-verified peer.
 * Idempotent — repeated calls with the same prev/current pair do not
 * duplicate the alert.
 */
export function recordKeyChangeAlert(
  jid: string,
  previousFingerprint: string,
  currentFingerprint: string,
): void {
  useKeyChangeAlertsStore.getState().setAlert(jid, {
    previousFingerprint,
    currentFingerprint,
    observedAt: new Date().toISOString(),
  })
}

/**
 * Clear the alert for `jid`. Called when the user re-verifies (the
 * verify-dialog confirm path) or explicitly dismisses the banner.
 */
export function clearKeyChangeAlert(jid: string): void {
  useKeyChangeAlertsStore.getState().clearAlert(jid)
}

/**
 * Read the current alert for `jid`, or `null` if none. Used by tests
 * and any non-React reader; React subscribers should select via the
 * hook so they re-render on change.
 */
export function getKeyChangeAlert(jid: string): KeyChangeAlert | null {
  return useKeyChangeAlertsStore.getState().alertsByJid[jid] ?? null
}

export function rehydrateKeyChangeAlerts(): void {
  useKeyChangeAlertsStore.getState().rehydrate()
}

export type { KeyChangeAlert }
