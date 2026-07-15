/**
 * EncryptionSettings — OMEMO opt-in toggle (desktop-only).
 *
 * - On Tauri, the OMEMO toggle renders alongside the OpenPGP one.
 * - Flipping it on sets the store flag and registers the E2EE plugin stack
 *   (which idempotently registers the OMEMO plugin). No web path, no
 *   identity dialog, no fingerprint probe.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { EncryptionSettings } from './EncryptionSettings'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'

const mockRegister = vi.fn<() => Promise<void>>()
const mockUnregister = vi.fn<() => Promise<void>>()

vi.mock('@/e2ee/registerPlugins', () => ({
  registerE2EEPlugins: (...args: unknown[]) => mockRegister(...(args as [])),
  unregisterE2EEPlugins: (...args: unknown[]) => mockUnregister(...(args as [])),
}))

// Desktop platform: the OMEMO toggle only renders under Tauri.
vi.mock('@/utils/tauri', () => ({
  isTauri: () => true,
  isLinux: () => false,
  isUpdaterEnabled: () => false,
}))

const mockCheckPepSupport = vi.fn<() => Promise<boolean>>()
const mockClient = {
  discovery: { checkPepSupport: mockCheckPepSupport },
  e2ee: { getPlugin: () => null },
}

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnection: () => ({ status: 'online', jid: 'me@example.com/laptop' }),
    useXMPPContext: () => ({ client: mockClient }),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

function omemoToggle(): HTMLElement {
  return screen.getByRole('switch', { name: 'settings.encryption.omemo.label' })
}

describe('EncryptionSettings OMEMO toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockRegister.mockResolvedValue(undefined)
    mockUnregister.mockResolvedValue(undefined)
    mockCheckPepSupport.mockResolvedValue(true)
    useEncryptionSettingsStore.setState({
      openpgpEnabled: false,
      omemoEnabled: false,
      pluginRegisteredAt: 0,
      registrationError: null,
    })
  })

  it('renders the OMEMO toggle on desktop', () => {
    render(<EncryptionSettings />)
    expect(omemoToggle()).toBeInTheDocument()
  })

  it('turning it on sets the flag and registers the plugin stack', async () => {
    render(<EncryptionSettings />)

    fireEvent.click(omemoToggle())

    await waitFor(() => {
      expect(mockRegister).toHaveBeenCalledWith(mockClient)
    })
    expect(useEncryptionSettingsStore.getState().omemoEnabled).toBe(true)
    expect(mockUnregister).not.toHaveBeenCalled()
  })

  it('turning it off unregisters the plugin stack', async () => {
    useEncryptionSettingsStore.setState({ omemoEnabled: true })

    render(<EncryptionSettings />)

    fireEvent.click(omemoToggle())

    await waitFor(() => {
      expect(mockUnregister).toHaveBeenCalledWith(mockClient)
    })
    expect(useEncryptionSettingsStore.getState().omemoEnabled).toBe(false)
  })
})
