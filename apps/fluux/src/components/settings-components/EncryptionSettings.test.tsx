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
 *   codes) instead of spinning on "Generating your key..." for 60s.
 */
import { StrictMode } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { E2EEPluginError } from '@fluux/sdk'
import { EncryptionSettings } from './EncryptionSettings'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { useToastStore } from '@/stores/toastStore'
import fixtureMeta from '@/e2ee/fixtures/sequoia_meta.json'
import migrationMeta from '@/e2ee/fixtures/migration_meta.json'
import { withPassphraseFormatHeader } from '@/e2ee/passphraseFormatHeader'

const ALICE_FP = fixtureMeta.aliceFingerprint
const BOB_FP = fixtureMeta.bobFingerprint
const fixtureFile = (name: string) => readFileSync(resolve(__dirname, '../../e2ee/fixtures', name), 'utf8')

const mockCheckPepSupport = vi.fn<() => Promise<boolean>>()

let mockStatus = 'online'
// Plugin returned by client.e2ee.getPlugin('openpgp'). Null for the PEP
// tests (which never reach a registered plugin); a stub for the import tests.
let mockPlugin: Record<string, unknown> | null = null
const mockClient = {
  server: { checkPepSupport: mockCheckPepSupport },
  e2ee: { getDiagnosticLogger: () => ({ info: vi.fn() }), getAccountJid: () => 'me@example.com', getPlugin: (name: string) => (name === 'openpgp' ? mockPlugin : null) },
}

vi.mock('@fluux/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@fluux/sdk')>()
  return {
    ...actual,
    useConnection: () => ({ status: mockStatus, jid: 'me@example.com/laptop' }),
    useXMPPContext: () => ({ client: mockClient }),
  }
})

import { setPlatformForTesting } from '@/platform'

// One seam for the platform, shared with the app code under test.
let restorePlatform: (() => void) | undefined
function usePlatform(shell: 'desktop' | 'web', os: 'macos' | 'windows' | 'linux' = 'macos') {
  restorePlatform?.()
  restorePlatform = setPlatformForTesting({ shell, os })
}

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

async function openKeyManagement() {
  fireEvent.click(await screen.findByRole('button', { name: 'settings.encryption.keyManagement' }))
}

function toggleButton(): HTMLElement {
  return screen.getByRole('switch', { name: 'settings.encryption.openpgpLabel' })
}

