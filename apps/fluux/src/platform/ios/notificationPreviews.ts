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
import { useIOSPreviewSettingsStore, type PreviewFailure, type PreviewProblem } from './previewSettings'

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
export type { PreviewProblem }
export class PreviewProvisioningError extends Error {
  constructor(readonly problem: PreviewProblem, readonly detail?: string) {
    super(`Notification preview provisioning failed: ${problem}`)
  }
}
/** The native command reports these codes; anything else is not actionable by the user. */
const NATIVE_PROBLEMS: Record<string, PreviewProblem> = {
  'key-unavailable': 'key', 'server-unreachable': 'server', 'credential-refused': 'refused',
}
function problemOf(error: unknown): PreviewProblem {
  if (error instanceof PreviewProvisioningError) return error.problem
  return (typeof error === 'string' && NATIVE_PROBLEMS[error]) || 'unavailable'
}
/** Native errors name a step and a status code, never a credential or key. */
function failureOf(error: unknown): PreviewFailure {
  if (error instanceof PreviewProvisioningError) return { problem: error.problem, detail: error.detail }
  const problem = problemOf(error)
  if (problem !== 'unavailable') return { problem }
  const detail = typeof error === 'string' ? error : error instanceof Error ? error.message : undefined
  return { problem, detail: detail?.slice(0, 200) }
}
export interface ExtensionToken { account: string; userAgentId: string; token: string; expiry?: string }
export interface CredentialDependencies {
  saved: (account: string) => Promise<{ password: string; server?: string | null } | null>
  /** The extension's user agent, and whether it already holds a FAST token for `account`. */
  tokenStatus: (account: string) => Promise<{ userAgentId: string; present: boolean }>
  provision: (request: { account: string; server: string; password: string; userAgentId: string }) => Promise<{ token: string; expiry: string }>
  storeToken: (token: ExtensionToken) => Promise<void>
}
/** A password typed under the setting, kept for this app session only. */
let entered: { account: string; password: string } | null = null
/** The last password the server refused, so a refresh does not sign in with it again. */
let refused: { account: string; password: string } | null = null
/**
 * Makes sure the notification extension holds its own FAST token and returns the password the
 * snapshot carries, which may be empty: the extension then signs in with its token alone.
 */
export async function ensureExtensionCredential(account: string, deps: CredentialDependencies): Promise<{ password: string; server: string }> {
  const settings = useIOSPreviewSettingsStore.getState()
  const typed = entered?.account === account ? entered.password : null
  const saved = await deps.saved(account)
  const password = typed ?? saved?.password ?? ''
  const server = saved?.server || account.split('@')[1]
  const status = await deps.tokenStatus(account)
  if (!status.present) {
    if (!password || (refused?.account === account && refused.password === password)) {
      settings.setMissingCredential(true)
      throw new PreviewProvisioningError('credential')
    }
    let issued: { token: string; expiry: string }
    try { issued = await deps.provision({ account, server, password, userAgentId: status.userAgentId }) }
    catch (error) {
      if (problemOf(error) === 'refused') {
        refused = { account, password }
        if (typed) entered = null
        settings.setMissingCredential(true)
      }
      throw error
    }
    await deps.storeToken({ account, userAgentId: status.userAgentId, ...issued })
  }
  settings.setMissingCredential(false)
  return { password, server }
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
  const session = await invoke<{ account?: string; epoch?: string; released?: ExtensionToken }>('plugin:push|set_notification_preview', { snapshot, operation: purge ? 'purge' : snapshot ? 'publish' : 'revoke' })
  if (snapshot && session?.account && session.epoch) setPreviewLedgerSession({ account: session.account, epoch: session.epoch })
  // Best effort: an unreachable server keeps the token until it expires unused.
  const released = session?.released
  if (released) {
    void invoke('ios_notification_preview_invalidate', {
      accountJid: released.account, server: getSession(released.account)?.server ?? '',
      userAgentId: released.userAgentId, token: released.token,
    }).catch(() => {})
  }
}
export async function purgeIOSNotificationPreviews(): Promise<void> {
  if (!platform().usesNativePush || platform().os !== 'ios') return
  entered = null; refused = null
  if (stopActive) await stopActive()
  else await enqueue(() => write(null, true))
}
/** `password` is one the user just typed because no saved password could issue a token. */
export async function setIOSNotificationPreviews(enabled: boolean, password?: string): Promise<void> {
  const account = useIOSPreviewSettingsStore.getState().account
  if (password && account) entered = { account, password }
  // A failure leaves the user's choice in place: the setting explains it and later refreshes retry.
  useIOSPreviewSettingsStore.getState().setEnabled(enabled)
  try { await refreshActive?.() }
  catch (error) {
    const { problem, detail } = failureOf(error)
    throw new PreviewProvisioningError(problem, detail)
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
    const { invoke } = await import('@tauri-apps/api/core')
    const session = getSession(account)
    const found = session?.jid.split('/')[0] === account && session.password ? session : await getCredentials()
    const credentials = found?.jid.split('/')[0] === account ? found : null
    const material = await invoke<Record<string, unknown>>('ios_notification_preview_material', {
      accountJid: account, server: credentials?.server || account.split('@')[1],
    })
    const { password } = await ensureExtensionCredential(account, {
      saved: async () => credentials,
      tokenStatus: (account) => invoke('plugin:push|set_notification_preview', { operation: 'fastToken', account }),
      provision: ({ account, ...request }) => invoke('ios_notification_preview_provision', { accountJid: account, ...request }),
      storeToken: (fastToken) => invoke('plugin:push|set_notification_preview', { operation: 'storeFastToken', fastToken }),
    })
    return { ...material, password, words: i18n.getResourceBundle(i18n.resolvedLanguage || 'en', 'translation')?.notificationPreview }
  } })
  let latest = 0
  const refresh = () => {
    const attempt = ++latest
    const settle = (failure: PreviewFailure | null) => {
      if (attempt === latest) useIOSPreviewSettingsStore.getState().setFailure(failure)
    }
    return controller.refresh().then(() => settle(null), (error: unknown) => { settle(failureOf(error)); throw error })
  }
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
