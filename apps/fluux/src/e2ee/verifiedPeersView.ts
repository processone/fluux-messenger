/**
 * App-side holder for the plugin-owned `VerifiedKeysView` (Task 2), plus the
 * reactive/imperative reads consumed by the app's UI (Tasks 4 and 5).
 *
 * The unregistered-plugin contract: there are real states with no OpenPGP
 * plugin registered (before registration completes, OpenPGP disabled in
 * settings, OMEMO-only setups). In those states every read here returns
 * `null` and `subscribe` is a safe no-op — nothing throws. The holder keeps
 * its OWN listener set, independent of the view's, so a component that
 * subscribes before a plugin exists (or after one is torn down) stays
 * subscribed: `setVerifiedKeysView` always notifies the holder's listeners,
 * even when there is no view to relay further notifications from.
 */
import { useSyncExternalStore } from 'react'
import type { VerifiedKeysView } from '@fluux/openpgp-plugin'

let currentView: VerifiedKeysView | null = null
const holderListeners = new Set<() => void>()
let unsubscribeFromView: (() => void) | null = null

function notifyHolder(): void {
  // Snapshot before iterating (a listener may subscribe/unsubscribe during
  // notification) and isolate each listener with try/catch, mirroring
  // `VerifiedKeysCache.notify` (packages/openpgp-plugin/src/verifiedKeysCache.ts).
  // `setVerifiedKeysView` is called from inside `registerE2EEPlugins`'s try
  // block, so an uncaught throw here would be mistaken for a registration
  // failure even though registration itself already succeeded.
  for (const listener of [...holderListeners]) {
    try {
      listener()
    } catch {
      // One bad subscriber must not stop the others or abort registration.
    }
  }
}

/**
 * Called by `registerPlugins.ts` right after a successful OpenPGP
 * `register()` (with the freshly registered plugin's view), and with `null`
 * when the OpenPGP plugin is unregistered. Always notifies the holder's own
 * listeners — including on the `null` transition — so already-mounted
 * `useVerifiedFingerprint` subscribers re-read immediately instead of
 * showing stale state until their next unrelated re-render.
 */
export function setVerifiedKeysView(view: VerifiedKeysView | null): void {
  unsubscribeFromView?.()
  currentView = view
  unsubscribeFromView = view ? view.subscribe(notifyHolder) : null
  notifyHolder()
}

/**
 * Exported (beyond `useVerifiedFingerprint`'s internal use via
 * `useSyncExternalStore`) so tests can attach a raw listener directly and
 * exercise `notifyHolder`'s isolation contract without going through React's
 * own scheduling/error-boundary behavior. See `verifiedPeersView.test.ts`.
 */
export function subscribe(listener: () => void): () => void {
  holderListeners.add(listener)
  return () => holderListeners.delete(listener)
}

/** Non-reactive imperative read, for effect bodies that need a synchronous value. */
export function getVerifiedFingerprintNow(jid: string): string | null {
  return currentView?.getVerifiedFingerprint(jid) ?? null
}

/**
 * Reactive verified-fingerprint read for a single peer JID. Returns a
 * PRIMITIVE (`string | null`), not a handle — callers put this straight into
 * React dependency arrays and memo comparisons, so a fresh object here would
 * re-fire probe effects (network round-trips) on every render even when the
 * underlying value hasn't changed.
 *
 * Called unconditionally with a possibly-null peer; `jid === null` always
 * yields `null` without touching the view.
 */
export function useVerifiedFingerprint(jid: string | null): string | null {
  return useSyncExternalStore(subscribe, () => (jid ? getVerifiedFingerprintNow(jid) : null))
}
