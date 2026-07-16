/**
 * Web silent-restore for the OpenPGP session passphrase.
 *
 * When the web key is locked at connect time, try the opt-in 24h cache before
 * prompting: if a valid cached passphrase exists, unlock the key silently. On a
 * cache miss, a missing plugin, or ANY unlock failure (e.g. a rotated key), fall
 * back to the interactive unlock dialog so the user is never stranded. A failed
 * unlock also clears the now-stale cache entry.
 *
 * Extracted from the App connect handler so the branch logic is unit-testable
 * without rendering the whole app.
 */
import { loadCachedPassphrase, clearCachedPassphrase } from '@fluux/openpgp-plugin'

interface UnlockCapablePlugin {
  unlock?: (passphrase: string) => Promise<{ recovered: boolean }>
}

export interface AttemptCachedUnlockOptions {
  /** Bare JID of the just-connected account (null if unavailable). */
  accountJid: string | null
  /** Resolves the OpenPGP plugin, or null/undefined if not registered. */
  getUnlockPlugin: () => UnlockCapablePlugin | null | undefined
  /** Opens the interactive unlock dialog (the fallback). */
  openDialog: () => void
}

export async function attemptCachedUnlockOrPrompt({
  accountJid,
  getUnlockPlugin,
  openDialog,
}: AttemptCachedUnlockOptions): Promise<void> {
  const cached = accountJid ? await loadCachedPassphrase(accountJid) : null
  if (!cached) {
    openDialog()
    return
  }
  const plugin = getUnlockPlugin()
  if (!plugin?.unlock) {
    // No plugin to unlock with: fall back to the dialog rather than strand the user.
    openDialog()
    return
  }
  try {
    await plugin.unlock(cached)
    // success: key unlocked silently, dialog stays closed
  } catch {
    if (accountJid) await clearCachedPassphrase(accountJid)
    openDialog()
  }
}
