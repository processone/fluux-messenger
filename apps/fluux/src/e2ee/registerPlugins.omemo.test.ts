import { describe, it, expect, vi, beforeEach } from 'vitest'
import { registerE2EEPlugins } from './registerPlugins'
import { useEncryptionSettingsStore } from '../stores/encryptionSettingsStore'

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
  beforeEach(() => { localStorage.clear() })
  it('registers OMEMO on Tauri when omemoEnabled, with a storage backend', async () => {
    useEncryptionSettingsStore.getState().setOmemoEnabled(true)
    useEncryptionSettingsStore.getState().setOpenpgpEnabled(false)
    const client = fakeClient() as any
    await registerE2EEPlugins(client)
    expect(client._plugins.has('omemo:2')).toBe(true)
    expect(client.setE2EEStorageBackend).toHaveBeenCalled()
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
