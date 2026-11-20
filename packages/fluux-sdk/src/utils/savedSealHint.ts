import { buildScopedStorageKey } from './storageScope'

const KEY = 'fluux-saved-sealing'

/**
 * Whether this account sealed saved messages the last time its OpenPGP plugin was known.
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

/** Forget the hint of one account, or of every account. */
export function clearSealHint(jid: string | null, allAccounts: boolean): void {
  try {
    if (allAccounts) {
      for (const key of Object.keys(localStorage)) if (key === KEY || key.startsWith(`${KEY}:`)) localStorage.removeItem(key)
    } else {
      localStorage.removeItem(buildScopedStorageKey(KEY, jid))
      if (!jid) localStorage.removeItem(KEY)
    }
  } catch { /* storage unavailable */ }
}
