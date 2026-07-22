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
import { readFileSync } from 'node:fs'
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

let mockIsTauri = false
vi.mock('@/utils/tauri', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/tauri')>()
  return { ...actual, isTauri: () => mockIsTauri }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts.code === 'string' ? `${key}:${opts.code}` : key,
    // BackupPassphraseDialog.tsx:81 reads `i18n.language` inside a mount
    // effect (to draw a locale-specific passphrase). Omitting `i18n` here
    // makes that dialog throw `TypeError: Cannot read properties of
    // undefined (reading 'language')` the instant it renders, which
    // silently defuses any assertion downstream of it (e.g. a
    // `.not.toHaveBeenCalled()` check that can never fail because the
    // dialog never got the chance to call anything).
    i18n: { language: 'en' },
  }),
}))

function toggleButton(): HTMLElement {
  return screen.getByRole('switch', { name: 'settings.encryption.openpgpLabel' })
}

describe('EncryptionSettings PEP support', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockStatus = 'online'
    mockPlugin = null
    mockIsTauri = false
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

    it('shows the masked backup-code field when the file is a Fluux xep0373 backup', async () => {
      mockPickKeyFile.mockResolvedValue(
        '-----BEGIN PGP MESSAGE-----\nPassphrase-Format: xep0373\n\nwcDMfakebody\n-----END PGP MESSAGE-----\n',
      )

      render(<EncryptionSettings />)

      const importButton = await screen.findByRole('button', {
        name: 'settings.encryption.importFileAction',
      })
      fireEvent.click(importButton)

      // The Passphrase-Format header drives the masked dashed input, not free text.
      await waitFor(() => {
        expect(document.querySelector('input[name="backup-code"]')).not.toBeNull()
        expect(document.querySelector('input[name="passphrase"]')).toBeNull()
      })
    })
  })

  // The backup row used to be hidden once the local marker matched the
  // current fingerprint, which made "in sync" a dead end: a backup encoded
  // by Fluux <=0.17.1 (legacy-normalized passphrase, #1021) sits behind a
  // green status line that no other XEP-0373 client can open, with no way
  // to re-publish it. The row now always renders, and because publishing
  // mints a FRESH passphrase, replacing an existing backup is confirmed.
  describe('re-publishing an in-sync backup', () => {
    const FP = 'AAAABBBBCCCCDDDDEEEEFFFF0000111122223333'
    const mockBackupSecretKey = vi.fn<(pp: string) => Promise<void>>()

    beforeEach(() => {
      vi.clearAllMocks()
      localStorage.clear()
      mockStatus = 'online'
      mockCheckPepSupport.mockResolvedValue(true)
      mockBackupSecretKey.mockResolvedValue(undefined)
      mockPlugin = {
        getOwnFingerprint: () => FP,
        // Marker matches the live fingerprint => the UI considers local and
        // server in sync, which is exactly the state that used to hide the row.
        getBackedUpFingerprint: () => FP,
        probeSecretKeyBackup: vi.fn<() => Promise<'present' | 'absent' | 'unknown'>>().mockResolvedValue('present'),
        backupSecretKey: mockBackupSecretKey,
      }
      useEncryptionSettingsStore.setState({
        openpgpEnabled: true,
        pluginRegisteredAt: 1,
        registrationError: null,
      })
    })

    it('offers the backup button even while in sync', async () => {
      render(<EncryptionSettings />)

      // Precondition: we really are in the in-sync state, not merely unprobed.
      await screen.findByText('settings.encryption.backupStatusInSync')

      expect(
        screen.getByRole('button', { name: 'settings.encryption.backupAction' }),
      ).toBeInTheDocument()
    })

    it('offers the restore button even while in sync', async () => {
      render(<EncryptionSettings />)

      await screen.findByText('settings.encryption.backupStatusInSync')

      expect(
        screen.getByRole('button', { name: 'settings.encryption.restoreAction' }),
      ).toBeInTheDocument()
    })

    it('confirms with the own-backup copy, not the foreign-backup copy', async () => {
      render(<EncryptionSettings />)

      const backupButton = await screen.findByRole('button', {
        name: 'settings.encryption.backupAction',
      })
      fireEvent.click(backupButton)

      expect(
        screen.getByText('settings.encryption.backupReplaceOwnTitle'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.backupConflictTitle'),
      ).not.toBeInTheDocument()
    })

    it('does not publish until the confirmation is accepted', async () => {
      render(<EncryptionSettings />)

      const backupButton = await screen.findByRole('button', {
        name: 'settings.encryption.backupAction',
      })
      fireEvent.click(backupButton)

      await screen.findByText('settings.encryption.backupReplaceOwnTitle')
      expect(mockBackupSecretKey).not.toHaveBeenCalled()
    })

    it('publishes once the confirmation is accepted and the passphrase acknowledged', async () => {
      render(<EncryptionSettings />)

      const backupButton = await screen.findByRole('button', {
        name: 'settings.encryption.backupAction',
      })
      fireEvent.click(backupButton)

      fireEvent.click(
        await screen.findByRole('button', {
          name: 'settings.encryption.backupReplaceOwnAction',
        }),
      )
      const publish = await screen.findByRole('button', {
        name: 'settings.encryption.backupPublish',
      })
      fireEvent.click(document.querySelector('input[type="checkbox"]')!)
      await waitFor(() => expect(publish).not.toBeDisabled())
      fireEvent.click(publish)

      // The dialog generates its own fresh passphrase, so assert call
      // count rather than the argument value.
      await waitFor(() => expect(mockBackupSecretKey).toHaveBeenCalledTimes(1))
    })

    it('leaves a clean state when the confirmation is cancelled', async () => {
      render(<EncryptionSettings />)

      const backupButton = await screen.findByRole('button', {
        name: 'settings.encryption.backupAction',
      })
      fireEvent.click(backupButton)

      await screen.findByText('settings.encryption.backupReplaceOwnTitle')
      fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))

      await waitFor(() => {
        expect(
          screen.queryByText('settings.encryption.backupReplaceOwnTitle'),
        ).not.toBeInTheDocument()
      })
      // No passphrase dialog opened, and nothing was published.
      expect(
        screen.queryByRole('button', { name: 'settings.encryption.backupPublish' }),
      ).not.toBeInTheDocument()
      expect(mockBackupSecretKey).not.toHaveBeenCalled()

      // Clicking backup again reopens the confirm dialog — cancellation
      // must not leave the variant stuck in some half-cleared state.
      fireEvent.click(
        screen.getByRole('button', { name: 'settings.encryption.backupAction' }),
      )
      expect(
        screen.getByText('settings.encryption.backupReplaceOwnTitle'),
      ).toBeInTheDocument()
    })

    it('uses the foreign-backup copy when the marker does not match', async () => {
      // Server holds a backup this device did not publish.
      mockPlugin!.getBackedUpFingerprint = () => null

      render(<EncryptionSettings />)

      const backupButton = await screen.findByRole('button', {
        name: 'settings.encryption.backupAction',
      })
      fireEvent.click(backupButton)

      expect(
        screen.getByText('settings.encryption.backupConflictTitle'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.backupReplaceOwnTitle'),
      ).not.toBeInTheDocument()
    })
  })

  // A failed server probe used to be coerced to "no backup exists", which
  // skipped the replace confirmation entirely: a transient network failure
  // could overwrite a real server backup with no warning. `unknown` now
  // fails toward "a backup might exist" at every consumer.
  describe('inconclusive backup probe', () => {
    const FP = 'AAAABBBBCCCCDDDDEEEEFFFF0000111122223333'
    const mockBackupSecretKey = vi.fn<(pp: string) => Promise<void>>()
    const mockProbe = vi.fn<() => Promise<'present' | 'absent' | 'unknown'>>()
    const mockRotateEncryptionKey = vi.fn<(pp?: string) => Promise<{ fingerprint: string }>>()

    beforeEach(() => {
      vi.clearAllMocks()
      localStorage.clear()
      mockStatus = 'online'
      mockCheckPepSupport.mockResolvedValue(true)
      mockBackupSecretKey.mockResolvedValue(undefined)
      mockProbe.mockResolvedValue('unknown')
      mockRotateEncryptionKey.mockResolvedValue({ fingerprint: FP })
      mockPlugin = {
        getOwnFingerprint: () => FP,
        getBackedUpFingerprint: () => FP,
        probeSecretKeyBackup: mockProbe,
        backupSecretKey: mockBackupSecretKey,
        rotateEncryptionKey: mockRotateEncryptionKey,
      }
      useEncryptionSettingsStore.setState({
        openpgpEnabled: true,
        pluginRegisteredAt: 1,
        registrationError: null,
      })
    })

    it('shows the inconclusive status line instead of claiming no backup', async () => {
      render(<EncryptionSettings />)

      expect(
        await screen.findByText('settings.encryption.backupStatusUnknown'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.backupStatusNone'),
      ).not.toBeInTheDocument()
    })

    it('still renders the buttons — including retry — when the probe promise rejects', async () => {
      // The probe is documented as non-throwing, but the component only
      // reaches it through a structural `as` cast, so nothing enforces
      // that contract at compile time. Without a catch mapping a rejection
      // to `unknown`, `backupProbe` would stay stuck on `checking` and
      // `{!checking && …}` would hide ALL THREE buttons — including retry
      // — leaving the user with no way out.
      mockProbe.mockRejectedValue(new Error('probe transport failure'))

      render(<EncryptionSettings />)

      expect(
        await screen.findByRole('button', {
          name: 'settings.encryption.backupStatusRetry',
        }),
      ).toBeInTheDocument()
    })

    it('shows the definitive status line when the probe succeeds', async () => {
      // Control test: proves this fixture can render the other status lines,
      // so the negative assertion above is not vacuous.
      mockProbe.mockResolvedValue('present')

      render(<EncryptionSettings />)

      expect(
        await screen.findByText('settings.encryption.backupStatusInSync'),
      ).toBeInTheDocument()
    })

    it('offers a retry that re-runs the probe', async () => {
      render(<EncryptionSettings />)

      const retry = await screen.findByRole('button', {
        name: 'settings.encryption.backupStatusRetry',
      })
      expect(mockProbe).toHaveBeenCalledTimes(1)

      mockProbe.mockResolvedValue('present')
      fireEvent.click(retry)

      await screen.findByText('settings.encryption.backupStatusInSync')
      expect(mockProbe).toHaveBeenCalledTimes(2)
    })

    it('confirms with the unknown variant before publishing', async () => {
      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.backupAction' }),
      )

      expect(
        await screen.findByText('settings.encryption.backupReplaceUnknownTitle'),
      ).toBeInTheDocument()
    })

    it('publishes once the unknown confirmation is accepted', async () => {
      // Control test for the pair above: proves the publish wire is live in
      // this fixture, so "did not publish" assertions have teeth.
      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.backupAction' }),
      )
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'settings.encryption.backupReplaceUnknownAction',
        }),
      )
      const publish = await screen.findByRole('button', {
        name: 'settings.encryption.backupPublish',
      })
      fireEvent.click(document.querySelector('input[type="checkbox"]')!)
      await waitFor(() => expect(publish).not.toBeDisabled())
      fireEvent.click(publish)

      await waitFor(() => expect(mockBackupSecretKey).toHaveBeenCalledTimes(1))
    })

    it('offers the delete-the-server-backup option under an inconclusive probe', async () => {
      render(<EncryptionSettings />)

      // The delete button lives behind the collapsed danger zone.
      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.dangerZone' }),
      )
      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.deleteKey' }),
      )

      expect(
        await screen.findByText('settings.encryption.deleteKeyAlsoBackup'),
      ).toBeInTheDocument()
    })

    it('re-publishes the backup on rotate under an inconclusive probe', async () => {
      // Over-publishing a backup that did not exist is harmless. Leaving a
      // real one encrypted to the retired key is not, so `unknown` takes the
      // same path as in-sync: through the passphrase dialog.
      mockIsTauri = true

      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.rotateAction' }),
      )
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'settings.encryption.rotateConfirmAction',
        }),
      )

      // The passphrase dialog is the re-publish path; its absence would mean
      // we rotated and left the server copy stale.
      expect(
        await screen.findByRole('button', { name: 'settings.encryption.backupPublish' }),
      ).toBeInTheDocument()
    })

    it('warns about the backup re-publish in the rotate confirmation under an inconclusive probe', async () => {
      // The confirmation copy must agree with the routing in
      // handleRotateConfirm: `unknown` re-publishes, so the dialog the user
      // sees before confirming has to say so.
      mockIsTauri = true

      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.rotateAction' }),
      )

      expect(
        await screen.findByText('settings.encryption.rotateConfirmMessageWithBackup'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.rotateConfirmMessage'),
      ).not.toBeInTheDocument()
    })

    it('shows the plain rotate confirmation when the probe confirms no backup', async () => {
      // Control test for the case above: proves the assertion pair
      // discriminates between two live outcomes instead of asserting a
      // constant that would pass regardless of `backupProbe`.
      mockIsTauri = true
      mockProbe.mockResolvedValue('absent')

      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.rotateAction' }),
      )

      expect(
        await screen.findByText('settings.encryption.rotateConfirmMessage'),
      ).toBeInTheDocument()
      expect(
        screen.queryByText('settings.encryption.rotateConfirmMessageWithBackup'),
      ).not.toBeInTheDocument()
    })

    it('rotates directly without the passphrase dialog when the probe confirms no backup', async () => {
      mockIsTauri = true
      mockProbe.mockResolvedValue('absent')

      render(<EncryptionSettings />)

      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.rotateAction' }),
      )
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'settings.encryption.rotateConfirmAction',
        }),
      )

      await waitFor(() => expect(mockRotateEncryptionKey).toHaveBeenCalledTimes(1))
      expect(
        screen.queryByRole('button', { name: 'settings.encryption.backupPublish' }),
      ).not.toBeInTheDocument()
    })

    it('offers restore under an inconclusive probe', async () => {
      // Restoring when there is in fact no backup degrades to an error the
      // restore dialog already handles. Hiding restore when a backup DOES
      // exist strands the user, so `unknown` must keep it reachable.
      render(<EncryptionSettings />)

      expect(
        await screen.findByRole('button', { name: 'settings.encryption.restoreAction' }),
      ).toBeInTheDocument()
    })
  })

  // Aurora security-iconography pass: every status color routes through the
  // theme-aware Aurora tokens (fluux-red/green/yellow + text-fluux-error for
  // red text) so it adapts across all 13 themes x light/dark. This guards
  // against a regression reintroducing raw Tailwind palette literals like
  // `bg-yellow-500/10`, `text-red-400`, or `text-green-600`.
  describe('Aurora color tokenization', () => {
    it('uses fluux- design tokens, not hardcoded Tailwind palette colors', () => {
      // Resolved from cwd: the app suite always runs from apps/fluux.
      const source = readFileSync(
        'src/components/settings-components/EncryptionSettings.tsx',
        'utf8',
      )
      const hardcoded = source.match(/(?:red|green|yellow)-\d{2,3}/g) ?? []
      expect(hardcoded).toEqual([])
    })
  })
})
