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

// Force the desktop path: no dynamic IndexedDB/openpgp.js imports, and the
// SequoiaPgpPlugin constructor is stubbed below.
// The desktop build registers the keychain-backed plugin.
import { setPlatformForTesting } from '@/platform'
setPlatformForTesting({ shell: 'desktop', os: 'macos' })
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
import { SequoiaPgpPlugin } from './SequoiaPgpPlugin'
vi.mock('./SequoiaPgpPlugin', () => ({
  SequoiaPgpPlugin: vi.fn(function SequoiaPgpPluginMock() {
    return {}
  }),
}))

type Logger = ReturnType<NonNullable<XMPPClient['e2ee']>['getDiagnosticLogger']>

function makeClient(register: () => Promise<void>, logger: Logger = {
  info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: message => console.error(message),
}): XMPPClient {
  return {
    e2ee: {
      getPlugin: () => null,
      register,
      getDiagnosticLogger: () => logger,
      getAccountJid: () => 'me@example.com',
      setForcedPlaintext: vi.fn(),
    },
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

  it('logs a diagnostic when called before the manager is ready', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await registerE2EEPlugins({ e2ee: null } as unknown as XMPPClient)
      expect(warn).toHaveBeenCalledExactlyOnceWith('[Fluux] Cannot register OpenPGP: E2EE manager is not ready')
      expect(useEncryptionSettingsStore.getState().pluginRegisteredAt).toBe(0)
      expect(useEncryptionSettingsStore.getState().registrationError).toBeNull()
    } finally {
      warn.mockRestore()
    }
  })

  it('shares a pending registration for the same manager', async () => {
    let release!: () => void
    const register = vi.fn(() => new Promise<void>(resolve => { release = resolve }))
    const client = makeClient(register)
    const first = registerE2EEPlugins(client)
    const second = registerE2EEPlugins(client)
    await vi.waitFor(() => expect(register).toHaveBeenCalledTimes(1))
    release()
    await Promise.all([first, second])
    expect(useEncryptionSettingsStore.getState().pluginRegisteredAt).toBe(1)
  })
})

describe('registerE2EEPlugins engine', () => {
  afterEach(() => {
    setPlatformForTesting({ shell: 'desktop', os: 'macos' })
  })

  it('registers the native engine on iOS, as on desktop', async () => {
    setPlatformForTesting({ shell: 'mobile', os: 'ios' })
    useEncryptionSettingsStore.setState({ openpgpEnabled: true, pluginRegisteredAt: 0, registrationError: null })
    vi.mocked(SequoiaPgpPlugin).mockClear()
    const register = vi.fn().mockResolvedValue(undefined)

    await registerE2EEPlugins(makeClient(register))

    expect(SequoiaPgpPlugin).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledTimes(1)
  })
})


describe('OpenPGP registration diagnostics', () => {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }
  beforeEach(() => {
    vi.clearAllMocks()
    useEncryptionSettingsStore.setState({ openpgpEnabled: true, pluginRegisteredAt: 0, registrationError: null })
  })
  afterEach(() => vi.restoreAllMocks())

  it('names initialization while it is pending, then records completion and duration', async () => {
    let finish!: () => void
    let now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    const register = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
    const operation = registerE2EEPlugins(makeClient(register, logger))
    await vi.waitFor(() => expect(register).toHaveBeenCalled())
    expect(logger.info).toHaveBeenCalledWith('OpenPGP registration: state=started phase=initialize-native elapsedMs=0')
    expect(logger.info.mock.calls.some(([line]) => line.includes('state=ready'))).toBe(false)
    now = 1250; finish(); await operation
    expect(logger.info).toHaveBeenCalledWith('OpenPGP registration: state=ready phase=complete elapsedMs=250')
    expect(useEncryptionSettingsStore.getState().pluginRegisteredAt).toBe(1)
  })

  it('records a typed terminal failure without the exception payload', async () => {
    const privateDetail = 'synthetic secret payload must stay out of diagnostics'
    const client = makeClient(async () => { throw new E2EEPluginError('transient', 'timeout', privateDetail) }, logger)
    await registerE2EEPlugins(client)
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/^OpenPGP registration: state=failed phase=initialize-native elapsedMs=\d+ kind=transient code=timeout$/))
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateDetail)
    expect(useEncryptionSettingsStore.getState().registrationError).toEqual({ kind: 'transient', code: 'timeout' })
  })
})
