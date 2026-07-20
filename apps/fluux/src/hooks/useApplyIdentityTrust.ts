import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useToastStore } from '@/stores/toastStore'

/** Shape every `setIdentityTrust`-capable plugin/trait handle exposes. */
export interface IdentityTrustCapable {
  setIdentityTrust?: (
    peer: string,
    id: string,
    decision: 'verified' | 'untrusted',
  ) => Promise<void>
}

/**
 * Shared verify/revoke apply for every entry point that persists a
 * per-identity trust decision through a plugin's `setIdentityTrust` (the
 * OpenPGP chat-header verify/revoke in `ChatView`, and the OMEMO/OpenPGP
 * identity list in `ContactProfileView`).
 *
 * `setIdentityTrust` now `await`s `PluginStorage.put` under the hood
 * (`VerifiedKeysCache`'s write-behind persistence) — a keychain/IPC/disk
 * write that can reject. This helper is the ONE place that:
 *
 * - awaits the call, so a success toast never fires ahead of the actual
 *   write;
 * - catches a rejection and surfaces an error toast instead of leaving an
 *   unhandled promise rejection (the defect this hook was extracted to
 *   close for good — see Phase B1 final-review Findings 1 & the ChatView
 *   fix it mirrors);
 * - treats "the plugin/trait is unavailable" (not registered, feature
 *   disabled) as its own failure rather than crashing or silently
 *   claiming success.
 *
 * Resolves the plugin via a callback (not a pre-bound reference) so it is
 * always looked up fresh at call time, matching how `ChatView` originally
 * resolved `client.e2ee?.getPlugin('openpgp')`.
 *
 * Returns whether the write actually succeeded, so callers can gate
 * follow-up UI state (e.g. bumping a reload key, closing a dialog) on the
 * real outcome instead of assuming success.
 */
export function useApplyIdentityTrust() {
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)

  return useCallback(
    async (
      resolvePlugin: () => IdentityTrustCapable | null | undefined,
      peer: string,
      id: string,
      decision: 'verified' | 'untrusted',
      successKey: string,
      failureKey: string,
    ): Promise<boolean> => {
      const plugin = resolvePlugin()
      if (!plugin?.setIdentityTrust) {
        addToast('error', t(failureKey))
        return false
      }
      try {
        await plugin.setIdentityTrust(peer, id, decision)
        addToast('success', t(successKey))
        return true
      } catch (err) {
        addToast('error', t(failureKey))
        console.error('[Fluux] setIdentityTrust failed:', err)
        return false
      }
    },
    [addToast, t],
  )
}
