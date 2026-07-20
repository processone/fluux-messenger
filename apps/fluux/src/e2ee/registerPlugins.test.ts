/**
 * registerE2EEPlugins error surfacing: a failed registration must land in
 * `encryptionSettingsStore.registrationError` as a typed (kind, code) pair
 * so the settings UI can explain the failure immediately — most notably
 * `pep-unsupported` on servers without PEP (issue #414).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { E2EEPluginError } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { registerE2EEPlugins } from './registerPlugins'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { TauriKeychainStorageBackend } from './TauriKeychainStorageBackend'

// Force the desktop path: no dynamic IndexedDB/openpgp.js imports, and the
// SequoiaPgpPlugin constructor is stubbed below.
vi.mock('../utils/tauri', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@fluux/openpgp-plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/openpgp-plugin')>()
  return {
    ...actual,
    SequoiaPgpPlugin: vi.fn(function SequoiaPgpPluginMock() {
      return {}
    }),
  }
})

function makeClient(register: () => Promise<void>): XMPPClient {
  return {
    e2ee: {
      getPlugin: () => null,
      register,
      getAccountJid: () => 'me@example.com',
      setForcedPlaintext: vi.fn(),
    },
    setE2EEStorageBackend: vi.fn(),
  } as unknown as XMPPClient
}

describe('registerE2EEPlugins failure surfacing', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    useEncryptionSettingsStore.setState({
      openpgpEnabled: true,
      pluginRegisteredAt: 0,
      registrationError: null,
    })
    // The catch path intentionally logs — keep test output pristine.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    errorSpy.mockRestore()
  })

  it('stores kind + code from an E2EEPluginError (pep-unsupported)', async () => {
    const client = makeClient(() =>
      Promise.reject(
        new E2EEPluginError(
          'permanent',
          'pep-unsupported',
          'account JID does not advertise PEP (XEP-0163)',
        ),
      ),
    )

    await registerE2EEPlugins(client)

    expect(useEncryptionSettingsStore.getState().registrationError).toEqual({
      kind: 'permanent',
      code: 'pep-unsupported',
    })
    expect(errorSpy).toHaveBeenCalled()
  })

  it('classifies non-plugin errors into a typed code', async () => {
    const client = makeClient(() => Promise.reject(new Error('request timed out')))

    await registerE2EEPlugins(client)

    expect(useEncryptionSettingsStore.getState().registrationError).toEqual({
      kind: 'transient',
      code: 'timeout',
    })
  })

  it('clears a previous failure when registration succeeds', async () => {
    useEncryptionSettingsStore
      .getState()
      .notifyPluginRegistrationFailed({ kind: 'permanent', code: 'pep-unsupported' })
    const client = makeClient(() => Promise.resolve())

    await registerE2EEPlugins(client)

    const state = useEncryptionSettingsStore.getState()
    expect(state.registrationError).toBeNull()
    expect(state.pluginRegisteredAt).toBe(1)
  })
})

describe('registerE2EEPlugins desktop OpenPGP storage backend', () => {
  beforeEach(() => {
    useEncryptionSettingsStore.setState({
      openpgpEnabled: true,
      omemoEnabled: false,
      pluginRegisteredAt: 0,
      registrationError: null,
    })
  })

  it('routes desktop OpenPGP to its own sealed store, registered under the "openpgp" plugin id', async () => {
    const client = makeClient(() => Promise.resolve())

    await registerE2EEPlugins(client)

    expect(client.setE2EEStorageBackend).toHaveBeenCalledWith(
      expect.any(TauriKeychainStorageBackend),
      'openpgp',
    )
  })
})
