import { connectionStore } from '@fluux/sdk'
import i18n from 'i18next'
import { setPreviewLedgerSession, clearPreviewLedgerSession, startIOSReadLedger } from './previewReadLedger'
import type { XMPPClient } from '@fluux/sdk/core'
import { platform } from '@/platform'
import { getCredentials } from '@/utils/keychain'
import { getSession } from '@/hooks/useSessionPersistence'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { usePeerKeysetRevisionStore } from '@/stores/peerKeysetRevisionStore'
import { useTrustStateStatusStore } from '@/stores/trustStateStatusStore'
import { usePinnedPrimaryFingerprintsStore } from '@/stores/pinnedPrimaryFingerprintsStore'
import { useVerifiedPeerKeysStore } from '@/stores/verifiedPeerKeysStore'
import { useKeyChangeAlertsStore } from '@/stores/keyChangeAlertsStore'
import { useIOSPreviewSettingsStore } from './previewSettings'

export interface PreviewState {
  account: string | null
  enabled: boolean
  ready: boolean
  peers: Record<string, { fingerprint: string; publicArmored: string }[]>
}
export interface PreviewDependencies {
  state: () => PreviewState
  prepare: (account: string) => Promise<Record<string, unknown>>
  write: (snapshot: Record<string, unknown> | null, purge?: boolean) => Promise<void>
}
let writeQueue = Promise.resolve()
function enqueue(write: () => Promise<void>): Promise<void> {
  const next = writeQueue.then(write)
  writeQueue = next.catch(() => {})
  return next
}
export function createPreviewController(deps: PreviewDependencies) {
  let generation = 0
  let stopped = false
  let account: string | null = deps.state().account
  return {
    async refresh() {
      const version = ++generation
      const state = deps.state()
      // Delete first: changed trust or identity cannot leave an older capability active.
      const purge = state.account != null && (!state.enabled || (account != null && state.account !== account))
      await enqueue(() => deps.write(null, purge))
      account = state.account
      const current = () => !stopped && version === generation && deps.state().account === state.account && deps.state().enabled
      if (!state.account || !state.enabled || !state.ready || !current()) return
      const material = await deps.prepare(state.account)
      if (!current()) return
      await enqueue(async () => {
        if (current()) await deps.write({ ...material, account: state.account, opt_in: true, peers: state.peers })
      })
    },
    async stop(purge = false) { stopped = true; generation++; await enqueue(() => deps.write(null, purge)) },
  }
}
let refreshActive: (() => Promise<void>) | undefined
let stopActive: (() => Promise<void>) | undefined
async function write(snapshot: Record<string, unknown> | null, purge = false): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  if (purge) clearPreviewLedgerSession()
  const session = await invoke<{ account: string; epoch: string }>('plugin:push|set_notification_preview', { snapshot, operation: purge ? 'purge' : snapshot ? 'publish' : 'revoke' })
  if (snapshot && session?.epoch) setPreviewLedgerSession(session)
}
export async function purgeIOSNotificationPreviews(): Promise<void> {
  if (!platform().usesNativePush || platform().os !== 'ios') return
  if (stopActive) await stopActive()
  else await enqueue(() => write(null, true))
}
export async function setIOSNotificationPreviews(enabled: boolean): Promise<void> {
  useIOSPreviewSettingsStore.getState().setEnabled(enabled)
  try { await refreshActive?.() }
  catch {
    useIOSPreviewSettingsStore.getState().setEnabled(false)
    await refreshActive?.()
    throw new Error('Notification preview provisioning unavailable')
  }
}
/** One guarded entry point owns provisioning for the current app session. */
export function startIOSNotificationPreviews(client: XMPPClient): () => void {
  if (!platform().usesNativePush || platform().os !== 'ios') return () => {}
  type PreviewPlugin = { getOwnFingerprint?: () => string | null; notificationVerifierSnapshot?: (account: string) => PreviewState['peers'] | null }
  const state = (): PreviewState => {
    const account = connectionStore.getState().jid?.split('/')[0] ?? null
    const plugin = client.e2ee?.getPlugin('openpgp') as PreviewPlugin | undefined
    const settings = useIOSPreviewSettingsStore.getState()
    const peers = account ? plugin?.notificationVerifierSnapshot?.(account) : null
    return { account, enabled: settings.account === account && settings.enabled,
      ready: useEncryptionSettingsStore.getState().openpgpEnabled && !!plugin?.getOwnFingerprint?.() && peers != null,
      peers: peers ?? {} }
  }
  const controller = createPreviewController({ state, write, prepare: async (account) => {
    const session = getSession(account)
    const credentials = session?.jid.split('/')[0] === account && session.password ? session : await getCredentials()
    if (credentials?.jid.split('/')[0] !== account || !credentials.password) throw new Error('No fetch credential')
    const { invoke } = await import('@tauri-apps/api/core')
    const material = await invoke<Record<string, unknown>>('ios_notification_preview_material', {
      accountJid: account, server: credentials.server || account.split('@')[1],
    })
    return { ...material, password: credentials.password, words: i18n.getResourceBundle(i18n.resolvedLanguage || 'en', 'translation')?.notificationPreview }
  } })
  const refresh = () => controller.refresh()
  refreshActive = refresh
  stopActive = () => controller.stop(true)
  const schedule = () => { void refresh().catch(() => {}) }
  const updateAccount = () => {
    const account = connectionStore.getState().jid?.split('/')[0] ?? null
    if (account !== useIOSPreviewSettingsStore.getState().account) {
      useIOSPreviewSettingsStore.getState().setAccount(account)
      schedule()
    }
  }
  const stopReadLedger = startIOSReadLedger()
  updateAccount()
  const unsubscribes = [connectionStore.subscribe(updateAccount),
    useEncryptionSettingsStore.subscribe(schedule), usePeerKeysetRevisionStore.subscribe(schedule),
    useKeyChangeAlertsStore.subscribe(schedule), useTrustStateStatusStore.subscribe(schedule),
    usePinnedPrimaryFingerprintsStore.subscribe(schedule), useVerifiedPeerKeysStore.subscribe(schedule)]
  i18n.on('languageChanged', schedule)
  schedule()
  return () => {
    i18n.off('languageChanged', schedule)
    stopReadLedger()
    unsubscribes.forEach(unsubscribe => unsubscribe())
    if (refreshActive === refresh) { refreshActive = undefined; stopActive = undefined }
    void controller.stop().catch(() => {})
  }
}
