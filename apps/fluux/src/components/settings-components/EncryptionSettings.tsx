import { useEffect, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Lock, AlertTriangle, Trash2, CloudUpload, CloudDownload, RefreshCw, X, Info, ChevronDown, ChevronRight, FileDown, FileUp } from 'lucide-react'
import { useConnection, useXMPPContext } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { registerE2EEPlugins, unregisterE2EEPlugins } from '@/e2ee/registerPlugins'
import { useToastStore } from '@/stores/toastStore'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DeleteOpenpgpKeyDialog } from '@/components/DeleteOpenpgpKeyDialog'
import { BackupPassphraseDialog } from '@/components/BackupPassphraseDialog'
import { RestorePassphraseDialog } from '@/components/RestorePassphraseDialog'
import { EnableWithBackupDialog } from '@/components/EnableWithBackupDialog'
import { OwnKeyConflictBanner } from '@/components/OwnKeyConflictBanner'
import { UnlockEncryptionDialog } from '@/components/UnlockEncryptionDialog'
import { KeyPickerDialog } from '@/components/KeyPickerDialog'
import type { KeyBundle } from '@/e2ee/OpenPGPPluginBase'
import { probeRemoteSecretKeyBackup, SecretKeyBackupProbeError } from '@/e2ee/secretKeyProbe'
import { isKeyLocked } from '@/e2ee/webPassphraseStore'
import { isTauri } from '@/utils/tauri'

type PluginStatus =
  | 'disabled'
  | 'generating'
  | 'ready'
  | 'waiting-online'
  | 'generation-failed'

/**
 * If the Rust-side key generation doesn't produce a fingerprint within this
 * window the plugin almost certainly failed (IPC error, panic, unwired
 * command) — surface a clear error instead of a forever-spinning placeholder.
 * 60s is generous; even the slow RustCrypto backend completes in <10s on
 * target hardware.
 */
const GENERATION_TIMEOUT_MS = 60_000

/**
 * Settings → Encryption panel.
 *
 * Surfaces the OpenPGP toggle and — when enabled — the account's
 * fingerprint. Purposely minimal: import, export, verification, and
 * rotation are later slices. Labelled "experimental" throughout so
 * users understand what they are opting into.
 */
