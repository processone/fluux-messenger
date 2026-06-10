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
import { render, screen, waitFor } from '@testing-library/react'
import { EncryptionSettings } from './EncryptionSettings'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'

const mockCheckPepSupport = vi.fn<() => Promise<boolean>>()

let mockStatus = 'online'
const mockClient = {
  discovery: { checkPepSupport: mockCheckPepSupport },
  e2ee: { getPlugin: () => null },
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
})
