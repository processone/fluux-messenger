import { useEffect, useRef, useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Copy, Check, Lock, AlertTriangle, Trash2, CloudUpload, CloudDownload, RefreshCw, X, Info, ChevronDown, ChevronRight, FileDown, FileUp } from 'lucide-react'
import { Toggle } from '@/components/ui/Toggle'
import { SettingsSection } from '@/components/ui/SettingsSection'
import { useConnection, useXMPPContext, getBareJid } from '@fluux/sdk'
import { useEncryptionSettingsStore } from '@/stores/encryptionSettingsStore'
import { registerE2EEPlugins, unregisterE2EEPlugins } from '@/e2ee/registerPlugins'
import { useToastStore } from '@/stores/toastStore'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DeleteOpenpgpKeyDialog } from '@/components/DeleteOpenpgpKeyDialog'
import { BackupPassphraseDialog } from '@/components/BackupPassphraseDialog'
import { RestorePassphraseDialog } from '@/components/RestorePassphraseDialog'
import { parseArmorPassphraseFormat } from '@/e2ee/passphraseFormatHeader'
import { IdentityChoiceDialog } from '@/components/IdentityChoiceDialog'
import { OwnKeyConflictBanner } from '@/components/OwnKeyConflictBanner'
import { TrustStateCompromisedBanner } from '@/components/TrustStateCompromisedBanner'
import { useWebUnlockDialogStore } from '@/stores/webUnlockDialogStore'
import { KeyPickerDialog } from '@/components/KeyPickerDialog'
import type { KeyBundle, BackupProbeResult } from '@/e2ee/OpenPGPPluginBase'
import {
  probeRemoteIdentityState,
  SecretKeyBackupProbeError,
} from '@/e2ee/secretKeyProbe'
import { isKeyLocked } from '@/e2ee/webPassphraseStore'
import { isTauri } from '@/utils/tauri'

type PluginStatus =
  | 'disabled'
  | 'locked'
  | 'generating'
  | 'ready'
  | 'waiting-online'
  | 'generation-failed'
  | 'registration-failed'

/**
 * If the Rust-side key generation doesn't produce a fingerprint within this
 * window the plugin almost certainly failed (IPC error, panic, unwired
 * command) — surface a clear error instead of a forever-spinning placeholder.
 * 60s is generous; even the slow RustCrypto backend completes in <10s on
 * target hardware.
 */
const GENERATION_TIMEOUT_MS = 60_000

/**
 * Copy for the pre-publish confirmation. Publishing always overwrites the
 * server blob AND always mints a fresh passphrase, so both variants are
 * destructive; they differ only in what the user is losing.
 *   own     — this device published the current backup. The passphrase the
 *             user saved (and may have configured in other clients) dies.
 *   foreign — the server copy came from somewhere else. Whoever holds ITS
 *             passphrase loses access.
 */
const BACKUP_CONFIRM_KEYS = {
  own: {
    title: 'settings.encryption.backupReplaceOwnTitle',
    message: 'settings.encryption.backupReplaceOwnMessage',
    action: 'settings.encryption.backupReplaceOwnAction',
  },
  foreign: {
    title: 'settings.encryption.backupConflictTitle',
    message: 'settings.encryption.backupConflictMessage',
    action: 'settings.encryption.backupConflictAction',
  },
  unknown: {
    title: 'settings.encryption.backupReplaceUnknownTitle',
    message: 'settings.encryption.backupReplaceUnknownMessage',
    action: 'settings.encryption.backupReplaceUnknownAction',
  },
} as const

type BackupConfirmVariant = keyof typeof BACKUP_CONFIRM_KEYS

/**
 * Server-probe state for the secret-key backup node.
 *
 * `unknown` is deliberately distinct from `absent`: a failed probe used to
 * be coerced to "no backup", which skipped the replace confirmation and let
 * a transient network failure overwrite a real backup. Consumers treat
 * `unknown` as "a backup might exist".
 */
type BackupProbeState = 'checking' | BackupProbeResult

