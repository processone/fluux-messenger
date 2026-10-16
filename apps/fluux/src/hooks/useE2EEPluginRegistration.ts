import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { getBareJid, type E2EEManager } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { registerE2EEPlugins } from '@/e2ee/registerPlugins'
import { isOpenpgpEnabled } from '@/stores/encryptionSettingsStore'

/** Register plugins when their account-bound host is ready, including a late mount. */
export function useE2EEPluginRegistration(
  client: XMPPClient,
  onRegistered: (manager: E2EEManager) => Promise<void>,
): void {
  const subscribe = useCallback(
    (onChange: () => void) => client.subscribe('e2ee:manager-ready', onChange),
    [client],
  )
  const getManager = useCallback(() => client.e2ee, [client])
  const manager = useSyncExternalStore(subscribe, getManager, () => null)

  // Run in React's effect order so account-scoped settings rehydrate before
  // the plugin reads them; the SDK signal can arrive before that render.
  useEffect(() => {
    if (!manager || client.e2ee !== manager) return
    let disposed = false
    let running = false
    let retryEligible = false
    let accountCurrent = true
    const isCurrent = () => !disposed && accountCurrent
      && client.e2ee === manager && isOpenpgpEnabled()
    const register = async () => {
      running = true
      try {
        do {
          retryEligible = false
          await registerE2EEPlugins(client)
        } while (retryEligible && isCurrent() && !manager.getPlugin('openpgp'))
        if (isCurrent() && manager.getPlugin('openpgp')) await onRegistered(manager)
      } catch (error: unknown) {
        console.error('[Fluux] OpenPGP post-registration initialization failed:', error)
      } finally {
        running = false
      }
    }
    const unsubscribe = client.subscribe('connection:authenticated', ({ jid }) => {
      accountCurrent = manager.getAccountJid() === getBareJid(jid)
      if (!isCurrent() || manager.getPlugin('openpgp')) return
      if (running) retryEligible = true
      else void register()
    })
    void register()
    return () => {
      disposed = true
      unsubscribe()
    }
  }, [client, manager, onRegistered])
}
