import { create } from 'zustand'
import { buildScopedStorageKey } from '@fluux/sdk'
import { fingerprintsEqual } from '@/e2ee/fingerprintCompare'

/**
 * Per-peer fingerprint verifications the user has explicitly confirmed
 * out-of-band — the upgrade from BTBV (`trusted`, "we've seen this peer
 * before") to `verified` (the user has compared the fingerprint with
 * the peer over a second channel and asserted it's correct).
 *
 * Keyed on bare JID. Stores ONLY the verified fingerprint string;
 * isVerified takes both JID and current fingerprint so a key rotation
 * silently demotes trust to `trusted` until the user re-verifies.
 *
 * Persisted to localStorage so verifications survive a reload / app
 * restart — without persistence the user would have to re-verify every
 * peer on every session, which would devalue the action and train them
 * to click through dialogs without reading.
 *
 * Shape mirrors `encryptionSettingsStore`: a single Zustand store, a
 * matching imperative getter for non-React callers (the SequoiaPgpPlugin
 * runs outside React and reads via `getState()`).
 */
interface VerifiedPeerKeysState {
  /**
   * Map of bare JID → verified fingerprint. Plain object rather than a
   * `Map` so JSON serialization for localStorage stays trivial and
   * Zustand's shallow-compare doesn't fight us on every update.
   */
  verifiedFingerprintByJid: Record<string, string>
  setVerified: (jid: string, fingerprint: string) => void
  clearVerified: (jid: string) => void
  rehydrate: () => void
}

const STORAGE_KEY_BASE = 'fluux-e2ee-verified-peers'

function getScopedKey(): string {
  return buildScopedStorageKey(STORAGE_KEY_BASE)
}

function loadFromStorage(): Record<string, string> {
  try {
    const scopedKey = getScopedKey()
    let raw = localStorage.getItem(scopedKey)

    // Migration: if the scoped key has no data, check the old unscoped key.
    if (!raw && scopedKey !== STORAGE_KEY_BASE) {
      const unscopedRaw = localStorage.getItem(STORAGE_KEY_BASE)
      if (unscopedRaw) {
        localStorage.setItem(scopedKey, unscopedRaw)
        localStorage.removeItem(STORAGE_KEY_BASE)
        raw = unscopedRaw
      }
    }

    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    // Defensive: only keep entries shaped like (string, string). A
    // tampered or older-version blob shouldn't poison the store.
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof k === 'string' && typeof v === 'string' && v.length > 0) {
        out[k] = v
      }
    }
    return out
  } catch {
    // localStorage unavailable or JSON corrupt — start clean.
    return {}
  }
}

function persist(map: Record<string, string>): void {
  try {
    localStorage.setItem(getScopedKey(), JSON.stringify(map))
  } catch {
    // Best-effort. A failure to persist still leaves in-memory state
    // consistent for the rest of the session; the user just has to
    // re-verify after a reload.
  }
}

export const useVerifiedPeerKeysStore = create<VerifiedPeerKeysState>((set) => ({
  verifiedFingerprintByJid: loadFromStorage(),
  setVerified: (jid, fingerprint) => {
    set((s) => {
      // Skip the update if the fingerprint we'd write is already what
      // we have — saves a re-render and a localStorage write on the
      // common "user confirms an already-verified key" path.
      if (s.verifiedFingerprintByJid[jid] === fingerprint) return s
      const next = { ...s.verifiedFingerprintByJid, [jid]: fingerprint }
      persist(next)
      return { verifiedFingerprintByJid: next }
    })
  },
  clearVerified: (jid) => {
    set((s) => {
      if (!(jid in s.verifiedFingerprintByJid)) return s
      const next = { ...s.verifiedFingerprintByJid }
      delete next[jid]
      persist(next)
      return { verifiedFingerprintByJid: next }
    })
  },
  rehydrate: () => set({ verifiedFingerprintByJid: loadFromStorage() }),
}))

// ---- Imperative helpers ----------------------------------------------
// The SequoiaPgpPlugin (and any other non-React code) reads via these
// rather than subscribing — there's nothing to re-render outside the
// React tree, and importing a hook from a pure-TS module would create
// a structural dependency on React there.

/**
 * `true` when the user has confirmed `fingerprint` for `jid` out-of-band.
 * Use this in trust-decision paths (`getPeerTrust`,
 * `buildInboundSecurityContext`) to lift `tofu` → `verified`.
 */
export function isPeerVerified(jid: string, fingerprint: string): boolean {
  const stored = useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid[jid]
  // Normalized compare: a fingerprint verified on one OpenPGP backend
  // (e.g. Sequoia, UPPERCASE) and synced to another (openpgp.js, lowercase)
  // must still count as verified. See e2ee/fingerprintCompare.ts.
  return stored !== undefined && fingerprintsEqual(stored, fingerprint)
}

/**
 * Drop the verification entry for `jid`. Called by the plugin when a
 * peer's key rotates: the new fingerprint can't inherit the old one's
 * `verified` state without the user re-confirming, and leaving the
 * stale entry in localStorage just bloats the file.
 */
export function clearPeerVerified(jid: string): void {
  useVerifiedPeerKeysStore.getState().clearVerified(jid)
}

/**
 * Imperative setter parallel to {@link clearPeerVerified}. Used by the
 * plugin's verify-and-accept-rotation flow, which writes a new
 * verification under the just-promoted pin.
 */
export function setPeerVerified(jid: string, fingerprint: string): void {
  useVerifiedPeerKeysStore.getState().setVerified(jid, fingerprint)
}

/**
 * Last fingerprint the user confirmed for `jid`, or `null` if none.
 * Used by the demote-on-rotation path so the plugin can compare the
 * incoming fingerprint against the stored one before evicting.
 */
export function getVerifiedPeerFingerprint(jid: string): string | null {
  return useVerifiedPeerKeysStore.getState().verifiedFingerprintByJid[jid] ?? null
}

export function rehydrateVerifiedPeerKeys(): void {
  useVerifiedPeerKeysStore.getState().rehydrate()
}
