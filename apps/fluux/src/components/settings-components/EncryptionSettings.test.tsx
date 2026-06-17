/**
 * EncryptionSettings PEP-availability handling (issue #414):
 *
 * - Proactive: when the session is online the panel probes the account
 *   bare JID for PEP (XEP-0163) via the SDK and, when missing, shows a
 *   warning banner and disables the enable-toggle — BEFORE the user
 *   tries to enable OpenPGP and generates an orphan key.
 * - Reactive: when plugin registration already failed, the typed error
 *   from `encryptionSettingsStore.registrationError` is surfaced
 *   immediately (specific text for `pep-unsupported`, generic for other
 *   codes) instead of spinning on "Generating your key…" for 60s.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { EncryptionSettings } from './EncryptionSettings'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'

const mockCheckPepSupport = vi.fn<() => Promise<boolean>>()

let mockStatus = 'online'
// Plugin returned by client.e2ee.getPlugin('openpgp'). Null for the PEP
// tests (which never reach a registered plugin); a stub for the import tests.
let mockPlugin: Record<string, unknown> | null = null
const mockClient = {
  discovery: { checkPepSupport: mockCheckPepSupport },
  e2ee: { getPlugin: (name: string) => (name === 'openpgp' ? mockPlugin : null) },
}

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnection: () => ({ status: mockStatus, jid: 'me@example.com/laptop' }),
    useXMPPContext: () => ({ client: mockClient }),
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.code === 'string' ? `${key}:${opts.code}` : key,
  }),
}))

function toggleButton(): HTMLElement {
  return screen.getByRole('button', { name: 'settings.encryption.openpgpLabel' })
}

describe('EncryptionSettings PEP support', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockStatus = 'online'
    mockPlugin = null
    mockCheckPepSupport.mockResolvedValue(true)
    useEncryptionSettingsStore.setState({
      openpgpEnabled: false,
      pluginRegisteredAt: 0,
      registrationError: null,
    })
  })

  describe('proactive probe', () => {
    it('shows a warning banner and disables the toggle when PEP is missing', async () => {
      mockCheckPepSupport.mockResolvedValue(false)

      render(<EncryptionSettings />)

      await waitFor(() => {
        expect(
          screen.getByText('settings.encryption.pepUnsupportedBanner'),
        ).toBeInTheDocument()
      })
      expect(toggleButton()).toBeDisabled()
    })

    it('shows no banner and keeps the toggle enabled when PEP is available', async () => {
      render(<EncryptionSettings />)

      await waitFor(() => {
        expect(mockCheckPepSupport).toHaveBeenCalled()
      })
      expect(
        screen.queryByText('settings.encryption.pepUnsupportedBanner'),
      ).not.toBeInTheDocument()
      expect(toggleButton()).not.toBeDisabled()
    })

    it('does not probe while offline', () => {
      mockStatus = 'disconnected'

      render(<EncryptionSettings />)

      expect(mockCheckPepSupport).not.toHaveBeenCalled()
      expect(
        screen.queryByText('settings.encryption.pepUnsupportedBanner'),
      ).not.toBeInTheDocument()
    })

    it('fails open when the probe itself fails', async () => {
      mockCheckPepSupport.mockRejectedValue(new Error('remote-server-timeout'))

      render(<EncryptionSettings />)

      await waitFor(() => {
        expect(mockCheckPepSupport).toHaveBeenCalled()
      })
      expect(
        screen.queryByText('settings.encryption.pepUnsupportedBanner'),
      ).not.toBeInTheDocument()
      expect(toggleButton()).not.toBeDisabled()
    })

    it('still allows turning the toggle OFF when PEP is missing', async () => {
      // A user may have enabled OpenPGP while offline or before a server
      // config change; the disabled toggle must not lock them into "on".
      mockCheckPepSupport.mockResolvedValue(false)
      useEncryptionSettingsStore.setState({ openpgpEnabled: true })

      render(<EncryptionSettings />)

      await waitFor(() => {
        expect(
          screen.getByText('settings.encryption.pepUnsupportedBanner'),
        ).toBeInTheDocument()
      })
      expect(toggleButton()).not.toBeDisabled()
    })
  })

  describe('reactive registration failure', () => {
    it('surfaces pep-unsupported immediately with a specific message', async () => {
      useEncryptionSettingsStore.setState({
        openpgpEnabled: true,
        registrationError: { kind: 'permanent', code: 'pep-unsupported' },
      })

      render(<EncryptionSettings />)

      await waitFor(() => {
        expect(
          screen.getByText('settings.encryption.statusPepUnsupported'),
        ).toBeInTheDocument()
      })
      expect(
        screen.queryByText('settings.encryption.statusGenerating'),
      ).not.toBeInTheDocument()
    })

    it('surfaces other registration failures with a generic message and code', async () => {
      useEncryptionSettingsStore.setState({
        openpgpEnabled: true,
        registrationError: { kind: 'transient', code: 'timeout' },
      })

      render(<EncryptionSettings />)

      await waitFor(() => {
        expect(
          screen.getByText('settings.encryption.statusRegistrationFailed:timeout'),
        ).toBeInTheDocument()
      })
    })
  })

  // Regression: importing an OpenPGP key from a file (GnuPG / OpenKeychain
  // export) must accept an ARBITRARY passphrase. The import dialog must not
  // reuse the XEP-0373 §5.4 backup-code mask, which truncates to 24 chars
  // (6 groups of 4) and strips any character outside
  // "123456789ABCDEFGHIJKLMNPQRSTUVWXYZ", notably "0". Reported by a user
  // unable to type their 9-group, zero-containing OpenKeychain backup code.
  describe('import-from-file passphrase', () => {
    const mockGetOwnFingerprint = vi.fn<() => string | null>()
    const mockPickKeyFile = vi.fn<() => Promise<string | null>>()
    const mockImportKeyFromFile = vi.fn()

    beforeEach(() => {
      vi.clearAllMocks()
      localStorage.clear()
      mockStatus = 'online'
      mockCheckPepSupport.mockResolvedValue(true)
      mockGetOwnFingerprint.mockReturnValue('AAAABBBBCCCCDDDDEEEEFFFF0000111122223333')
      mockPickKeyFile.mockResolvedValue(
        '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nfake\n-----END PGP PRIVATE KEY BLOCK-----',
      )
      mockImportKeyFromFile.mockResolvedValue({
        fingerprint: 'AAAABBBBCCCCDDDDEEEEFFFF0000111122223333',
      })
      mockPlugin = {
        getOwnFingerprint: mockGetOwnFingerprint,
        pickKeyFile: mockPickKeyFile,
        importKeyFromFile: mockImportKeyFromFile,
      }
      useEncryptionSettingsStore.setState({
        openpgpEnabled: true,
        pluginRegisteredAt: 1,
        registrationError: null,
      })
    })

    it('passes an arbitrary passphrase (with "0" and >24 chars) through verbatim', async () => {
      // An OpenKeychain numeric9x4 backup code: 9 groups of 4 digits, with zeros.
      const externalPassphrase = '1000-2000-3000-4000-5000-6000-7000-8000-9000'

      render(<EncryptionSettings />)

      // The Import-from-file button only renders once the key is "ready".
      const importButton = await screen.findByRole('button', {
        name: 'settings.encryption.importFileAction',
      })
      fireEvent.click(importButton)

      // The passphrase dialog opens after pickKeyFile() resolves.
      await waitFor(() => {
        expect(
          document.querySelector('input[name="passphrase"], input[name="backup-code"]'),
        ).not.toBeNull()
      })
      const input = document.querySelector(
        'input[name="passphrase"], input[name="backup-code"]',
      ) as HTMLInputElement

      fireEvent.change(input, { target: { value: externalPassphrase } })
      fireEvent.submit(input.closest('form')!)

      await waitFor(() => {
        expect(mockImportKeyFromFile).toHaveBeenCalled()
      })
      // Must reach the plugin unaltered — not truncated and not zero-stripped.
      expect(mockImportKeyFromFile).toHaveBeenCalledWith(expect.any(String), externalPassphrase)
    })
  })
})