/**
 * Is the server-side backup known to match this device's current key?
 *
 * All three inputs have to line up:
 *   - `backupProbe` — server-probe tri-state (plus `checking`); only
 *     `present` can possibly be in sync (callers show a "Checking…"
 *     state while pending, and `unknown`/`absent` are never in sync).
 *   - `backedUpFingerprint` — local marker recorded at the last
 *     successful backup/restore. `null` means this device never
 *     published, so whatever sits on PEP belongs to someone else.
 *   - `fingerprint` — this device's current key. A missing key can
 *     never be in sync, hence the explicit truthiness guard: without
 *     it a null/null pair would compare equal and report in-sync.
 *
 * Deliberately does NOT normalize case. Both fingerprints trace back
 * to the same unnormalized `ownBundle.fingerprint`, so comparing them
 * raw is correct here; normalizing would be a behavior change that
 * needs its own decision rather than riding along with this helper.
 */
function isBackupInSync(
  backupProbe: BackupProbeState,
  backedUpFingerprint: string | null,
  fingerprint: string | null,
): boolean {
  return backupProbe === 'present' && !!fingerprint && backedUpFingerprint === fingerprint
}

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
  const registrationError = useEncryptionSettingsStore((s) => s.registrationError)
  const addToast = useToastStore((s) => s.addToast)

  const [fingerprint, setFingerprint] = useState<string | null>(null)
  // Desktop only: false when the key's passphrase fell back to a cleartext
  // file on disk (no OS secret service), i.e. the key is not protected at
  // rest. Refreshed whenever the active fingerprint changes.
  const [keychainBacked, setKeychainBacked] = useState<boolean | null>(null)
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
  // Surfaced when the user clicks "Back up to server" while ANY backup
  // already lives on PEP. Publishing overwrites it and mints a fresh
  // passphrase, so the old code stops working either way; the variant
  // decides which consequence we spell out. null = no confirmation open.
  const [backupConfirmVariant, setBackupConfirmVariant] =
    useState<BackupConfirmVariant | null>(null)
  // `checking` until the first probe settles. See BackupProbeState.
  const [backupProbe, setBackupProbe] = useState<BackupProbeState>('checking')
  // Fingerprint recorded locally at the moment of the last successful
  // backup/restore. When this equals the current local fingerprint AND
  // a remote backup exists, local and server are known to be in sync.
  const [backedUpFingerprint, setBackedUpFingerprint] = useState<string | null>(null)
  // Set whenever the toggle (or auto-init) detected an existing server-
  // side OpenPGP identity but this device has no local key. The user must
  // resolve via the IdentityChoiceDialog — silent generation is refused
  // both here AND inside WebOpenPGPPlugin.ensureKeyMaterial (defence in
  // depth).
  const [pendingIdentityChoice, setPendingIdentityChoice] = useState<{
    accountJid: string
    hasBackup: boolean
    publishedFingerprints: string[]
    reason?: 'no-local-key' | 'local-key-unrecoverable'
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
  const openWebUnlockDialog = useWebUnlockDialogStore((s) => s.openWebUnlockDialog)
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
  // A typed registration failure means no plugin got registered at all —
  // it outranks the web "locked" state, whose unlock flow needs a
  // registered plugin to act on.
  const webLocked = !isTauri() && openpgpEnabled && isKeyLocked() && !registrationError
  const pluginStatus: PluginStatus = !openpgpEnabled
    ? 'disabled'
    : !online
      ? 'waiting-online'
      : fingerprint
        ? 'ready'
        : registrationError
          ? 'registration-failed'
          : webLocked
            ? 'locked'
            : generationFailed
              ? 'generation-failed'
              : 'generating'

  // Proactive PEP probe (XEP-0163): OpenPGP (XEP-0373) publishes keys to
  // PEP nodes on the account bare JID, so a server without PEP can never
  // support it. Probe as soon as we're online and warn BEFORE the user
  // flips the toggle — otherwise the failure only surfaces after key
  // generation has already run (issue #414). `null` means "unknown"
  // (offline, probe pending, or probe failed) and fails open.
  const [pepSupported, setPepSupported] = useState<boolean | null>(null)
  useEffect(() => {
    if (!online) {
      setPepSupported(null)
      return
    }
    let cancelled = false
    client.discovery
      .checkPepSupport()
      .then((supported) => {
        if (!cancelled) setPepSupported(supported)
      })
      .catch(() => {
        // Transient probe failure (timeout, reconnect race) — don't block
        // the toggle on an unknown; the plugin re-probes on registration.
        if (!cancelled) setPepSupported(null)
      })
    return () => {
      cancelled = true
    }
  }, [online, client])

  // Block ENABLING on a server known to lack PEP, but never block turning
  // the feature off — the preference may have been set while offline or
  // before a server config change.
  const toggleDisabled = isToggling || (!openpgpEnabled && pepSupported === false)

  // Track fingerprint — poll briefly after enable so the "Generating…"
  // state resolves without needing a manual reload. The plugin exposes
  // its fingerprint synchronously via a direct method on the instance.
  useEffect(() => {
    if (!openpgpEnabled || !online) {
      setFingerprint(null)
      setGenerationFailed(false)
      return
    }
    // Registration already failed with a typed error — the status line
    // explains it; polling for a fingerprint would just spin for 60s.
    if (registrationError) return

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
  }, [openpgpEnabled, online, client, registrationError])

  // Surface recovery from Settings when a local key exists but can't be
  // unlocked. The connect-time dialog (App.tsx) may have been dismissed, and
  // the toggle gates on `hasNoLocalKey()` which is false for a present-but-
  // broken key — so without this the panel would report a misleading state
  // and the user would be stuck. Auto-open ONCE per mount (the ref guard
  // prevents re-opening on dismiss, so the user isn't trapped); re-entering
  // Settings or toggling re-offers it.
  const recoveryPromptedRef = useRef(false)
  useEffect(() => {
    if (recoveryPromptedRef.current) return
    if (!online || !openpgpEnabled || pendingIdentityChoice || registrationError) {
      return
    }
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { isKeyRecoveryNeeded?: () => boolean }
      | null
      | undefined
    if (plugin?.isKeyRecoveryNeeded?.() !== true) return
    const bareJid = jid ? getBareJid(jid) : null
    if (!bareJid) return
    recoveryPromptedRef.current = true
    let cancelled = false
    void (async () => {
      let next: {
        accountJid: string
        hasBackup: boolean
        publishedFingerprints: string[]
        reason: 'local-key-unrecoverable'
      }
      try {
        const state = await probeRemoteIdentityState(client, bareJid)
        next = {
          accountJid: bareJid,
          hasBackup: state.backupMessage !== null,
          publishedFingerprints: state.publishedFingerprints,
          reason: 'local-key-unrecoverable',
        }
      } catch {
        // Probe failed: still open so import/replace are reachable; restore
        // stays disabled until the server probe succeeds.
        next = {
          accountJid: bareJid,
          hasBackup: false,
          publishedFingerprints: [],
          reason: 'local-key-unrecoverable',
        }
      }
      if (!cancelled) setPendingIdentityChoice(next)
    })()
    return () => {
      cancelled = true
    }
  }, [online, openpgpEnabled, pendingIdentityChoice, registrationError, client, jid])

  // Track whether the active key is keychain-backed (desktop only). Keyed on
  // `fingerprint` so it refreshes after every path that establishes a key
  // (connect-time load, restore, import, generate). Web never warns: its
  // `keychainBacked: false` means IndexedDB + session passphrase, not
  // cleartext on disk.
  useEffect(() => {
    if (!isTauri() || !fingerprint) {
      setKeychainBacked(null)
      return
    }
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { isKeychainBacked?: () => boolean | null }
      | null
    setKeychainBacked(plugin?.isKeychainBacked?.() ?? null)
  }, [fingerprint, client])

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
      const bareJid = jid ? getBareJid(jid) : null
      if (!isTauri()) {
        // Web: same defence-in-depth as desktop — never silently generate
        // when the server already advertises an OpenPGP identity for this
        // account. The crypto-layer guard in WebOpenPGPPlugin would refuse
        // anyway, but probing here lets us surface the resolution dialog
        // directly instead of letting the unlock dialog fail with an
        // obscure error.
        //
        // Register first so we can use the plugin's `hasNoLocalKey` to
        // tell apart fresh-browser (needs choice) from returning-browser
        // (needs unlock). `init` swallows both `key-locked` and
        // `needs-identity-decision` so registration succeeds in either
        // state.
        await registerE2EEPlugins(client)
        if (!bareJid) {
          if (isKeyLocked()) openWebUnlockDialog()
          return
        }
        const plugin = client.e2ee?.getPlugin('openpgp') as
          | { hasNoLocalKey?: () => Promise<boolean> }
          | null
          | undefined
        const hasNoLocal = plugin?.hasNoLocalKey
          ? await plugin.hasNoLocalKey()
          : false
        if (hasNoLocal) {
          const state = await probeRemoteIdentityState(client, bareJid)
          if (state.hasServerIdentity) {
            setPendingIdentityChoice({
              accountJid: bareJid,
              hasBackup: state.backupMessage !== null,
              publishedFingerprints: state.publishedFingerprints,
            })
            return
          }
        }
        if (isKeyLocked()) {
          openWebUnlockDialog()
        }
        return
      }
      if (!bareJid) {
        // Unknown JID on desktop: just register.
        await registerE2EEPlugins(client)
        return
      }

      // Desktop: register first. Since the silent-fork guard now also
      // lives in SequoiaPgpPlugin.ensureKeyMaterial, registration is
      // safe even when the server has an existing identity — init
      // swallows `needs-identity-decision` and the plugin stays
      // registered without generating. After register, three states
      // are possible:
      //
      //   - hasNoLocal=false → key was loaded from the OS keychain
      //     (returning device) or generated fresh (clean account).
      //     Nothing more to do; the toggle is on and the plugin is
      //     ready.
      //
      //   - hasNoLocal=true → the guard fired. The server has an
      //     OpenPGP identity for this account but the device has no
      //     matching private key. Probe to enumerate the published
      //     fingerprints + backup state for the dialog, then route
      //     the user through IdentityChoiceDialog.
      //
      // The probe runs only in the second case; the common path
      // (returning device) pays no extra IQ.
      await registerE2EEPlugins(client)
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            hasNoLocalKey?: () => Promise<boolean>
            isKeyRecoveryNeeded?: () => boolean
          }
        | null
        | undefined
      // A present-but-unreadable local key (keychain/key desync) needs the
      // same recovery dialog as a missing key — but `hasNoLocalKey()` is
      // false for it (the .tsk.asc exists), so consult the recovery flag too.
      // Without this, a user who dismissed the connect-time dialog and came to
      // Settings to "fix encryption" would see the toggle report all-good
      // while encryption silently never starts.
      const recoveryNeeded = plugin?.isKeyRecoveryNeeded?.() === true
      const hasNoLocal =
        !recoveryNeeded && plugin?.hasNoLocalKey
          ? await plugin.hasNoLocalKey()
          : false
      if (!recoveryNeeded && !hasNoLocal) return
      const state = await probeRemoteIdentityState(client, bareJid)
      // For a missing key we only prompt when the server has an identity to
      // reconcile against; an unrecoverable local key always needs a decision
      // (import/replace remain available even with no server backup).
      if (!recoveryNeeded && !state.hasServerIdentity) return
      setPendingIdentityChoice({
        accountJid: bareJid,
        hasBackup: state.backupMessage !== null,
        publishedFingerprints: state.publishedFingerprints,
        reason: recoveryNeeded ? 'local-key-unrecoverable' : 'no-local-key',
      })
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
  }, [openpgpEnabled, online, client, jid, setOpenpgpEnabled, addToast, t, openWebUnlockDialog])

  // --- Identity choice dialog handlers (silent-fork prevention) ---
  // Each handler resolves the `pendingIdentityChoice` state with one of
  // the three explicit recovery paths. All three end by clearing the
  // pending state and routing through the rest of the toggle flow so the
  // user lands on the same "ready" state regardless of which path was
  // taken.

  const handleIdentityChoiceRestore = useCallback(
    async (passphrase: string) => {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            restoreSecretKey?: (pp: string) => Promise<
              | { fingerprint: string }
              | {
                  needsPicker: true
                  candidates: KeyBundle[]
                  backupContext: { message: string; passphrase: string }
                }
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
        // Multi-key backup: hand off to the existing picker. The choice
        // dialog closes so the picker isn't stacked on top of it.
        setPendingKeyPicker({
          candidates: result.candidates,
          backupMessage: result.backupContext.message,
          passphrase: result.backupContext.passphrase,
        })
        setPendingIdentityChoice(null)
        return
      }
      setFingerprint(result.fingerprint)
      setBackedUpFingerprint(plugin.getBackedUpFingerprint?.() ?? result.fingerprint)
      setPendingIdentityChoice(null)
      addToast('success', t('settings.encryption.restoreSuccess'))
    },
    [client, t, addToast],
  )

  const handleIdentityChoiceImportFile = useCallback(async () => {
    // Mirror the existing file-import flow (handleImportFileRequest defined
    // below). Inlined here to avoid a forward-reference (the choice
    // handlers live near the toggle/probe code; the file flow lives in
    // the danger-zone block further down).
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { pickKeyFile?: () => Promise<string | null> }
      | null
      | undefined
    if (!plugin?.pickKeyFile) return
    const content = await plugin.pickKeyFile()
    if (!content) return
    setPendingImportFileArmored(content)
    // Close the choice dialog first so the passphrase dialog isn't
    // stacked. The passphrase dialog's onConfirm handler
    // (handleImportFileConfirm) will run the import.
    setPendingIdentityChoice(null)
    setShowImportFileDialog(true)
  }, [client])

  const handleIdentityChoiceReplace = useCallback(async () => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { retireAndGenerateIdentity?: () => Promise<{ fingerprint: string }> }
      | null
      | undefined
    if (!plugin?.retireAndGenerateIdentity) {
      throw new Error(t('settings.encryption.backupPluginUnavailable'))
    }
    const result = await plugin.retireAndGenerateIdentity()
    setFingerprint(result.fingerprint)
    setPendingIdentityChoice(null)
    addToast('success', t('settings.encryption.restoreSuccess'))
  }, [client, t, addToast])

  const handleIdentityChoiceCancel = useCallback(() => {
    // User opted out — turn the toggle back off rather than leaving
    // them in a half-registered state where the plugin sits idle.
    setPendingIdentityChoice(null)
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
      setBackupProbe('checking')
      setBackedUpFingerprint(null)
      return
    }
    let cancelled = false
    void (async () => {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            probeSecretKeyBackup?: () => Promise<BackupProbeResult>
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
      if (!plugin?.probeSecretKeyBackup) {
        // No plugin method at all is a different thing from a failed probe:
        // there is nothing to publish to, so `absent` is truthful here.
        if (!cancelled) setBackupProbe('absent')
        return
      }
      // The method is documented as non-throwing, but it's reached through
      // a structural `as` cast, so the compiler can't hold the plugin to
      // that contract. If it ever rejects anyway, land on `unknown` —
      // NEVER `absent`, which would resurrect the exact "failed probe
      // treated as no backup" bug this branch exists to fix — and never
      // leave `backupProbe` stuck on `checking`, which hides every button
      // (retry included) behind `{!checking && …}` and strands the user.
      const result = await plugin
        .probeSecretKeyBackup()
        .catch(() => 'unknown' as const)
      if (!cancelled) setBackupProbe(result)
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
   * Entry point for the "Back up to server" button. Publishing replaces
   * whatever is on the server and always generates a NEW passphrase
   * (BackupPassphraseDialog draws a fresh one on every open), so any
   * existing backup gets a confirmation first — the user is about to
   * invalidate a code they may have written down or configured in another
   * client. Which copy we show depends on whose backup it is: `own` when
   * our local marker says this device published the current one,
   * `foreign` otherwise (a sibling device, or a stale copy of an earlier
   * key). With nothing on the server there is nothing to lose, so we go
   * straight to the passphrase dialog.
   */
  const handleBackupRequest = useCallback(() => {
    if (backupProbe === 'absent') {
      // Server confirmed there is nothing to lose.
      setShowBackupDialog(true)
      return
    }
    if (backupProbe === 'unknown') {
      // We could not rule out a backup. Say so rather than asserting whose
      // it is — `foreign` would claim it wasn't made on this device, which
      // we do not know.
      setBackupConfirmVariant('unknown')
      return
    }
    const isOwnBackup = isBackupInSync(backupProbe, backedUpFingerprint, fingerprint)
    setBackupConfirmVariant(isOwnBackup ? 'own' : 'foreign')
  }, [backupProbe, backedUpFingerprint, fingerprint])

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
      // A successful restore is proof the server backup exists — bump the
      // nonce so the next probe (or, failing that, this fact) replaces a
      // stale `unknown`/`checking` status line rather than leaving the user
      // told we still can't tell whether a backup exists.
      setBackupProbeNonce((n) => n + 1)
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
    // `unknown` re-publishes: over-publishing a backup that didn't exist is
    // harmless, leaving a real one stale is not.
    if (backupProbe === 'unknown' || isBackupInSync(backupProbe, backedUpFingerprint, fingerprint)) {
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
  }, [backupProbe, backedUpFingerprint, fingerprint, doRotate, addToast, t])

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
      try {
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
      } catch (err) {
        const code = (err as { code?: string } | null)?.code
        if (code === 'unsupported-key-algorithm') {
          addToast('error', t('settings.encryption.unsupportedKeyAlgorithm'))
          setShowImportFileDialog(false)
          setPendingImportFileArmored(null)
          return
        }
        throw err
      }
    },
    [pendingImportFileArmored, client, addToast, t],
  )

  return (
    <section className="w-full max-w-md">
      <SettingsSection title={t('settings.categories.encryption')}>
      <div className="space-y-6">
        {/* Toggle block */}
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <Lock className="size-4 text-fluux-muted flex-shrink-0" />
                <label className="text-sm font-medium text-fluux-text">
                  {t('settings.encryption.openpgpLabel')}
                </label>
                <span className="px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider rounded bg-fluux-yellow/15 text-fluux-yellow">
                  {t('settings.encryption.experimental')}
                </span>
              </div>
              <p className="mt-1 text-xs text-fluux-muted leading-snug">
                {t('settings.encryption.openpgpDescription')}
              </p>
            </div>
            <Toggle
              checked={openpgpEnabled}
              onChange={handleToggle}
              disabled={toggleDisabled}
              loading={isToggling}
              aria-label={t('settings.encryption.openpgpLabel')}
            />
          </div>
        </div>

        {/* PEP-unsupported banner — the server can't host the published key,
            so OpenPGP (XEP-0373) can never work on this account. Shown from
            the proactive probe, before the user even tries the toggle. */}
        {pepSupported === false && (
          <div className="flex gap-2 p-3 rounded-lg bg-fluux-yellow/10 border border-fluux-yellow/20 text-xs leading-snug">
            <AlertTriangle className="size-4 text-fluux-yellow flex-shrink-0 mt-0.5" />
            <p className="flex-1 text-fluux-text">
              {t('settings.encryption.pepUnsupportedBanner')}
            </p>
          </div>
        )}

        {/* Own-key conflict banner — shown above status when init detects a
            mismatch between the local key and what the server advertises */}
        {openpgpEnabled && <OwnKeyConflictBanner />}
        {openpgpEnabled && <TrustStateCompromisedBanner />}

        {/* Web locked banner — shown when key exists but no session passphrase */}
        {webLocked && (
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-fluux-bg border border-fluux-border">
            <p className="text-xs text-fluux-text leading-snug flex-1">
              {t('settings.encryption.lockedBannerBody')}
            </p>
            <button
              onClick={() => openWebUnlockDialog()}
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
                pluginStatus === 'generation-failed' || pluginStatus === 'registration-failed'
                  ? 'border-fluux-red/40 bg-fluux-red/5'
                  : 'border-fluux-border bg-fluux-bg'
              }`}
            >
              <div
                className={`text-xs ${
                  pluginStatus === 'generation-failed' || pluginStatus === 'registration-failed'
                    ? 'text-fluux-error'
                    : 'text-fluux-muted'
                }`}
              >
                {pluginStatus === 'waiting-online' &&
                  t('settings.encryption.statusWaitingOnline')}
                {pluginStatus === 'locked' &&
                  t('settings.encryption.statusLocked')}
                {pluginStatus === 'generating' &&
                  t('settings.encryption.statusGenerating')}
                {pluginStatus === 'ready' && t('settings.encryption.statusReady')}
                {pluginStatus === 'generation-failed' &&
                  t('settings.encryption.statusGenerationFailed')}
                {pluginStatus === 'registration-failed' &&
                  (registrationError?.code === 'pep-unsupported'
                    ? t('settings.encryption.statusPepUnsupported')
                    : t('settings.encryption.statusRegistrationFailed', {
                        code: registrationError?.code,
                      }))}
              </div>
              {fingerprint && (
                <div className="flex items-start gap-2">
                  <code className="flex-1 text-xs font-mono text-fluux-text whitespace-pre-line leading-relaxed">
                    {formatFingerprintMultiline(fingerprint)}
                  </code>
                  <button
                    onClick={handleCopyFingerprint}
                    className="p-1.5 text-fluux-muted hover:text-fluux-text rounded hover:bg-fluux-hover transition-colors tap-target"
                    title={t('settings.encryption.copyFingerprint')}
                    aria-label={t('settings.encryption.copyFingerprint')}
                  >
                    {isCopied ? (
                      <Check className="size-3.5 text-fluux-green" />
                    ) : (
                      <Copy className="size-3.5" />
                    )}
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Not-protected-at-rest warning — desktop with no OS keychain, so the
            key's passphrase sits in a cleartext file. Security state, not
            dismissible. */}
        {keychainBacked === false && (
          <div
            role="alert"
            className="flex gap-2 p-3 rounded-lg bg-fluux-red/10 text-xs text-fluux-error leading-snug"
          >
            <AlertTriangle className="size-4 flex-shrink-0 mt-0.5" />
            <p className="flex-1">{t('settings.encryption.notProtectedAtRest')}</p>
          </div>
        )}

        {/* Limitations callout — dismissible */}
        {!limitationsDismissed && (
          <div className="flex gap-2 p-3 rounded-lg bg-fluux-yellow/10 text-xs text-fluux-muted leading-snug">
            <AlertTriangle className="size-4 text-fluux-yellow flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="font-medium text-fluux-text">
                {t('settings.encryption.limitationsTitle')}
              </p>
              <p className="mt-1">{t('settings.encryption.limitationBackend')}</p>
            </div>
            <button
              onClick={handleDismissLimitations}
              aria-label={t('common.close')}
              className="flex-shrink-0 p-0.5 text-fluux-muted hover:text-fluux-text rounded transition-colors tap-target"
            >
              <X className="size-3.5" />
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
                <Info className="size-3.5" />
              </button>
            </div>
            {backupDescVisible && (
              <p className="text-xs text-fluux-muted leading-snug">
                {t('settings.encryption.backupDescription')}
              </p>
            )}
            {(() => {
              // Four visible states:
              //   checking  → pre-probe transient
              //   inSync    → server has a backup AND it matches this
              //               device's current fingerprint (by our local
              //               marker).
              //   outOfSync → backup is missing, or present but for a
              //               different fingerprint.
              //   unknown   → the probe could not reach a definitive answer;
              //               treated as "a backup might exist" since the
              //               dangerous assumption is absence.
              // These four states drive the STATUS LINE only. The backup
              // button renders regardless of sync state: the marker records
              // a fingerprint, not the blob's encoding, so an in-sync backup
              // can still be one no other XEP-0373 client can open (#1021)
              // and the user needs a way to re-publish it. Retry and restore
              // each have their own narrower gate below.
              const checking = backupProbe === 'checking'
              const inSync = isBackupInSync(backupProbe, backedUpFingerprint, fingerprint)
              return (
                <>
                  <p className="text-xs leading-snug">
                    {checking && (
                      <span className="text-fluux-muted">
                        {t('settings.encryption.backupStatusChecking')}
                      </span>
                    )}
                    {!checking && inSync && (
                      <span className="text-fluux-green">
                        {t('settings.encryption.backupStatusInSync')}
                      </span>
                    )}
                    {!checking && !inSync && backupProbe === 'absent' && (
                      <span className="text-fluux-muted">
                        {t('settings.encryption.backupStatusNone')}
                      </span>
                    )}
                    {!checking && !inSync && backupProbe === 'present' && (
                      <span className="text-fluux-yellow">
                        {t('settings.encryption.backupStatusMismatch')}
                      </span>
                    )}
                    {!checking && !inSync && backupProbe === 'unknown' && (
                      <span className="text-fluux-yellow">
                        {t('settings.encryption.backupStatusUnknown')}
                      </span>
                    )}
                  </p>
                  {!checking && (
                    <div className="flex flex-wrap gap-2">
                      {backupProbe === 'unknown' && (
                        <button
                          onClick={() => setBackupProbeNonce((n) => n + 1)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                        >
                          <RefreshCw className="size-3.5" />
                          {t('settings.encryption.backupStatusRetry')}
                        </button>
                      )}
                      <button
                        onClick={handleBackupRequest}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                      >
                        <CloudUpload className="size-3.5" />
                        {t('settings.encryption.backupAction')}
                      </button>
                      {(backupProbe === 'present' || backupProbe === 'unknown') && (
                        <button
                          onClick={() => setShowRestoreDialog(true)}
                          className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                        >
                          <CloudDownload className="size-3.5" />
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
                      <FileDown className="size-3.5" />
                      {t('settings.encryption.exportFileAction')}
                    </button>
                    <button
                      onClick={() => { void handleImportFileRequest() }}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-hover hover:bg-fluux-active text-fluux-text rounded transition-colors"
                    >
                      <FileUp className="size-3.5" />
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
                <Info className="size-3.5" />
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
                className={`size-3.5 ${isRotating ? 'animate-spin' : ''}`}
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
                <ChevronDown className="size-3.5 text-fluux-muted flex-shrink-0" />
              ) : (
                <ChevronRight className="size-3.5 text-fluux-muted flex-shrink-0" />
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
                  className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-fluux-red/10 hover:bg-fluux-red/20 text-fluux-error rounded transition-colors disabled:opacity-50 disabled:cursor-wait"
                >
                  <Trash2 className="size-3.5" />
                  {t('settings.encryption.deleteKey')}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      </SettingsSection>

      {showDeleteConfirm && fingerprint && (
        <DeleteOpenpgpKeyDialog
          fingerprint={fingerprint}
          backupExists={backupProbe === 'present' || backupProbe === 'unknown'}
          onConfirm={handleDeleteKey}
          onCancel={() => {
            if (!isDeleting) setShowDeleteConfirm(false)
          }}
        />
      )}

      {backupConfirmVariant && (
        <ConfirmDialog
          title={t(BACKUP_CONFIRM_KEYS[backupConfirmVariant].title)}
          message={t(BACKUP_CONFIRM_KEYS[backupConfirmVariant].message)}
          confirmLabel={t(BACKUP_CONFIRM_KEYS[backupConfirmVariant].action)}
          variant="danger"
          onConfirm={() => {
            setBackupConfirmVariant(null)
            setShowBackupDialog(true)
          }}
          onCancel={() => setBackupConfirmVariant(null)}
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
            // Must stay in step with the routing predicate in
            // handleRotateConfirm (the `unknown` branch there decides
            // whether we actually re-publish). Under `unknown` this
            // deliberately overstates — "will be re-encrypted" when we only
            // know a backup might exist — because that is the safe
            // direction: the alternative is a passphrase-invalidating
            // re-publish the copy never warned about.
            backupProbe === 'unknown' || isBackupInSync(backupProbe, backedUpFingerprint, fingerprint)
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

      {pendingIdentityChoice && (
        <IdentityChoiceDialog
          reason={pendingIdentityChoice.reason}
          hasServerBackup={pendingIdentityChoice.hasBackup}
          publishedFingerprints={pendingIdentityChoice.publishedFingerprints}
          onRestoreFromServer={handleIdentityChoiceRestore}
          onImportFromFile={handleIdentityChoiceImportFile}
          onReplaceIdentity={handleIdentityChoiceReplace}
          onCancel={handleIdentityChoiceCancel}
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
          // Foreign keys (GnuPG / OpenKeychain) carry an arbitrary passphrase:
          // free-text entry with a reveal toggle, no autofill, trimming. A Fluux
          // backup file (Passphrase-Format: xep0373) gets the masked dashed input.
          mode="import"
          isBackupCode={parseArmorPassphraseFormat(pendingImportFileArmored) === 'xep0373'}
          onConfirm={handleImportFileConfirm}
          onCancel={() => {
            setShowImportFileDialog(false)
            setPendingImportFileArmored(null)
          }}
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
