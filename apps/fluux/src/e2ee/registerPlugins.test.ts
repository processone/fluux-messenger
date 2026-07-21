/**
 * registerE2EEPlugins error surfacing: a failed registration must land in
 * `encryptionSettingsStore.registrationError` as a typed (kind, code) pair
 * so the settings UI can explain the failure immediately — most notably
 * `pep-unsupported` on servers without PEP (issue #414).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { E2EEPluginError } from '@fluux/sdk'
import type { XMPPClient } from '@fluux/sdk/core'
import { registerE2EEPlugins, unregisterE2EEPlugins } from './registerPlugins'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { TauriKeychainStorageBackend } from './TauriKeychainStorageBackend'
import { setVerifiedKeysView, getVerifiedFingerprintNow } from './verifiedPeersView'

// A known fingerprint the fake `VerifiedKeysView` below serves for one JID,
// so tests can assert the holder is actually wired to a live view (not just
// wired to `null`, which every read tolerates and so proves nothing).
const FAKE_VERIFIED_JID = 'peer@example.com'
const FAKE_VERIFIED_FP = 'FAKE-FINGERPRINT'

// Force the desktop path: no dynamic IndexedDB/openpgp.js imports, and the
// SequoiaPgpPlugin constructor is stubbed below. `getVerifiedKeysView` returns
// a small fake view (not `null`) so the `setVerifiedKeysView(plugin.getVerifiedKeysView())`
// call in `registerPlugins.ts` is actually exercised with a real handle —
// see registerPlugins.test.ts's "verified-keys view wiring" describe block.
vi.mock('../utils/tauri', () => ({ isTauri: () => true }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@fluux/openpgp-plugin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/openpgp-plugin')>()
  return {
    ...actual,
    SequoiaPgpPlugin: vi.fn(function SequoiaPgpPluginMock() {
      return {
        descriptor: { id: 'openpgp' },
        getVerifiedKeysView: () => ({
          isVerified: (jid: string, fingerprint: string) =>
            jid === 'peer@example.com' && fingerprint === FAKE_VERIFIED_FP,
          getVerifiedFingerprint: (jid: string) => (jid === FAKE_VERIFIED_JID ? FAKE_VERIFIED_FP : null),
          getSnapshot: () => ({ [FAKE_VERIFIED_JID]: FAKE_VERIFIED_FP }),
          subscribe: () => () => {},
        }),
      }
    }),
  }
})

// `verifiedPeersView` is a module-level singleton shared across every test in
// this file (now that the mock above hands out a real view, not `null`) —
// reset it after each test so one test's registration can't leak into the
// next test's assertions.
afterEach(() => {
  setVerifiedKeysView(null)
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

/**
 * Finding 1 (B2 Task 3 review): the previous version of this suite mocked
 * `getVerifiedKeysView` as `() => null`, so the real assertion —
 * `setVerifiedKeysView(plugin.getVerifiedKeysView())` in `registerPlugins.ts`
 * — was never exercised with anything but `null`. Deleting that wiring line
 * entirely left this file green. These tests read `getVerifiedFingerprintNow`
 * back out of the holder, which can only pass if the holder is actually
 * serving the freshly-registered plugin's view.
 *
 * `getPlugin`/`register`/`unregister` here are backed by a real `Map` (unlike
 * `makeClient`'s always-null `getPlugin`) because `unregisterE2EEPlugins`
 * early-`continue`s when `getPlugin` doesn't report the plugin as present.
 */
describe('registerE2EEPlugins verified-keys view wiring (desktop)', () => {
  function statefulClient(): { client: XMPPClient; plugins: Map<string, { descriptor: { id: string } }> } {
    const plugins = new Map<string, { descriptor: { id: string } }>()
    const manager = {
      getPlugin: (id: string) => plugins.get(id) ?? null,
      register: vi.fn(async (plugin: { descriptor: { id: string } }) => {
        plugins.set(plugin.descriptor.id, plugin)
      }),
      unregister: vi.fn(async (id: string) => {
        plugins.delete(id)
      }),
      getAccountJid: () => 'me@example.com',
      setForcedPlaintext: vi.fn(),
    }
    return { client: { e2ee: manager, setE2EEStorageBackend: vi.fn() } as unknown as XMPPClient, plugins }
  }

  beforeEach(() => {
    useEncryptionSettingsStore.setState({
      openpgpEnabled: true,
      omemoEnabled: false,
      pluginRegisteredAt: 0,
      registrationError: null,
    })
    expect(getVerifiedFingerprintNow(FAKE_VERIFIED_JID)).toBeNull()
  })

  it('serves the freshly-registered plugin\'s verified view through the holder', async () => {
    const { client } = statefulClient()

    await registerE2EEPlugins(client)

    expect(getVerifiedFingerprintNow(FAKE_VERIFIED_JID)).toBe(FAKE_VERIFIED_FP)
    // Unrelated JIDs still read null — proves the fake view's own logic (not
    // just "holder is truthy") is what's reachable through the holder.
    expect(getVerifiedFingerprintNow('someone-else@example.com')).toBeNull()
  })

  it('clears the holder when the OpenPGP plugin is unregistered', async () => {
    const { client } = statefulClient()
    await registerE2EEPlugins(client)
    expect(getVerifiedFingerprintNow(FAKE_VERIFIED_JID)).toBe(FAKE_VERIFIED_FP)

    // Unregister only fires for a plugin the user has toggled OFF.
    useEncryptionSettingsStore.getState().setOpenpgpEnabled(false)
    await unregisterE2EEPlugins(client)

    expect(getVerifiedFingerprintNow(FAKE_VERIFIED_JID)).toBeNull()
  })
})
