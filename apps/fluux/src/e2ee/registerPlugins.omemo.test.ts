import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerE2EEPlugins } from './registerPlugins'
import { useEncryptionSettingsStore } from '../stores/encryptionSettingsStore'
import { TauriKeychainStorageBackend } from './TauriKeychainStorageBackend'

vi.mock('../utils/tauri', () => ({ isTauri: () => true }))

function fakeClient() {
  const plugins = new Map<string, any>()
  const manager = {
    getPlugin: (id: string) => plugins.get(id) ?? null,
    getAccountJid: () => 'me@x',
    register: vi.fn(async (p: any) => { plugins.set(p.descriptor.id, p) }),
    unregister: vi.fn(async (id: string) => { plugins.delete(id) }),
    setForcedPlaintext: vi.fn(),
  }
  return { e2ee: manager, setE2EEStorageBackend: vi.fn(), _plugins: plugins }
}

describe('registerE2EEPlugins with OMEMO', () => {
  beforeEach(() => {
    localStorage.clear()
    useEncryptionSettingsStore.getState().setOpenpgpEnabled(false)
    useEncryptionSettingsStore.getState().setOmemoEnabled(false)
  })
  it('registers OMEMO on Tauri when omemoEnabled, with a storage backend', async () => {
    useEncryptionSettingsStore.getState().setOmemoEnabled(true)
    useEncryptionSettingsStore.getState().setOpenpgpEnabled(false)
    const client = fakeClient() as any
    await registerE2EEPlugins(client)
    expect(client._plugins.has('omemo:2')).toBe(true)
    expect(client.setE2EEStorageBackend).toHaveBeenCalled()
  })
  it('gives OMEMO the DEFAULT backend — no pluginId, so it keeps the legacy <jid>.json', async () => {
    useEncryptionSettingsStore.getState().setOmemoEnabled(true)
    useEncryptionSettingsStore.getState().setOpenpgpEnabled(false)
    const client = fakeClient() as any
    await registerE2EEPlugins(client)
    // A single-argument call: no `store` name baked into the backend and no
    // pluginId override, matching the pre-existing OMEMO behavior exactly.
    expect(client.setE2EEStorageBackend).toHaveBeenCalledWith(expect.any(TauriKeychainStorageBackend))
    // Guard against constructing it as (jid, undefined, 'omemo'), which would
    // still satisfy `expect.any(TauriKeychainStorageBackend)` above but would
    // orphan OMEMO's data onto a new sealed store instead of the legacy
    // `<jid>.json` file. Inspect the actual constructed instance's storeName.
    const constructedBackend = client.setE2EEStorageBackend.mock.calls[0][0] as TauriKeychainStorageBackend
    expect((constructedBackend as unknown as { storeName?: string }).storeName).toBeUndefined()
  })
  it('does NOT register OMEMO when omemoEnabled is false', async () => {
    useEncryptionSettingsStore.getState().setOmemoEnabled(false)
    const client = fakeClient() as any
    await registerE2EEPlugins(client)
    expect(client._plugins.has('omemo:2')).toBe(false)
  })
  it('is idempotent — re-registering does not double-register OMEMO', async () => {
    useEncryptionSettingsStore.getState().setOmemoEnabled(true)
    const client = fakeClient() as any
    await registerE2EEPlugins(client)
    await registerE2EEPlugins(client)
    expect(client.e2ee.register).toHaveBeenCalledTimes(1) // only OMEMO (openpgp off)
  })
})
