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
const lab = vi.hoisted(() => ({
  shared: null as Record<string, unknown> | null, reads: 0, password: 'synthetic', materialError: null as string | null,
  token: null as Record<string, unknown> | null, provisionError: null as string | null,
  provisioned: [] as Record<string, unknown>[], invalidated: [] as Record<string, unknown>[],
}))
vi.mock('@/hooks/useSessionPersistence', () => ({ getSession: () => ({ jid: 'bob@nse.invalid', password: lab.password, server: 'tls://127.0.0.1:15223' }) }))
vi.mock('@/utils/keychain', () => ({ getCredentials: async () => null }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: Record<string, unknown>) => {
  if (command === 'ios_notification_preview_material') { lab.reads++; if (lab.materialError) throw lab.materialError; return { secret_b64: 'synthetic-only', endpoints: [] } }
  if (command === 'ios_notification_preview_provision') {
    lab.provisioned.push(args)
    if (lab.provisionError) throw lab.provisionError
    return { token: 'synthetic-token', expiry: '2026-11-20T00:00:00Z' }
  }
  if (command === 'ios_notification_preview_invalidate') { lab.invalidated.push(args); return }
  if (command !== 'plugin:push|set_notification_preview') return
  if (args.operation === 'fastToken') return { userAgentId: 'synthetic-agent', present: lab.token != null }
  if (args.operation === 'storeFastToken') { lab.token = args.fastToken as Record<string, unknown>; return }
  lab.shared = args.snapshot as Record<string, unknown> | null
  if (args.operation === 'purge' && lab.token) {
    const released = lab.token; lab.token = null
    return { released }
  }
} }))
describe('account-scoped notification provisioning triggers', () => {
  let restore: () => void
  let stop: (() => void) | undefined
  const peers = { 'alice@nse.invalid': [{ fingerprint: 'synthetic-key', publicArmored: 'synthetic-public' }] }
  const client = { e2ee: { getPlugin: () => ({ getOwnFingerprint: () => 'synthetic-own', notificationVerifierSnapshot: (account: string) => account === 'bob@nse.invalid' ? peers : null }) } } as unknown as XMPPClient
  beforeEach(() => {
    localStorage.clear(); lab.shared = null; lab.reads = 0; lab.password = 'synthetic'; lab.materialError = null
    lab.token = null; lab.provisionError = null; lab.provisioned = []; lab.invalidated = []
    restore = setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    connectionStore.getState().setJid('bob@nse.invalid/fixture')
    useEncryptionSettingsStore.setState({ openpgpEnabled: true })
    useIOSPreviewSettingsStore.getState().setAccount(null)
  })
  afterEach(async () => { stop?.(); stop = undefined; await purgeIOSNotificationPreviews(); restore() })
  it('previews are on by default once OpenPGP is ready', async () => {
    stop = startIOSNotificationPreviews(client)
    await vi.waitFor(() => expect(lab.shared).toMatchObject({ account: 'bob@nse.invalid', opt_in: true, peers }))
    expect(useIOSPreviewSettingsStore.getState().enabled).toBe(true)
    expect(lab.provisioned).toHaveLength(1)
  })
  it('a default-on account without OpenPGP never exports subkeys', async () => {
    useEncryptionSettingsStore.setState({ openpgpEnabled: false })
    stop = startIOSNotificationPreviews(client)
    for (let i = 0; i < 5; i++) await new Promise(done => setTimeout(done, 0))
    expect(useIOSPreviewSettingsStore.getState().enabled).toBe(true)
    expect(lab.reads).toBe(0); expect(lab.shared).toBeNull()
  })
  it('an opted-out account never exports subkeys at startup, then on/off provisions and purges', async () => {
    localStorage.setItem('fluux-ios-ox-previews:bob@nse.invalid', '0')
    stop = startIOSNotificationPreviews(client)
    for (let i = 0; i < 5; i++) await new Promise(done => setTimeout(done, 0))
    expect(lab.reads).toBe(0); expect(lab.shared).toBeNull()
    await setIOSNotificationPreviews(true)
    expect(lab.shared).toMatchObject({ account: 'bob@nse.invalid', opt_in: true, peers })
    await setIOSNotificationPreviews(false)
    expect(lab.shared).toBeNull()
  })
  it('account switch purges and loads the other account preference', async () => {
    localStorage.setItem('fluux-ios-ox-previews:other@nse.invalid', '0')
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
  it('flags enabled previews that have no fetch credential, and clears the flag once one exists', async () => {
    localStorage.setItem('fluux-ios-ox-previews:bob@nse.invalid', '1')
    lab.password = ''
    stop = startIOSNotificationPreviews(client)
    await vi.waitFor(() => expect(useIOSPreviewSettingsStore.getState().missingCredential).toBe(true))
    expect(lab.shared).toBeNull()
    lab.password = 'synthetic'
    usePeerKeysetRevisionStore.getState().notifyPeerKeysetChanged('alice@nse.invalid')
    await vi.waitFor(() => expect(lab.shared?.account).toBe('bob@nse.invalid'))
    expect(useIOSPreviewSettingsStore.getState().missingCredential).toBe(false)
  })
  it.each([
    ['credential', () => { lab.password = '' }],
    ['refused', () => { lab.provisionError = 'credential-refused' }],
    ['key', () => { lab.materialError = 'key-unavailable' }],
    ['server', () => { lab.materialError = 'server-unreachable' }],
    ['unavailable', () => { lab.materialError = 'Invalid account' }],
  ])('reports a %s failure and leaves previews off', async (problem, arrange) => {
    arrange()
    stop = startIOSNotificationPreviews(client)
    await expect(setIOSNotificationPreviews(true)).rejects.toMatchObject({ problem })
    expect(useIOSPreviewSettingsStore.getState().enabled).toBe(false)
    expect(lab.shared).toBeNull()
  })
  it('activation issues the extension token once and the snapshot then needs no password', async () => {
    stop = startIOSNotificationPreviews(client)
    await setIOSNotificationPreviews(true)
    expect(lab.provisioned).toEqual([{ accountJid: 'bob@nse.invalid', server: 'tls://127.0.0.1:15223', password: 'synthetic', userAgentId: 'synthetic-agent' }])
    expect(lab.token).toMatchObject({ account: 'bob@nse.invalid', userAgentId: 'synthetic-agent', token: 'synthetic-token' })
    lab.password = ''
    usePeerKeysetRevisionStore.getState().notifyPeerKeysetChanged('alice@nse.invalid')
    await vi.waitFor(() => expect(lab.shared).toMatchObject({ account: 'bob@nse.invalid', password: '' }))
    expect(lab.provisioned).toHaveLength(1)
    expect(useIOSPreviewSettingsStore.getState().missingCredential).toBe(false)
  })
  it('turning previews off has the server invalidate the released extension token', async () => {
    stop = startIOSNotificationPreviews(client)
    await setIOSNotificationPreviews(true)
    await setIOSNotificationPreviews(false)
    await vi.waitFor(() => expect(lab.invalidated).toEqual([{
      accountJid: 'bob@nse.invalid', server: 'tls://127.0.0.1:15223', userAgentId: 'synthetic-agent', token: 'synthetic-token',
    }]))
  })
  it('logout has the server invalidate the released extension token', async () => {
    stop = startIOSNotificationPreviews(client)
    await setIOSNotificationPreviews(true)
    await purgeIOSNotificationPreviews()
    await vi.waitFor(() => expect(lab.invalidated).toHaveLength(1))
    expect(lab.token).toBeNull()
  })
  it('web and desktop hosts never write or export notification secrets', async () => {
    restore(); restore = setPlatformForTesting({ shell: 'web', os: 'ios' })
    stop = startIOSNotificationPreviews(client)
    await setIOSNotificationPreviews(true)
    expect(lab.reads).toBe(0); expect(lab.shared).toBeNull()
  })
})
