import { useEffect, useRef } from 'react'
import { useConnectionStatus, getBareJid } from '@fluux/sdk'
import { rehydratePlaintextOverrides } from '../stores/conversationPlaintextOverrideStore'
import { rehydrateEncryptionSettings } from '../stores/encryptionSettingsStore'

/**
 * Rehydrate app-layer persisted stores when the account JID changes.
 *
 * SDK stores (chatStore, roomStore, ignoreStore) are
 * rehydrated inside XMPPClient.connect(). This hook handles the app-layer
 * stores that persist E2EE settings to localStorage with account-scoped
 * keys — they need to reload from the correct scoped key after
 * setStorageScopeJid() runs. Trust decisions are not among them: the
 * OpenPGP plugin keeps those in its own per-account storage.
 *
 * Must be called in App.tsx BEFORE the registerE2EEPlugins effect so the
 * stores are populated before the plugin registers.
 */
export function useAccountScopeRehydration(): void {
  const { jid } = useConnectionStatus()
  const bareJid = jid ? getBareJid(jid) : null
  const prevJidRef = useRef<string | null>(null)

  useEffect(() => {
    if (!bareJid || bareJid === prevJidRef.current) return
    prevJidRef.current = bareJid

    rehydratePlaintextOverrides()
    rehydrateEncryptionSettings()
  }, [bareJid])
}
