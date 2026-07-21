import { useEffect, useRef } from 'react'
import { useConnectionStatus, getBareJid } from '@fluux/sdk'
import { rehydratePinnedPrimaryFingerprints } from '../stores/pinnedPrimaryFingerprintsStore'
import { rehydrateKeyChangeAlerts } from '../stores/keyChangeAlertsStore'
import { rehydratePlaintextOverrides } from '../stores/conversationPlaintextOverrideStore'
import { rehydrateCertRejections } from '../stores/certRejectionStore'
import { rehydrateEncryptionSettings } from '../stores/encryptionSettingsStore'

/**
 * Rehydrate app-layer persisted stores when the account JID changes.
 *
 * SDK stores (chatStore, roomStore, ignoreStore) are
 * rehydrated inside XMPPClient.connect(). This hook handles the app-layer
 * stores that persist E2EE trust data to localStorage with account-scoped
 * keys — they need to reload from the correct scoped key after
 * setStorageScopeJid() runs.
 *
 * Verified-peer trust used to be rehydrated here too
 * (`rehydrateVerifiedPeerKeys`), but Phase B2 Task 8 deleted the app-side
 * `verifiedPeerKeysStore` it targeted. Per-account isolation for verified
 * state now comes from the OpenPGP plugin's own per-account `ctx.storage`
 * and `init()` re-running (and re-hydrating its `VerifiedKeysCache`) on
 * every account switch — no app-side rehydrate call needed.
 *
 * Must be called in App.tsx BEFORE the registerE2EEPlugins effect so the
 * stores are populated before the plugin reads them.
 */
export function useAccountScopeRehydration(): void {
  const { jid } = useConnectionStatus()
  const bareJid = jid ? getBareJid(jid) : null
  const prevJidRef = useRef<string | null>(null)

  useEffect(() => {
    if (!bareJid || bareJid === prevJidRef.current) return
    prevJidRef.current = bareJid

    rehydratePinnedPrimaryFingerprints()
    rehydrateKeyChangeAlerts()
    rehydratePlaintextOverrides()
    rehydrateCertRejections()
    rehydrateEncryptionSettings()
  }, [bareJid])
}
