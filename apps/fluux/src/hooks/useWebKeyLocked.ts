import { useSyncExternalStore } from 'react'
import { isKeyLocked, subscribeKeyLockState } from '@/e2ee/webPassphraseStore'
import { isTauri } from '@/utils/tauri'

/**
 * Reactive view of the web E2EE session-passphrase lock state.
 *
 * Returns `true` while the OpenPGP private key is locked (no session
 * passphrase set this session) so consumers can surface unlock affordances
 * (header lock icon, clickable encrypted-message placeholder, etc.).
 *
 * Always returns `false` on Tauri: the desktop build uses the
 * `SequoiaPgpPlugin` which manages key material in the Rust process and
 * doesn't go through the web passphrase store.
 */
export function useWebKeyLocked(): boolean {
  const locked = useSyncExternalStore(
    subscribeKeyLockState,
    isKeyLocked,
    // SSR fallback: assume locked so we never render an interactive
    // "unlocked" state during hydration without confirmation.
    () => true,
  )
  if (isTauri()) return false
  return locked
}
