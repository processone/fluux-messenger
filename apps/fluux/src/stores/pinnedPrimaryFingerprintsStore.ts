import { create } from 'zustand'
import { buildScopedStorageKey } from '@fluux/sdk'

/**
 * Per-peer primary-key fingerprint pins — the cryptographic anchor of
 * Fluux's server-tampering defenses.
 *
 * Distinct from {@link verifiedPeerKeysStore}:
 *
 * - **Pin**: "this is the primary fingerprint Fluux currently trusts to
 *   encrypt to this peer." Auto-set on first contact (TOFU) and changed
 *   ONLY by an explicit user action. A pin mismatch on a subsequent
 *   key fetch is treated as suspicious — encryption to that peer is
 *   blocked until the user resolves the change.
 *
 * - **Verification**: a stronger statement layered on top — "the user
 *   confirmed this exact fingerprint over a second channel." Pinning
 *   without verification is BTBV (trust-on-first-use); pinning with
 *   verification is the green-checkmark `verified` state.
 *
 * Every cached peer key has a pin. Pins survive process restarts via
 * localStorage so the auto-block-on-rotation invariant holds across
 * sessions — without persistence, the very first observation after a
 * reload would silently re-pin and the protection vanishes.
 *
 * The user-visible flow when a pin mismatch is detected:
 *   1. Server advertises a new fingerprint for the peer.
 *   2. The plugin keeps the OLD cert in its in-memory cache and records
 *      a key-change alert (see {@link keyChangeAlertsStore}).
 *   3. Outbound encryption refuses while the alert is live.
 *   4. The chat header surfaces a banner; the user either verifies the
 *      new fingerprint via a second channel (preferred — promotes to
 *      `verified`) or explicitly accepts the change without
 *      verification (BTBV re-pin). Either path updates the pin to the
 *      new fingerprint and unblocks encryption.
 */
interface PinnedPrimaryFingerprintsState {
  pinnedFingerprintByJid: Record<string, string>
  setPinned: (jid: string, fingerprint: string) => void
  clearPinned: (jid: string) => void
  rehydrate: () => void
}

const STORAGE_KEY_BASE = 'fluux-e2ee-pinned-primary-fingerprints'

function getScopedKey(): string {
  return buildScopedStorageKey(STORAGE_KEY_BASE)
}

function loadFromStorage(): Record<string, string> {
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
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && v.length > 0) {
        out[k] = v
      }
    }
    return out
  } catch {
    return {}
  }
}

function persist(map: Record<string, string>): void {
  try {
    localStorage.setItem(getScopedKey(), JSON.stringify(map))
  } catch {
    // Best-effort. In-memory state stays consistent for the rest of the
    // session; the pin would auto-restore on next first-cache after a
    // reload — equivalent to TOFU on a fresh install for that peer.
  }
}

export const usePinnedPrimaryFingerprintsStore = create<PinnedPrimaryFingerprintsState>(
  (set) => ({
    pinnedFingerprintByJid: loadFromStorage(),
    setPinned: (jid, fingerprint) => {
      set((s) => {
        // No-op if the same fp is being re-pinned — saves a render and
        // a localStorage write on the common "first cache, then a
        // re-probe of the same key" path.
        if (s.pinnedFingerprintByJid[jid] === fingerprint) return s
        const next = { ...s.pinnedFingerprintByJid, [jid]: fingerprint }
        persist(next)
        return { pinnedFingerprintByJid: next }
      })
    },
    clearPinned: (jid) => {
      set((s) => {
        if (!(jid in s.pinnedFingerprintByJid)) return s
        const next = { ...s.pinnedFingerprintByJid }
        delete next[jid]
        persist(next)
        return { pinnedFingerprintByJid: next }
      })
    },
    rehydrate: () => set({ pinnedFingerprintByJid: loadFromStorage() }),
  }),
)

// ---- Imperative helpers ----------------------------------------------

/**
 * Last fingerprint Fluux decided to trust for `jid`, or `null` if none
 * has been pinned yet (e.g., never-contacted peer, or post-reset state).
 * `null` means "any fingerprint observed in the next probe will be
 * accepted as the TOFU pin"; a non-null value gates against rotation.
 */
export function getPinnedPrimaryFp(jid: string): string | null {
  return (
    usePinnedPrimaryFingerprintsStore.getState().pinnedFingerprintByJid[jid] ?? null
  )
}

/**
 * Promote `fingerprint` to be the trusted pin for `jid`. Used by the
 * plugin on first cache (TOFU) and by the user-driven accept flow when
 * resolving a rotation alert. Idempotent — re-pinning the same value
 * is a no-op.
 */
export function setPinnedPrimaryFp(jid: string, fingerprint: string): void {
  usePinnedPrimaryFingerprintsStore.getState().setPinned(jid, fingerprint)
}

/**
 * Drop the pin for `jid`. Reserved for destructive actions like
 * "forget this peer" — we never auto-clear because losing a pin
 * effectively re-arms the silent-re-pin attack we built this layer to
 * prevent.
 */
export function clearPinnedPrimaryFp(jid: string): void {
  usePinnedPrimaryFingerprintsStore.getState().clearPinned(jid)
}

export function rehydratePinnedPrimaryFingerprints(): void {
  usePinnedPrimaryFingerprintsStore.getState().rehydrate()
}