export function EncryptionSettings() {
  const { t } = useTranslation()
  const { status, jid } = useConnection()
  const { client } = useXMPPContext()
  const openpgpEnabled = useEncryptionSettingsStore((s) => s.openpgpEnabled)
  const setOpenpgpEnabled = useEncryptionSettingsStore((s) => s.setOpenpgpEnabled)
  const addToast = useToastStore((s) => s.addToast)

  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [isCopied, setIsCopied] = useState(false)
  const [isToggling, setIsToggling] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [generationFailed, setGenerationFailed] = useState(false)
  const [showBackupDialog, setShowBackupDialog] = useState(false)
  const [showRestoreDialog, setShowRestoreDialog] = useState(false)
  const [showRotateConfirm, setShowRotateConfirm] = useState(false)
  const [showRotatePassphraseDialog, setShowRotatePassphraseDialog] = useState(false)
  const [isRotating, setIsRotating] = useState(false)
  // Surfaced when the user clicks "Back up to server" while a backup
  // already lives on PEP for a fingerprint we don't have a local "this
  // device backed it up" marker for. Overwriting that backup is what
  // the user is asking for, but we want to confirm — the existing
  // ciphertext belongs to whoever knows ITS passphrase, and replacing
  // it makes that copy unrecoverable.
  const [showBackupConflictConfirm, setShowBackupConflictConfirm] = useState(false)
  // null = not yet probed, true/false = known. Kept narrow so the UI
  // can show a "Checking…" placeholder without flickering a wrong state.
  const [remoteBackupExists, setRemoteBackupExists] = useState<boolean | null>(null)
  // Fingerprint recorded locally at the moment of the last successful
  // backup/restore. When this equals the current local fingerprint AND
  // a remote backup exists, local and server are known to be in sync
  // and the backup/restore buttons are redundant.
  const [backedUpFingerprint, setBackedUpFingerprint] = useState<string | null>(null)
  // Non-null only while the "we found a backup on enable — restore or
  // start fresh?" dialog is open. Holds the armored backup ciphertext
  // the probe pulled from PEP so the restore handler doesn't need to
  // re-fetch it.
  const [pendingEnableBackup, setPendingEnableBackup] = useState<{
    accountJid: string
    backupMessage: string
  } | null>(null)

  const [limitationsDismissed, setLimitationsDismissed] = useState(
    () => localStorage.getItem('enc-limitations-dismissed') === '1'
  )
  const [backupDescVisible, setBackupDescVisible] = useState(false)
  const [rotateDescVisible, setRotateDescVisible] = useState(false)
  const [dangerZoneExpanded, setDangerZoneExpanded] = useState(false)
  const [showExportFileDialog, setShowExportFileDialog] = useState(false)
  const [showImportFileDialog, setShowImportFileDialog] = useState(false)
  const [pendingImportFileArmored, setPendingImportFileArmored] = useState<string | null>(null)
  const [showUnlockDialog, setShowUnlockDialog] = useState(false)
  const [pendingKeyPicker, setPendingKeyPicker] = useState<{
    candidates: KeyBundle[]
    backupMessage: string
    passphrase: string
  } | null>(null)

  const handleDismissLimitations = () => {
    localStorage.setItem('enc-limitations-dismissed', '1')
    setLimitationsDismissed(true)
  }

  const online = status === 'online'
  const webLocked = !isTauri() && openpgpEnabled && isKeyLocked()
  const pluginStatus: PluginStatus = !openpgpEnabled
    ? 'disabled'
    : !online
      ? 'waiting-online'
      : fingerprint
        ? 'ready'
        : generationFailed
          ? 'generation-failed'
          : 'generating'

  // Track fingerprint — poll briefly after enable so the "Generating…"
  // state resolves without needing a manual reload. The plugin exposes
  // its fingerprint synchronously via a direct method on the instance.
  useEffect(() => {
    if (!openpgpEnabled || !online) {
      setFingerprint(null)
      setGenerationFailed(false)
      return
    }

    let cancelled = false
    const startedAt = Date.now()

    const poll = () => {
      if (cancelled) return
      // Manager becomes available on the first `online` event. If we're
      // polling early (edge case — UI rendered before handler ran), wait
      // one more tick rather than racing to a false-negative.
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | { getOwnFingerprint?: () => string | null }
        | null
      const fp = plugin?.getOwnFingerprint?.() ?? null
      if (fp) {
        setFingerprint(fp)
        setGenerationFailed(false)
        return
      }
      if (Date.now() - startedAt >= GENERATION_TIMEOUT_MS) {
        // Plugin hasn't produced a fingerprint within the generous window.
        // Almost always means registration failed (see console for the
        // [Fluux] E2EE plugin registration failed error). Stop spinning
        // and surface the failure.
        setGenerationFailed(true)
        return
      }
      setTimeout(poll, 250)
    }
    poll()

    return () => {
      cancelled = true
    }
  }, [openpgpEnabled, online, client])

  const handleToggle = useCallback(async () => {
    const next = !openpgpEnabled
    setIsToggling(true)
    try {
      if (!next) {
        // Turning OFF — unchanged behaviour.
        setOpenpgpEnabled(false)
        if (online) await unregisterE2EEPlugins(client)
        setFingerprint(null)
        return
      }

      // Turning ON. We want to avoid the "fork first, restore second"
      // pattern: if the server already has a backup and this device
      // has no local key, generating a fresh key here would publish a
      // competing public key and burn the user's existing identity.
      // Probe first; only register the plugin (which auto-generates)
      // after we know no restore is needed or the user has chosen.
      setOpenpgpEnabled(true)
      if (!online) {
        // Offline toggle: defer. Registration will fire on the next
        // `online` event via App.tsx; we can't probe without a
        // connection anyway.
        return
      }
      const bareJid = jid ? jid.split('/')[0] : null
      if (!isTauri()) {
        // Web: register first (may end up in locked state if no passphrase set yet),
        // then prompt the user to unlock / set up their passphrase.
        await registerE2EEPlugins(client)
        if (isKeyLocked()) {
          setShowUnlockDialog(true)
        }
        return
      }
      if (!bareJid) {
        // Unknown JID on desktop: just register.
        await registerE2EEPlugins(client)
        return
      }

      const { invoke } = await import('@tauri-apps/api/core')
      const hasLocal = await invoke<boolean>('openpgp_has_persisted_key', {
        accountJid: bareJid,
      })
      if (hasLocal) {
        // Existing identity on this device — the normal register path
        // loads it from disk. No server-side probe needed.
        await registerE2EEPlugins(client)
        return
      }

      // No local key; check the server before generating.
      const backupMessage = await probeRemoteSecretKeyBackup(client, bareJid)
      if (!backupMessage) {
        // No backup, no local key — fresh generation is the only path.
        await registerE2EEPlugins(client)
        return
      }

      // Backup exists AND no local key: defer registration and hand
      // the decision to the user. The dialog's handlers will either
      // restore + register, generate fresh + register, or cancel the
      // whole toggle.
      setPendingEnableBackup({ accountJid: bareJid, backupMessage })
    } catch (err) {
      // A probe failure is structurally different from a generic toggle
      // failure: nothing was registered, nothing was generated, nothing
      // was published. The user just needs to retry once their network /
      // server is reachable. Surfacing the right toast (instead of the
      // generic "couldn't change encryption setting") tells them it's
      // safe to try again — and keeps any existing server backup intact.
      if (err instanceof SecretKeyBackupProbeError) {
        addToast('error', t('settings.encryption.probeFailed'))
      } else {
        addToast('error', t('settings.encryption.toggleFailed'))
      }
      console.error('[Fluux] E2EE toggle failed:', err)
      setOpenpgpEnabled(!next)
    } finally {
      setIsToggling(false)
    }
  }, [openpgpEnabled, online, client, jid, setOpenpgpEnabled, addToast, t])

  const handleEnableRestore = useCallback(
    async (passphrase: string) => {
      if (!pendingEnableBackup) return
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('openpgp_backup_import', {
        accountJid: pendingEnableBackup.accountJid,
        backupMessage: pendingEnableBackup.backupMessage,
        passphrase,
      })
      // The import persisted the TSK on disk; register now so the
      // plugin's init loads (not generates) and the identity the user
      // picked is the one advertised.
      await registerE2EEPlugins(client)
      setPendingEnableBackup(null)
      addToast('success', t('settings.encryption.restoreSuccess'))
    },
    [pendingEnableBackup, client, addToast, t],
  )

  const handleEnableUseFresh = useCallback(async () => {
    // User declined the backup — register without touching the
    // secret-key node. Generation produces a new identity that will
    // overwrite the server-side public-keys metadata, which is what
    // the user has explicitly chosen.
    await registerE2EEPlugins(client)
    setPendingEnableBackup(null)
  }, [client])

  const handleEnableCancel = useCallback(() => {
    // Revert the toggle: neither register nor generate. The user
    // isn't ready to decide yet; leave the server backup untouched.
    setPendingEnableBackup(null)
    setOpenpgpEnabled(false)
  }, [setOpenpgpEnabled])

  const handleCopyFingerprint = useCallback(async () => {
    if (!fingerprint) return
    try {
      await navigator.clipboard.writeText(fingerprint)
      setIsCopied(true)
      setTimeout(() => setIsCopied(false), 2000)
    } catch {
      addToast('error', t('settings.encryption.copyFailed'))
    }
  }, [fingerprint, addToast, t])

  // Probe the server for an existing backup once the local plugin is
  // ready. We don't spam this — fire once per transition into `ready`
  // (or after the user has just published/restored, which we do by
  // bumping a local "needs-refresh" nonce).
  const [backupProbeNonce, setBackupProbeNonce] = useState(0)
  useEffect(() => {
    if (pluginStatus !== 'ready') {
      setRemoteBackupExists(null)
      setBackedUpFingerprint(null)
      return
    }
    let cancelled = false
    void (async () => {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            hasSecretKeyBackup?: () => Promise<boolean>
            getBackedUpFingerprint?: () => string | null
          }
        | null
        | undefined
      // Read the local marker synchronously — it's cheap and lets the
      // in-sync status land in the same render as the server probe
      // instead of flickering through a "backup needed" frame.
      if (!cancelled) {
        setBackedUpFingerprint(plugin?.getBackedUpFingerprint?.() ?? null)
      }
      if (!plugin?.hasSecretKeyBackup) {
        if (!cancelled) setRemoteBackupExists(false)
        return
      }
      try {
        const exists = await plugin.hasSecretKeyBackup()
        if (!cancelled) setRemoteBackupExists(exists)
      } catch {
        // Treat probe failure (server down, unsupported PEP feature)
        // as "no backup" rather than leaving the UI in limbo.
        if (!cancelled) setRemoteBackupExists(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [pluginStatus, client, backupProbeNonce])

  const handleBackupConfirm = useCallback(
    async (passphrase: string) => {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | { backupSecretKey?: (pp: string) => Promise<void> }
        | null
        | undefined
      if (!plugin?.backupSecretKey) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      await plugin.backupSecretKey(passphrase)
      setShowBackupDialog(false)
      // Re-probe now that we've published — status line should flip to
      // "backed up on server" without needing a page reload.
      setBackupProbeNonce((n) => n + 1)
      addToast('success', t('settings.encryption.backupSuccess'))
    },
    [client, addToast, t],
  )

  /**
   * Entry point for the "Back up to server" button. If the server
   * already holds a backup whose fingerprint we don't recognize as
   * having been published from THIS device, gate the publish behind a
   * confirmation step — overwriting silently would clobber whatever
   * the existing backup belongs to (most likely a sibling device the
   * user forgot about, possibly a now-stale copy of an earlier key).
   * The buttons-row is only rendered when not-in-sync (inSync hides
   * Back up entirely), so there's no need to guard the in-sync case.
   */
  const handleBackupRequest = useCallback(() => {
    const conflict =
      remoteBackupExists === true &&
      (!backedUpFingerprint || backedUpFingerprint !== fingerprint)
    if (conflict) {
      setShowBackupConflictConfirm(true)
    } else {
      setShowBackupDialog(true)
    }
  }, [remoteBackupExists, backedUpFingerprint, fingerprint])

  const handleRestoreConfirm = useCallback(
    async (passphrase: string) => {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            restoreSecretKey?: (pp: string) => Promise<
              { fingerprint: string } | { needsPicker: true; candidates: KeyBundle[]; backupContext: { message: string; passphrase: string } }
            >
            getBackedUpFingerprint?: () => string | null
          }
        | null
        | undefined
      if (!plugin?.restoreSecretKey) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      const result = await plugin.restoreSecretKey(passphrase)
      if ('needsPicker' in result) {
        setPendingKeyPicker({
          candidates: result.candidates,
          backupMessage: result.backupContext.message,
          passphrase: result.backupContext.passphrase,
        })
        setShowRestoreDialog(false)
        return
      }
      setFingerprint(result.fingerprint)
      setShowRestoreDialog(false)
      setBackedUpFingerprint(plugin.getBackedUpFingerprint?.() ?? result.fingerprint)
      addToast('success', t('settings.encryption.restoreSuccess'))
    },
    [client, addToast, t],
  )

  const handleKeyPickerConfirm = useCallback(
    async (selectedFingerprint: string) => {
      if (!pendingKeyPicker) return
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            installSelectedKey?: (msg: string, pp: string, fp: string) => Promise<{ fingerprint: string }>
            getBackedUpFingerprint?: () => string | null
          }
        | null
        | undefined
      if (!plugin?.installSelectedKey) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      const info = await plugin.installSelectedKey(
        pendingKeyPicker.backupMessage,
        pendingKeyPicker.passphrase,
        selectedFingerprint,
      )
      setFingerprint(info.fingerprint)
      setPendingKeyPicker(null)
      setPendingImportFileArmored(null)
      setBackedUpFingerprint(plugin.getBackedUpFingerprint?.() ?? info.fingerprint)
      setBackupProbeNonce((n) => n + 1)
      addToast('success', t('settings.encryption.restoreSuccess'))
    },
    [pendingKeyPicker, client, addToast, t],
  )

  /**
   * Rotate the encryption subkey. The primary key (and therefore the
   * fingerprint peers verified) is unchanged — trust survives without a
   * re-verification ceremony. Past messages remain decryptable on this
   * device because the retired [E] is kept in the local cert.
   *
   * When a server backup is in sync with this device's current
   * fingerprint, we re-wrap the backup with a freshly-generated
   * passphrase as part of the same operation: leaving the server copy
   * stale would let the user click "Restore" and recover a key that
   * doesn't include the new subkey.
   *
   * Throws on failure. The two callers handle errors differently: the
   * passphrase-dialog path lets the dialog catch and surface the error
   * inline; the no-backup path catches and toasts.
   */
  const doRotate = useCallback(
    async (passphrase: string | undefined) => {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | { rotateEncryptionKey?: (pp?: string) => Promise<{ fingerprint: string }> }
        | null
        | undefined
      if (!plugin?.rotateEncryptionKey) {
        throw new Error(t('settings.encryption.rotatePluginUnavailable'))
      }
      await plugin.rotateEncryptionKey(passphrase)
      // Re-probe so the backup status reflects the freshly-published
      // ciphertext (or the fact that we now diverge from the server).
      setBackupProbeNonce((n) => n + 1)
      addToast('success', t('settings.encryption.rotateSuccess'))
    },
    [client, addToast, t],
  )

  const handleRotateRequest = useCallback(() => {
    setShowRotateConfirm(true)
  }, [])

  const handleRotateConfirm = useCallback(() => {
    setShowRotateConfirm(false)
    const inSync =
      remoteBackupExists === true &&
      !!fingerprint &&
      backedUpFingerprint === fingerprint
    if (inSync) {
      // Generate a new backup passphrase and re-publish atomically.
      // The dialog drives its own loading + error UI from now on.
      setShowRotatePassphraseDialog(true)
    } else {
      // No backup or out-of-sync: rotate directly. Spinner on the
      // button + toast on success/failure.
      setIsRotating(true)
      doRotate(undefined)
        .catch((err) => {
          console.error('[Fluux] E2EE rotate failed:', err)
          addToast('error', t('settings.encryption.rotateFailed'))
        })
        .finally(() => setIsRotating(false))
    }
  }, [remoteBackupExists, backedUpFingerprint, fingerprint, doRotate, addToast, t])

  const handleRotatePassphraseConfirm = useCallback(
    async (passphrase: string) => {
      // Let the dialog handle the loading + error state — it already
      // does for the regular backup flow.
      await doRotate(passphrase)
      setShowRotatePassphraseDialog(false)
    },
    [doRotate],
  )

  const handleDeleteKey = useCallback(
    async ({ deleteBackup }: { deleteBackup: boolean }) => {
      setIsDeleting(true)
      try {
        const plugin = client.e2ee?.getPlugin('openpgp') as
          | {
              retractPublicKeys?: () => Promise<void>
              retractSecretKeyBackup?: () => Promise<void>
              deleteIdentity?: () => Promise<void>
            }
          | null
          | undefined

        // Order matters. Retract FIRST so peers stop discovering our
        // fingerprint while we still have an XMPP session. If the
        // retract throws (network, server rejected the IQ), we bubble
        // the error to the dialog and leave local key material intact —
        // the user can retry without being stranded.
        if (plugin?.retractPublicKeys) {
          await plugin.retractPublicKeys()
        }
        if (deleteBackup && plugin?.retractSecretKeyBackup) {
          await plugin.retractSecretKeyBackup()
        }

        // Peers are now (best-effort) unable to encrypt to us — safe to
        // wipe the local key material and unregister.
        if (plugin?.deleteIdentity) {
          await plugin.deleteIdentity()
        }
        await unregisterE2EEPlugins(client)
        setOpenpgpEnabled(false)
        setFingerprint(null)
        setShowDeleteConfirm(false)
        addToast('success', t('settings.encryption.deleteKeySuccess'))
      } catch (err) {
        console.error('[Fluux] E2EE delete key failed:', err)
        addToast('error', t('settings.encryption.deleteKeyFailed'))
        throw err
      } finally {
        setIsDeleting(false)
      }
    },
    [client, setOpenpgpEnabled, addToast, t],
  )

  const handleExportFileConfirm = useCallback(
    async (passphrase: string) => {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | { exportKeyToFile?: (pp: string) => Promise<boolean> }
        | null
        | undefined
      if (!plugin?.exportKeyToFile) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      const saved = await plugin.exportKeyToFile(passphrase)
      setShowExportFileDialog(false)
      if (saved) {
        addToast('success', t('settings.encryption.exportFileSuccess'))
      }
    },
    [client, addToast, t],
  )

  const handleImportFileRequest = useCallback(async () => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { pickKeyFile?: () => Promise<string | null> }
      | null
      | undefined
    if (!plugin?.pickKeyFile) return
    try {
      const content = await plugin.pickKeyFile()
      if (!content) return
      setPendingImportFileArmored(content)
      setShowImportFileDialog(true)
    } catch (err) {
      console.error('[Fluux] E2EE file pick failed:', err)
      addToast('error', t('settings.encryption.importFileFailed'))
    }
  }, [client, addToast, t])

  const handleImportFileConfirm = useCallback(
    async (passphrase: string) => {
      if (!pendingImportFileArmored) return
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            importKeyFromFile?: (armored: string, pp: string) => Promise<
              { fingerprint: string } | { needsPicker: true; candidates: KeyBundle[]; backupContext: { message: string; passphrase: string } }
            >
          }
        | null
        | undefined
      if (!plugin?.importKeyFromFile) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      const result = await plugin.importKeyFromFile(pendingImportFileArmored, passphrase)
      if ('needsPicker' in result) {
        setPendingKeyPicker({
          candidates: result.candidates,
          backupMessage: result.backupContext.message,
          passphrase: result.backupContext.passphrase,
        })
        setShowImportFileDialog(false)
        return
      }
      setFingerprint(result.fingerprint)
      setShowImportFileDialog(false)
      setPendingImportFileArmored(null)
      setBackupProbeNonce((n) => n + 1)
      addToast('success', t('settings.encryption.importFileSuccess'))
    },
    [pendingImportFileArmored, client, addToast, t],
  )

  return (
    <section className="max-w-md w-full">
      <h3 className="text-xs font-semibold text-fluux-muted uppercase tracking-wide mb-4">
        {t('settings.categories.encryption')}
      </h3>

      <div className="space-y-6">
        {/* Toggle block */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Lock className="w-4 h-4 text-fluux-muted flex-shrink-0" />
                <label className="text-sm font-medium text-fluux-text">
                  {t('settings.encryption.openpgpLabel')}
                </label>
                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-yellow-500/15 text-yellow-600 dark:text-yellow-400">
                  {t('settings.encryption.experimental')}
                </span>
              </div>
              <p className="mt-1 text-xs text-fluux-muted leading-snug">
                {t('settings.encryption.openpgpDescription')}
              </p>
            </div>
            <button
              onClick={handleToggle}
              disabled={isToggling}
              aria-pressed={openpgpEnabled}
              aria-label={t('settings.encryption.openpgpLabel')}
              className={`relative w-9 h-5 rounded-full transition-colors flex-shrink-0 ${
                openpgpEnabled ? 'bg-fluux-brand' : 'bg-fluux-hover'
              } ${isToggling ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
            >
              <span
                className={`absolute top-0.5 start-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  openpgpEnabled ? 'translate-x-4' : ''
                }`}
              />
            </button>
          </div>
        </div>

        {/* Own-key conflict banner — shown above status when init detects a
            mismatch between the local key and what the server advertises */}
        {openpgpEnabled && <OwnKeyConflictBanner />}

        {/* Web locked banner — shown when key exists but no session passphrase */}
        {webLocked && (
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
            <p className="text-xs text-fluux-text leading-snug flex-1">
              {t('settings.encryption.lockedBannerBody')}
            </p>
            <button
              onClick={() => setShowUnlockDialog(true)}
              className="flex-shrink-0 px-3 py-1.5 text-sm text-white bg-fluux-brand hover:opacity-90 rounded-lg transition-colors"
            >
              {t('settings.encryption.unlockAction')}
            </button>
          </div>
        )}

        {/* Status + fingerprint block — only when enabled */}
        {openpgpEnabled && (
          <div className="space-y-3">
            <label className="text-sm font-medium text-fluux-text">
              {t('settings.encryption.statusLabel')}
            </label>
            <div
              className={`rounded-lg border-2 p-3 space-y-2 ${
                pluginStatus === 'generation-failed'
                  ? 'border-red-500/40 bg-red-500/5'
                  : 'border-fluux-hover bg-fluux-bg'
              }`}
            >
              <div
                className={`text-xs ${
                  pluginStatus === 'generation-failed'
                    ? 'text-red-500 dark:text-red-400'
                    : 'text-fluux-muted'
                }`}
              >
                {pluginStatus === 'waiting-online' &&
                  t('settings.encryption.statusWaitingOnline')}
                {pluginStatus === 'generating' &&
                  t('settings.encryption.statusGenerating')}
                {pluginStatus === 'ready' && t('settings.encryption.statusReady')}
                {pluginStatus === 'generation-failed' &&
                  t('settings.encryption.statusGenerationFailed')}
              </div>
              {fingerprint && (
                <div className="flex items-start gap-2">
                  <code className="flex-1 text-xs font-mono text-fluux-text whitespace-pre-line leading-relaxed">
                    {formatFingerprintMultiline(fingerprint)}
                  </code>
                  <button
                    onClick={handleCopyFingerprint}
                    className="p-1.5 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover transition-colors"
                    title={t('settings.encryption.copyFingerprint')}
                    aria-label={t('settings.encryption.copyFingerprint')}
                  >
                    {isCopied ? (
                      <Check className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Limitations callout — dismissible */}
        {!limitationsDismissed && (
          <div className="flex gap-2 p-3 rounded-lg bg-yellow-500/10 text-xs text-fluux-muted leading-snug">
            <AlertTriangle className="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-fluux-text">
                {t('settings.encryption.limitationsTitle')}
              </p>
              <p className="mt-1">{t('settings.encryption.limitationBackend')}</p>
            </div>
            <button
              onClick={handleDismissLimitations}
              aria-label={t('common.close')}
              className="flex-shrink-0 p-0.5 text-fluux-muted hover:text-fluux-text rounded transition-colors"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Backup to server — only when a key actually exists to back up. */}
        {pluginStatus === 'ready' && (
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <label className="text-sm font-medium text-fluux-text">
                {t('settings.encryption.backupLabel')}
              </label>
              <button
                onClick={() => setBackupDescVisible((v) => !v)}
                aria-label={t('settings.encryption.backupLabel')}
                className="text-fluux-muted hover:text-fluux-text transition-colors"
              >
                <Info className="w-3.5 h-3.5" />
              </button>
            </div>
            {backupDescVisible && (
              <p className="text-xs text-fluux-muted leading-snug">
                {t('settings.encryption.backupDescription')}
              </p>
            )}
            {(() => {
              // Three visible states:
              //   checking  → pre-probe transient
              //   inSync    → server has a backup AND it matches this
              //               device's current fingerprint (by our local
              //               marker). Buttons are redundant.
              //   outOfSync → backup is missing, or present but for a
              //               different fingerprint — show backup, and
              //               show restore when something is there to
              //               restore from.
              const checking = remoteBackupExists === null
              const inSync =
                remoteBackupExists === true &&
                !!fingerprint &&
                backedUpFingerprint === fingerprint
              return (
                <>
                  <p className="text-xs leading-snug">
                    {checking && (
                      <span className="text-fluux-muted">
                        {t('settings.encryption.backupStatusChecking')}
                      </span>
                    )}
                    {!checking && inSync && (
                      <span className="text-green-600 dark:text-green-400">
                        {t('settings.encryption.backupStatusInSync')}
                      </span>
                    )}
                    {!checking && !inSync && remoteBackupExists === false && (
                      <span className="text-fluux-muted">
                        {t('settings.encryption.backupStatusNone')}
                      </span>
                    )}
                    {!checking && !inSync && remoteBackupExists === true && (
                      <span className="text-yellow-600 dark:text-yellow-400">
                        {t('settings.encryption.backupStatusMismatch')}
                      </span>
                    )}
                  </p>
                  {!checking && !inSync && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={handleBackupRequest}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                      >
                        <CloudUpload className="w-3.5 h-3.5" />
                        {t('settings.encryption.backupAction')}
                      </button>
                      {remoteBackupExists === true && (
                        <button
                          onClick={() => setShowRestoreDialog(true)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                        >
                          <CloudDownload className="w-3.5 h-3.5" />
                          {t('settings.encryption.restoreAction')}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2 pt-2 border-t border-fluux-hover/60">
                    <button
                      onClick={() => setShowExportFileDialog(true)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                    >
                      <FileDown className="w-3.5 h-3.5" />
                      {t('settings.encryption.exportFileAction')}
                    </button>
                    <button
                      onClick={() => { void handleImportFileRequest() }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                    >
                      <FileUp className="w-3.5 h-3.5" />
                      {t('settings.encryption.importFileAction')}
                    </button>
                  </div>
                </>
              )
            })()}
          </div>
        )}

        {/* Rotation — primary fingerprint stays stable so peer trust survives.
            Not available on web (openpgp.js v6 key rotation is MVP-deferred). */}
        {pluginStatus === 'ready' && isTauri() && (
          <div className="space-y-2 pt-2 border-t border-fluux-hover">
            <div className="flex items-center gap-1.5">
              <label className="text-sm font-medium text-fluux-text">
                {t('settings.encryption.rotateLabel')}
              </label>
              <button
                onClick={() => setRotateDescVisible((v) => !v)}
                aria-label={t('settings.encryption.rotateLabel')}
                className="text-fluux-muted hover:text-fluux-text transition-colors"
              >
                <Info className="w-3.5 h-3.5" />
              </button>
            </div>
            {rotateDescVisible && (
              <p className="text-xs text-fluux-muted leading-snug">
                {t('settings.encryption.rotateDescription')}
              </p>
            )}
            <button
              onClick={handleRotateRequest}
              disabled={isRotating}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors disabled:opacity-50 disabled:cursor-wait"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isRotating ? 'animate-spin' : ''}`}
              />
              {t('settings.encryption.rotateAction')}
            </button>
          </div>
        )}
        {pluginStatus === 'ready' && !isTauri() && (
          <div className="pt-2 border-t border-fluux-hover">
            <p className="text-xs text-fluux-muted leading-snug">
              {t('settings.encryption.rotateNotSupportedWeb')}
            </p>
          </div>
        )}

        {/* Destructive action — only when a key actually exists to delete. */}
        {pluginStatus === 'ready' && (
          <div className="pt-2 border-t border-fluux-hover">
            <button
              onClick={() => setDangerZoneExpanded((v) => !v)}
              aria-expanded={dangerZoneExpanded}
              className="flex items-center gap-1.5 w-full text-left"
            >
              {dangerZoneExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-fluux-muted flex-shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-fluux-muted flex-shrink-0" />
              )}
              <span className="text-sm font-medium text-fluux-text">
                {t('settings.encryption.dangerZone')}
              </span>
            </button>
            {dangerZoneExpanded && (
              <div className="space-y-2 mt-2">
                <p className="text-xs text-fluux-muted leading-snug">
                  {t('settings.encryption.deleteKeyDescription')}
                </p>
                <button
                  onClick={() => setShowDeleteConfirm(true)}
                  disabled={isDeleting}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-red-500/10 hover:bg-red-500/20 text-red-500 dark:text-red-400 rounded transition-colors disabled:opacity-50 disabled:cursor-wait"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  {t('settings.encryption.deleteKey')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {showDeleteConfirm && fingerprint && (
        <DeleteOpenpgpKeyDialog
          fingerprint={fingerprint}
          backupExists={remoteBackupExists === true}
          onConfirm={handleDeleteKey}
          onCancel={() => {
            if (!isDeleting) setShowDeleteConfirm(false)
          }}
        />
      )}

      {showBackupConflictConfirm && (
        <ConfirmDialog
          title={t('settings.encryption.backupConflictTitle')}
          message={t('settings.encryption.backupConflictMessage')}
          confirmLabel={t('settings.encryption.backupConflictAction')}
          variant="danger"
          onConfirm={() => {
            setShowBackupConflictConfirm(false)
            setShowBackupDialog(true)
          }}
          onCancel={() => setShowBackupConflictConfirm(false)}
        />
      )}

      {showBackupDialog && (
        <BackupPassphraseDialog
          onConfirm={handleBackupConfirm}
          onCancel={() => setShowBackupDialog(false)}
        />
      )}

      {showRestoreDialog && (
        <RestorePassphraseDialog
          onConfirm={handleRestoreConfirm}
          onCancel={() => setShowRestoreDialog(false)}
        />
      )}

      {showRotateConfirm && (
        <ConfirmDialog
          title={t('settings.encryption.rotateConfirmTitle')}
          message={
            remoteBackupExists === true && backedUpFingerprint === fingerprint
              ? t('settings.encryption.rotateConfirmMessageWithBackup')
              : t('settings.encryption.rotateConfirmMessage')
          }
          confirmLabel={t('settings.encryption.rotateConfirmAction')}
          variant="warning"
          onConfirm={handleRotateConfirm}
          onCancel={() => setShowRotateConfirm(false)}
        />
      )}

      {showRotatePassphraseDialog && (
        <BackupPassphraseDialog
          onConfirm={handleRotatePassphraseConfirm}
          onCancel={() => {
            if (!isRotating) setShowRotatePassphraseDialog(false)
          }}
        />
      )}

      {pendingEnableBackup && (
        <EnableWithBackupDialog
          onRestore={handleEnableRestore}
          onUseFresh={handleEnableUseFresh}
          onCancel={handleEnableCancel}
        />
      )}

      {showExportFileDialog && (
        <BackupPassphraseDialog
          title={t('settings.encryption.exportFileDialogTitle')}
          body={t('settings.encryption.exportFileDialogBody')}
          confirmLabel={t('settings.encryption.exportFileAction')}
          onConfirm={handleExportFileConfirm}
          onCancel={() => setShowExportFileDialog(false)}
        />
      )}

      {showImportFileDialog && pendingImportFileArmored && (
        <RestorePassphraseDialog
          title={t('settings.encryption.importFileDialogTitle')}
          body={t('settings.encryption.importFileDialogBody')}
          confirmLabel={t('settings.encryption.importFileAction')}
          onConfirm={handleImportFileConfirm}
          onCancel={() => {
            setShowImportFileDialog(false)
            setPendingImportFileArmored(null)
          }}
        />
      )}

      {showUnlockDialog && (
        <UnlockEncryptionDialog
          client={client}
          onClose={() => setShowUnlockDialog(false)}
        />
      )}

      {pendingKeyPicker && (
        <KeyPickerDialog
          candidates={pendingKeyPicker.candidates}
          onConfirm={handleKeyPickerConfirm}
          onCancel={() => setPendingKeyPicker(null)}
        />
      )}
    </section>
  )
}

/**
 * Split a hex fingerprint into groups of 4 across two balanced lines so
 * it's easy to read and fills the available width. Works for any length:
 * 40 chars (v4/RFC 4880, SHA-1) → 10 groups, or 64 chars (v6/RFC 9580,
 * SHA-256) → 16 groups.
 */
function formatFingerprintMultiline(fp: string): string {
  const groups = fp.match(/.{1,4}/g)
  if (!groups || groups.length <= 1) return fp
  const mid = Math.ceil(groups.length / 2)
  return `${groups.slice(0, mid).join(' ')}\n${groups.slice(mid).join(' ')}`
}
