import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectionStore } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { setPlatformForTesting } from '@/platform'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { usePeerKeysetRevisionStore } from '@/stores/peerKeysetRevisionStore'
import { useIOSPreviewSettingsStore } from './previewSettings'
import { startIOSNotificationPreviews, setIOSNotificationPreviews, purgeIOSNotificationPreviews } from './notificationPreviews'
vi.mock('@fluux/sdk', async (importOriginal) => {
  const sdk = await importOriginal<typeof import('@fluux/sdk')>()
  const { connectionStore } = await import('@fluux/sdk/stores')
  return { ...sdk, connectionStore }
})
const lab = vi.hoisted(() => ({ shared: null as Record<string, unknown> | null, reads: 0 }))
vi.mock('@/hooks/useSessionPersistence', () => ({ getSession: () => ({ jid: 'bob@nse.invalid', password: 'synthetic', server: 'tls://127.0.0.1:15223' }) }))
vi.mock('@/utils/keychain', () => ({ getCredentials: async () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: Record<string, unknown>) => {
  if (command === 'ios_notification_preview_material') { lab.reads++; return { secret_b64: 'synthetic-only', endpoints: [] } }
  if (command === 'plugin:push|set_notification_preview') lab.shared = args.snapshot as Record<string, unknown> | null
} }))
describe('account-scoped notification provisioning triggers', () => {
  let restore: () => void
  let stop: (() => void) | undefined
  const peers = { 'alice@nse.invalid': [{ fingerprint: 'synthetic-key', publicArmored: 'synthetic-public' }] }
  const client = { e2ee: { getPlugin: () => ({ getOwnFingerprint: () => 'synthetic-own', notificationVerifierSnapshot: (account: string) => account === 'bob@nse.invalid' ? peers : null }) } } as unknown as XMPPClient
  beforeEach(() => {
    localStorage.clear(); lab.shared = null; lab.reads = 0
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    connectionStore.getState().setJid('bob@nse.invalid/fixture')
    useEncryptionSettingsStore.setState({ openpgpEnabled: true })
    useIOSPreviewSettingsStore.getState().setAccount(null)
  })
  afterEach(async () => { stop?.(); stop = undefined; await purgeIOSNotificationPreviews(); restore() })
  it('default-off startup never exports subkeys, then on/off provisions and purges', async () => {
    stop = startIOSNotificationPreviews(client)
    await vi.waitFor(() => expect(lab.shared).toBeNull())
    expect(lab.reads).toBe(0)
    await setIOSNotificationPreviews(true)
    expect(lab.shared).toMatchObject({ account: 'bob@nse.invalid', opt_in: true, peers })
    await setIOSNotificationPreviews(false)
    expect(lab.shared).toBeNull()
  })
  it('account switch purges and loads the other account default', async () => {
    stop = startIOSNotificationPreviews(client)
    await setIOSNotificationPreviews(true)
    connectionStore.getState().setJid('other@nse.invalid/fixture')
    await vi.waitFor(() => expect(lab.shared).toBeNull())
    expect(useIOSPreviewSettingsStore.getState().enabled).toBe(false)
    connectionStore.getState().setJid('bob@nse.invalid/fixture')
    await vi.waitFor(() => expect(lab.shared?.account).toBe('bob@nse.invalid'))
    expect(useIOSPreviewSettingsStore.getState().enabled).toBe(true)
  })
  it('logout removes the capability and prevents later keyset events from restoring it', async () => {
    stop = startIOSNotificationPreviews(client)
    await setIOSNotificationPreviews(true)
    await purgeIOSNotificationPreviews()
    usePeerKeysetRevisionStore.getState().notifyPeerKeysetChanged('alice@nse.invalid')
    await Promise.resolve(); await Promise.resolve()
    expect(lab.shared).toBeNull()
  })
  it('key changes refresh the snapshot and unavailable identity purges it', async () => {
    stop = startIOSNotificationPreviews(client)
    await setIOSNotificationPreviews(true)
    const before = lab.reads
    usePeerKeysetRevisionStore.getState().notifyPeerKeysetChanged('bob@nse.invalid')
    await vi.waitFor(() => expect(lab.reads).toBeGreaterThan(before))
    useEncryptionSettingsStore.setState({ openpgpEnabled: false })
    await vi.waitFor(() => expect(lab.shared).toBeNull())
  })
  it('web and desktop hosts never write or export notification secrets', async () => {
    restore(); restore = setPlatformForTesting({ shell: 'web', os: 'ios' })
    stop = startIOSNotificationPreviews(client)
    await setIOSNotificationPreviews(true)
    expect(lab.reads).toBe(0); expect(lab.shared).toBeNull()
  })
})