describe('EncryptionSettings PEP support', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockStatus = 'online'
    mockPlugin = null
    usePlatform('web')
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
      mockGetOwnFingerprint.mockReturnValue(ALICE_FP)
      mockPickKeyFile.mockResolvedValue(
        fixtureFile('openkeychain_numeric9x4_backup.asc'),
      )
      mockImportKeyFromFile.mockResolvedValue({
        fingerprint: migrationMeta.openkeychain.fingerprint,
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
      const externalPassphrase = migrationMeta.openkeychain.passphrase

      render(<EncryptionSettings />)

      // The Import-from-file button only renders once the key is "ready".
      await openKeyManagement()
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
        withPassphraseFormatHeader(fixtureFile('sequoia_alice_backup.asc')),
      )

      render(<EncryptionSettings />)

      await openKeyManagement()
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
    const FP = ALICE_FP
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

    it('keeps status and backup visible while key details are collapsed', async () => {
      render(<EncryptionSettings />)
      await screen.findByText('settings.encryption.backupStatusInSync')
      expect(screen.getByText('settings.encryption.statusReady')).toBeVisible()
      expect(screen.getByText('settings.encryption.limitationBackend')).toBeVisible()
      expect(screen.queryByRole('button', { name: 'settings.encryption.copyFingerprint' })).toBeNull()
      expect(screen.getByRole('button', { name: 'settings.encryption.backupAction' })).toBeVisible()
      const details = screen.getByRole('button', { name: 'settings.encryption.keyDetails' })
      fireEvent.click(details)
      expect(screen.getByRole('button', { name: 'settings.encryption.copyFingerprint' })).toBeVisible()
      expect(details).toHaveAttribute('aria-expanded', 'true')
    })

    it('keeps file transfer optional without hiding security warnings', async () => {
      usePlatform('desktop')
      mockPlugin = { ...mockPlugin, isKeychainBacked: () => false }
      render(<EncryptionSettings />)
      await screen.findByText('settings.encryption.backupStatusInSync')
      expect(screen.getByRole('alert')).toHaveTextContent('settings.encryption.notProtectedAtRest')
      expect(screen.queryByRole('button', { name: 'settings.encryption.importFileAction' })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.keyManagement' }))
      expect(screen.getByRole('button', { name: 'settings.encryption.importFileAction' })).toBeVisible()
      expect(screen.getByRole('button', { name: 'settings.encryption.exportFileAction' })).toBeVisible()
      expect(screen.getByRole('alert')).toBeVisible()
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
      // A confirmed different identity is still a mismatch, not uncertainty.
      mockPlugin!.getBackedUpFingerprint = () => BOB_FP

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
    const FP = ALICE_FP
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

    it('R1 treats a present backup without a marker as neutral and uses the unknown replacement warning', async () => {
      mockProbe.mockResolvedValue('present')
      mockPlugin!.getBackedUpFingerprint = () => null
      render(<EncryptionSettings />)
      await screen.findByText('settings.encryption.backupStatusUnconfirmed')
      expect(screen.queryByRole('button', { name: 'settings.encryption.backupStatusRetry' })).not.toBeInTheDocument()
      expect(screen.queryByText('settings.encryption.backupStatusMismatch')).not.toBeInTheDocument()
      expect(screen.queryByText('settings.encryption.backupStatusInSync')).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.backupAction' }))
      await screen.findByText('settings.encryption.backupReplaceUnknownTitle')
      expect(screen.getByText('settings.encryption.backupReplaceUnconfirmedMessage')).toBeInTheDocument()
      expect(screen.queryByText('settings.encryption.backupReplaceUnknownMessage')).not.toBeInTheDocument()
      expect(screen.queryByText('settings.encryption.backupConflictTitle')).not.toBeInTheDocument()
      expect(mockBackupSecretKey).not.toHaveBeenCalled()
    })

    it('R1 warns and acknowledges a new code before rotating an unconfirmed backup', async () => {
      usePlatform('desktop')
      mockProbe.mockResolvedValue('present')
      mockPlugin!.getBackedUpFingerprint = () => null
      render(<EncryptionSettings />)
      await screen.findByText('settings.encryption.backupStatusUnconfirmed')
      await openKeyManagement()
      fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.rotateAction' }))
      await screen.findByText('settings.encryption.rotateConfirmMessageWithBackup')
      fireEvent.click(screen.getByRole('button', { name: 'settings.encryption.rotateConfirmAction' }))
      const publish = await screen.findByRole('button', { name: 'settings.encryption.backupPublish' })
      await waitFor(() => expect((document.querySelector('input[name="passphrase"]') as HTMLInputElement).value).not.toBe(''))
      const code = (document.querySelector('input[name="passphrase"]') as HTMLInputElement).value
      expect(mockRotateEncryptionKey).not.toHaveBeenCalled()
      expect(publish).toBeDisabled()
      fireEvent.click(document.querySelector('input[type="checkbox"]')!)
      await waitFor(() => expect(publish).not.toBeDisabled())
      fireEvent.click(publish)
      await waitFor(() => expect(mockRotateEncryptionKey).toHaveBeenCalledExactlyOnceWith(code))
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
      usePlatform('desktop')

      render(<EncryptionSettings />)

      await openKeyManagement()
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
      usePlatform('desktop')

      render(<EncryptionSettings />)

      await openKeyManagement()
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
      usePlatform('desktop')
      mockProbe.mockResolvedValue('absent')

      render(<EncryptionSettings />)

      await openKeyManagement()
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
      usePlatform('desktop')
      mockProbe.mockResolvedValue('absent')

      render(<EncryptionSettings />)

      await openKeyManagement()
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

  /**
   * Rotating while a backup is in sync re-wraps that backup with a brand new
   * passphrase. The user has just been shown that passphrase, told to write
   * it down, and made to tick "I've saved this". If publishing it fails,
   * saying "Encryption key rotated" and closing the dialog sends them away
   * guarding a backup that does not exist.
   */
  describe('rotation whose backup re-publish fails', () => {
    const FP = ALICE_FP
    const mockRotate = vi.fn<(pp?: string) => Promise<{ fingerprint: string }>>()
    const mockProbe = vi.fn<() => Promise<'present' | 'absent' | 'unknown'>>()

    beforeEach(() => {
      vi.clearAllMocks()
      localStorage.clear()
      mockStatus = 'online'
      mockCheckPepSupport.mockResolvedValue(true)
      mockProbe.mockResolvedValue('present')
      // Rotation committed; only the backup publish failed. This is the
      // shape OpenPGPPluginBase throws, pinned code and all.
      mockRotate.mockRejectedValue(
        new E2EEPluginError(
          'transient',
          'backup-publish-failed',
          'SequoiaPgpPlugin: key rotated, but publishing the new backup failed: remote-server-timeout',
        ),
      )
      mockPlugin = {
        getOwnFingerprint: () => FP,
        // Marker matches the live key => in sync => rotation routes through
        // the passphrase dialog rather than the fire-and-toast path.
        getBackedUpFingerprint: () => FP,
        probeSecretKeyBackup: mockProbe,
        rotateEncryptionKey: mockRotate,
      }
      useToastStore.setState({ toasts: [] })
      useEncryptionSettingsStore.setState({
        openpgpEnabled: true,
        pluginRegisteredAt: 1,
        registrationError: null,
      })
      // The rotate row is desktop-only (openpgp.js v6 rotation is deferred).
      usePlatform('desktop')
    })

    /** Rotate button -> confirm -> acknowledge the passphrase -> publish. */
    async function rotateThroughPassphraseDialog(): Promise<void> {
      render(<EncryptionSettings />)

      await openKeyManagement()
      fireEvent.click(
        await screen.findByRole('button', { name: 'settings.encryption.rotateAction' }),
      )
      fireEvent.click(
        await screen.findByRole('button', {
          name: 'settings.encryption.rotateConfirmAction',
        }),
      )
      const publish = await screen.findByRole('button', {
        name: 'settings.encryption.backupPublish',
      })
      fireEvent.click(document.querySelector('input[type="checkbox"]')!)
      await waitFor(() => expect(publish).not.toBeDisabled())
      fireEvent.click(publish)

      // Precondition: we really did reach the plugin. Without this the
      // assertions below could pass on a flow that never got that far.
      await waitFor(() => expect(mockRotate).toHaveBeenCalledTimes(1))
    }

    it('tells the user the passphrase they just saved is not live', async () => {
      await rotateThroughPassphraseDialog()

      // Not the raw plugin message: the user needs to know both that the
      // rotation happened and that this passphrase is not active yet.
      expect(
        await screen.findByText('settings.encryption.rotateBackupFailed'),
      ).toBeInTheDocument()
    })

    it('does not claim success', async () => {
      await rotateThroughPassphraseDialog()

      await waitFor(() =>
        expect(screen.getByText('settings.encryption.rotateBackupFailed')).toBeInTheDocument(),
      )
      expect(useToastStore.getState().toasts).toEqual([])
      // Dialog stays open, holding the same passphrase, so a retry does not
      // need the user to copy anything again.
      expect(
        screen.getByRole('button', { name: 'settings.encryption.backupPublish' }),
      ).toBeInTheDocument()
    })

    it('re-probes the backup status even though the rotation failed', async () => {
      // The rotation committed, so whatever the status line said before is
      // now stale — it has to stop claiming the server copy matches.
      await rotateThroughPassphraseDialog()

      // Mount probes once; the failed rotation has to trigger a second pass.
      await waitFor(() => expect(mockProbe.mock.calls.length).toBeGreaterThan(1))
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

// FLM-343 guided selection: dismissal at startup must leave a persistent
// recovery entry outside the ready-key gate, without another automatic offer.
describe('macOS guided recovery entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockStatus = 'online'
    usePlatform('desktop', 'macos')
    mockCheckPepSupport.mockResolvedValue(true)
    mockPlugin = { getOwnFingerprint: () => null, isKeyRecoveryNeeded: () => true, isKeyStorageUnavailable: () => true }
    useEncryptionSettingsStore.setState({ openpgpEnabled: true, pluginRegisteredAt: 0, registrationError: null })
  })
  it('routes an unlock failure discovered while enabling encryption through guided recovery too', async () => {
    useEncryptionSettingsStore.setState({ openpgpEnabled: false })
    render(<EncryptionSettings />)
    fireEvent.click(toggleButton())
    expect(await screen.findByText('settings.encryption.recoveryFailedBody')).toBeInTheDocument()
    expect(screen.queryByText('settings.encryption.identityChoice.replaceTitle')).not.toBeInTheDocument()
  })
  it('shows recovery status and an explicit usable entry before the key is ready, without opening another dialog', async () => {
    render(<EncryptionSettings />)
    expect(await screen.findByText('settings.encryption.statusRecoveryNeeded')).toBeInTheDocument()
    expect(screen.queryByText('settings.encryption.recoveryFailedBody')).not.toBeInTheDocument()
    const entry = screen.getByRole('button', { name: 'settings.encryption.recoveryTitle' })
    expect(entry).toBeEnabled()
    fireEvent.click(entry)
    expect(await screen.findByText('settings.encryption.recoveryFailedBody')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(screen.queryByText('settings.encryption.recoveryFailedBody')).not.toBeInTheDocument()
    expect(entry).toBeEnabled()
  })
  it('FLM-365 F1 keeps the desync Settings prompt and Replace identity under StrictMode effect replay', async () => {
    mockPlugin!.isKeyStorageUnavailable = () => false
    render(<StrictMode><EncryptionSettings /></StrictMode>)
    expect(await screen.findByRole('button', { name: /settings.encryption.identityChoice.replaceTitle/ })).toBeEnabled()
    expect(screen.queryByText('settings.encryption.recoveryFailedBody')).not.toBeInTheDocument()
  })
  it('FLM-365 F1 keeps the desync toggle decision on macOS', async () => {
    mockPlugin!.isKeyStorageUnavailable = () => false
    useEncryptionSettingsStore.setState({ openpgpEnabled: false })
    render(<EncryptionSettings />)
    fireEvent.click(toggleButton())
    expect(await screen.findByRole('button', { name: /settings.encryption.identityChoice.replaceTitle/ })).toBeEnabled()
    expect(screen.queryByText('settings.encryption.recoveryFailedBody')).not.toBeInTheDocument()
  })
  it('FLM-365 F3 does not route a macOS browser through the desktop-only toggle branch', async () => {
    usePlatform('web', 'macos')
    useEncryptionSettingsStore.setState({ openpgpEnabled: false })
    render(<EncryptionSettings />)
    fireEvent.click(toggleButton())
    expect(await screen.findByRole('button', { name: /settings.encryption.identityChoice.replaceTitle/ })).toBeEnabled()
    expect(screen.queryByText('settings.encryption.recoveryFailedBody')).not.toBeInTheDocument()
  })

})

// Intent FLM-304, the captain's words on FLM-298: "Never, but maybe an explicit
// retry try could be proposed in a advanced panel, in case there is no other way
// to recover the key". The plugin decides when the retry is offered
// (keychainRetry.test.ts); this view keeps it folded, macOS-only, and reads the
// keychain only on the button press.
describe('macOS keychain retry panel', () => {
  const FINGERPRINT = ALICE_FP
  let unlockedFingerprint: string | null
  // The native store still holds this launch's refusal; a granted read consumes it.
  let refusalHeld: boolean
  // A request still on macOS's prompt locks the native cache, so nothing is confirmed.
  let promptOpen: boolean
  // The native store unlocked the key, as when the user allowed a timed-out retry late.
  let nativeUnlocked: boolean
  let retryKeychainAccess: ReturnType<typeof vi.fn>
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    mockStatus = 'online'
    usePlatform('desktop', 'macos')
    mockCheckPepSupport.mockResolvedValue(true)
    useToastStore.setState({ toasts: [] })
    unlockedFingerprint = null
    refusalHeld = true
    promptOpen = false
    nativeUnlocked = false
    retryKeychainAccess = vi.fn()
    mockPlugin = {
      getOwnFingerprint: () => unlockedFingerprint,
      isKeyRecoveryNeeded: () => unlockedFingerprint === null,
      isKeyStorageUnavailable: () => unlockedFingerprint === null,
      keychainRetryState: vi.fn(async () =>
        unlockedFingerprint !== null ? 'none' : promptOpen ? 'unconfirmed' : nativeUnlocked ? 'ready' : refusalHeld ? 'offered' : 'none'),
      retryKeychainAccess,
    }
    useEncryptionSettingsStore.setState({ openpgpEnabled: true, pluginRegisteredAt: 0, registrationError: null })
  })
  const panelTitle = 'settings.encryption.keychainRetry.title'
  const retryButton = () => screen.getByRole('button', { name: 'settings.encryption.keychainRetry.action' })

  it('stays folded under the restore entry and reads nothing until the user asks', async () => {
    render(<EncryptionSettings />)
    const title = await screen.findByRole('button', { name: panelTitle })
    expect(title).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: 'settings.encryption.recoveryTitle' })).toBeEnabled()
    fireEvent.click(title)
    expect(screen.getByText('settings.encryption.keychainRetry.body')).toBeVisible()
    expect(retryKeychainAccess).not.toHaveBeenCalled()
  })

  it('keeps the key locked after a second refusal, then unlocks it on the next press', async () => {
    render(<EncryptionSettings />)
    fireEvent.click(await screen.findByRole('button', { name: panelTitle }))
    retryKeychainAccess.mockRejectedValueOnce(new E2EEPluginError('permanent', 'keychain-refused', 'openpgp-keychain-refused: refused again'))
    fireEvent.click(retryButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.encryption.keychainRetry.refusedAgain')
    expect(screen.getByText('settings.encryption.statusRecoveryNeeded')).toBeInTheDocument()
    expect(retryButton()).toBeEnabled()

    retryKeychainAccess.mockImplementationOnce(async () => {
      unlockedFingerprint = FINGERPRINT
      return { fingerprint: FINGERPRINT }
    })
    fireEvent.click(retryButton())
    expect(await screen.findByText('settings.encryption.statusReady')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: panelTitle })).not.toBeInTheDocument()
    expect(retryKeychainAccess).toHaveBeenCalledTimes(2)
    expect(useToastStore.getState().toasts.map(t => [t.type, t.message])).toEqual([['success', 'settings.encryption.keychainRetry.success']])
  })

  // Intent FLM-304 and FLM-408 R2: macOS granted the read but the key still
  // cannot be unlocked, so nothing is left to ask again; the details stay.
  it('keeps the native details but no action when a granted read cannot unlock the key', async () => {
    retryKeychainAccess.mockImplementationOnce(async () => {
      refusalHeld = false
      throw new E2EEPluginError('permanent', 'key-unrecoverable', 'decrypt persisted TSK: unexpected EOF')
    })
    render(<EncryptionSettings />)
    fireEvent.click(await screen.findByRole('button', { name: panelTitle }))
    fireEvent.click(retryButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.encryption.keychainRetry.failed')
    expect(screen.getByText('decrypt persisted TSK: unexpected EOF')).toBeInTheDocument()
    await waitFor(() => expect(retryButton()).toBeDisabled())
    expect(screen.getByRole('button', { name: panelTitle })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: 'settings.encryption.recoveryTitle' })).toBeEnabled()
    expect(retryKeychainAccess).toHaveBeenCalledOnce()
  })

  // Intent FLM-408 R1: a restore must not start while the retry asks macOS,
  // or the retry would report a key the restore has since replaced.
  it('holds the restore entry while the retry asks macOS', async () => {
    let answer!: (refusal: Error) => void
    retryKeychainAccess.mockImplementationOnce(() => new Promise((_resolve, reject) => { answer = reject }))
    render(<EncryptionSettings />)
    const restore = screen.getByRole('button', { name: 'settings.encryption.recoveryTitle' })
    fireEvent.click(await screen.findByRole('button', { name: panelTitle }))
    fireEvent.click(retryButton())
    await waitFor(() => expect(restore).toBeDisabled())
    await act(async () => { answer(new E2EEPluginError('permanent', 'keychain-refused', 'openpgp-keychain-refused: refused again')) })
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.encryption.keychainRetry.refusedAgain')
    expect(restore).toBeEnabled()
  })

  // A desynced key opens the identity choice over this view, and its Cancel
  // turns encryption off, so the retry must be reachable inside that choice.
  it('sits inside the identity choice for a desynced key, and unlocking closes it with encryption on', async () => {
    mockPlugin!.isKeyStorageUnavailable = () => false
    render(<EncryptionSettings />)
    const replace = await screen.findByRole('button', { name: /settings.encryption.identityChoice.replaceTitle/ })
    const title = await screen.findByRole('button', { name: panelTitle })
    expect(replace.closest('[data-modal]')).toContainElement(title)
    expect(screen.getAllByRole('button', { name: panelTitle })).toHaveLength(1)
    fireEvent.click(title)
    expect(retryKeychainAccess).not.toHaveBeenCalled()

    // FLM-408 R1: while macOS is asked, the choice holds its other recoveries.
    let grant!: () => void
    retryKeychainAccess.mockImplementationOnce(() => new Promise(resolve => {
      grant = () => { unlockedFingerprint = FINGERPRINT; resolve({ fingerprint: FINGERPRINT }) }
    }))
    fireEvent.click(retryButton())
    await waitFor(() => expect(replace).toBeDisabled())
    expect(screen.getByRole('button', { name: 'common.cancel' })).toBeDisabled()
    await act(async () => { grant() })
    expect(await screen.findByText('settings.encryption.statusReady')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /settings.encryption.identityChoice.replaceTitle/ })).not.toBeInTheDocument()
    expect(useEncryptionSettingsStore.getState().openpgpEnabled).toBe(true)
    expect(useToastStore.getState().toasts.map(t => [t.type, t.message])).toEqual([['success', 'settings.encryption.keychainRetry.success']])
  })

  // Intent FLM-408 R4: a retry that outlived its time limit may still be on
  // macOS's prompt. That is unfinished, not a consumed refusal: the action
  // stays in either placement, and asks again once the user has refused.
  it.each([
    ['under the restore entry', true],
    ['inside the identity choice', false],
  ])('keeps the action %s while a timed-out retry is still on its prompt', async (_placement, storageUnavailable) => {
    mockPlugin!.isKeyStorageUnavailable = () => unlockedFingerprint === null && storageUnavailable
    retryKeychainAccess.mockImplementationOnce(async () => {
      promptOpen = true
      throw new E2EEPluginError('transient', 'unknown',
        'SequoiaPgpPlugin: retryKeychainAccess: SequoiaPgpPlugin: native call openpgp_retry_keychain_access timeout after 120000 ms')
    })
    render(<EncryptionSettings />)
    fireEvent.click(await screen.findByRole('button', { name: panelTitle }))
    fireEvent.click(retryButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.encryption.keychainRetry.failed')
    // The press ends only after the panel has asked whether anything is left.
    await waitFor(() => expect(retryButton()).toHaveTextContent('settings.encryption.keychainRetry.action'))
    expect(retryButton()).toBeEnabled()

    // The user refuses on the prompt that stayed open; the next press asks again.
    promptOpen = false
    retryKeychainAccess.mockRejectedValueOnce(new E2EEPluginError('permanent', 'keychain-refused', 'openpgp-keychain-refused: refused again'))
    fireEvent.click(retryButton())
    expect(await screen.findByRole('alert')).toHaveTextContent('settings.encryption.keychainRetry.refusedAgain')
    expect(retryButton()).toBeEnabled()
    expect(retryKeychainAccess).toHaveBeenCalledTimes(2)
  })

  // Intent FLM-408 R5: the user allowed a retry's prompt after it timed out,
  // so the key is unlocked natively but not in use. Reopening either
  // placement offers to use it; the press reads no keychain item.
  it.each([
    ['under the restore entry', true],
    ['inside the identity choice', false],
  ])('offers to use a key macOS allowed after a timed-out retry %s', async (_placement, storageUnavailable) => {
    mockPlugin!.isKeyStorageUnavailable = () => unlockedFingerprint === null && storageUnavailable
    nativeUnlocked = true
    render(<EncryptionSettings />)
    const title = await screen.findByRole('button', { name: panelTitle })
    expect(title).toHaveAttribute('aria-expanded', 'false')
    if (!storageUnavailable) {
      expect(screen.getByRole('button', { name: /settings.encryption.identityChoice.replaceTitle/ }).closest('[data-modal]')).toContainElement(title)
    }
    fireEvent.click(title)
    expect(screen.getByText('settings.encryption.keychainRetry.readyBody')).toBeVisible()
    expect(screen.queryByText('settings.encryption.keychainRetry.backupHint')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'settings.encryption.keychainRetry.action' })).not.toBeInTheDocument()
    const use = screen.getByRole('button', { name: 'settings.encryption.keychainRetry.readyAction' })
    expect(use).toBeEnabled()
    expect(retryKeychainAccess).not.toHaveBeenCalled()

    retryKeychainAccess.mockImplementationOnce(async () => {
      unlockedFingerprint = FINGERPRINT
      return { fingerprint: FINGERPRINT }
    })
    fireEvent.click(use)
    expect(await screen.findByText('settings.encryption.statusReady')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: panelTitle })).not.toBeInTheDocument()
    expect(useEncryptionSettingsStore.getState().openpgpEnabled).toBe(true)
    expect(retryKeychainAccess).toHaveBeenCalledOnce()
    expect(useToastStore.getState().toasts.map(t => [t.type, t.message])).toEqual([['success', 'settings.encryption.keychainRetry.success']])
  })

  it('is absent when the plugin does not offer the retry', async () => {
    mockPlugin!.keychainRetryState = vi.fn(async () => 'none')
    render(<EncryptionSettings />)
    expect(await screen.findByText('settings.encryption.statusRecoveryNeeded')).toBeInTheDocument()
    await waitFor(() => expect(mockPlugin!.keychainRetryState).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: panelTitle })).not.toBeInTheDocument()
  })

  it.each([['desktop', 'windows'], ['web', 'macos']] as const)('is absent on %s %s', async (shell, os) => {
    usePlatform(shell, os)
    render(<EncryptionSettings />)
    expect(await screen.findByText('settings.encryption.statusRecoveryNeeded')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: panelTitle })).not.toBeInTheDocument()
    expect(mockPlugin!.keychainRetryState).not.toHaveBeenCalled()
  })
})
