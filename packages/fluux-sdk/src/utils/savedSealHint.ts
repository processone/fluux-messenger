import { buildScopedStorageKey } from './storageScope'

const KEY = 'fluux-saved-sealing'

/**
 * Whether OpenPGP is on for this account on this device, as the app's setting says (the app is its only writer).
 * The plugin registers some time after the session is up (it loads a key, which can wait on a prompt),
 * and until then it cannot say whether OpenPGP is on: this remembered answer keeps a save made in that
 * window from being written in clear.
 */
export function readSealHint(): boolean {
  try { return localStorage.getItem(buildScopedStorageKey(KEY)) === '1' } catch { return false }
}

export function writeSealHint(on: boolean): void {
  try {
    const key = buildScopedStorageKey(KEY)
    if (on) localStorage.setItem(key, '1')
    else localStorage.removeItem(key)
  } catch { /* storage unavailable: the hint is only a safeguard */ }
}
