import { useState, useEffect, useCallback } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useConnectionStatus, useXMPPContext, hasFastToken } from '@fluux/sdk'
import { registerE2EEPlugins } from './e2ee/registerPlugins'
import { isKeyLocked } from './e2ee/webPassphraseStore'
import { probeRemoteIdentityState } from './e2ee/secretKeyProbe'
import { isOpenpgpEnabled } from './stores/encryptionSettingsStore'
import { useToastStore } from './stores/toastStore'
import { UnlockEncryptionDialog } from './components/UnlockEncryptionDialog'
import { IdentityChoiceDialog } from './components/IdentityChoiceDialog'
import { RestorePassphraseDialog } from './components/RestorePassphraseDialog'
import { useWebUnlockDialogStore } from './stores/webUnlockDialogStore'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { LoginScreen } from './components/LoginScreen'
import { ChatLayout } from './components/ChatLayout'
import { TabBlockedScreen } from './components/TabBlockedScreen'
import { UpdateModal } from './components/UpdateModal'
import { useSessionPersistence, getSession } from './hooks/useSessionPersistence'
import { useTabCoordination } from './hooks/useTabCoordination'
import { useFullscreen } from './hooks/useFullscreen'
import { useTauriCloseHandler } from './hooks/useTauriCloseHandler'
import { useTauriTrayRestore } from './hooks/useTauriTrayRestore'
import { useAutoUpdate } from './hooks'
import { useIgnoreSync } from './hooks/useIgnoreSync'
import { useExternalLinkHandler } from './hooks/useExternalLinkHandler'
import { usePlatformState } from './hooks/usePlatformState'
import { useAccountScopeRehydration } from './hooks/useAccountScopeRehydration'
import { clearLocalData } from './utils/clearLocalData'

// Tauri detection
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

// macOS detection (for title bar overlay - only applies on macOS)
const isMacOS = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

// Fixed title bar height for macOS traffic lights (only used in Tauri on macOS)
const TITLEBAR_HEIGHT = 28

function TitleBar() {
  const isFullscreen = useFullscreen()

  // Only render on macOS in Tauri (for traffic light spacing)
  // Windows and Linux use native title bars
  if (!isTauri || !isMacOS || isFullscreen) return null

  return (
    <div
      data-tauri-drag-region
      className="fixed top-0 inset-x-0 bg-transparent"
      style={{ height: TITLEBAR_HEIGHT, zIndex: 9999 }}
    />
  )
}

function App() {
  // Detect render loops before they freeze the UI
  detectRenderLoop('App')

  const { status, jid } = useConnectionStatus()
  const { client } = useXMPPContext()
  const { t } = useTranslation()
  const addToast = useToastStore((s) => s.addToast)
  const tabCoordination = useTabCoordination(() => {
    // When another tab takes over, disconnect this client
    void client.disconnect()
  })
  useTauriCloseHandler()
  useTauriTrayRestore()
  useIgnoreSync()
  useExternalLinkHandler()
  // Must stay mounted even during the full-screen auto-reconnect spinner:
  // native keepalive / wake listeners are what unstick reconnect after long sleep.
  usePlatformState()
  useAccountScopeRehydration()
  const update = useAutoUpdate({ autoCheck: true })

  // Listen for --clear-storage CLI flag (Tauri only)
  // This clears all local data on startup when the flag is passed
  useEffect(() => {
    if (!isTauri) return

    let disposed = false
    let unlisten: (() => void) | null = null

    const onClearStorageRequested = () => {
      void (async () => {
        console.log('[CLI] Clearing local storage due to --clear-storage flag')
        try {
          await client.disconnect()
        } catch {
          // Ignore disconnect errors during forced cleanup
        }
        await clearLocalData({ allAccounts: true })
        window.location.reload()
      })()
    }

    const setupListener = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        const stop = await listen('clear-storage-requested', onClearStorageRequested)

        // Component unmounted before async listener setup completed.
        if (disposed) {
          stop()
        } else {
          unlisten = stop
        }
      } catch (err) {
        console.error('[CLI] Failed to register clear-storage listener:', err)
      }
    }

    void setupListener()

    return () => {
      disposed = true
      unlisten?.()
      unlisten = null
    }
  }, [client])

  // Track if we've shown the update modal this session (don't show again after dismiss)
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const [updateDismissed, setUpdateDismissed] = useState(false)

  // Show update modal when update is first detected (only once per session)
  useEffect(() => {
    if (update.available && !updateDismissed && !showUpdateModal) {
      setShowUpdateModal(true)
    }
  }, [update.available, updateDismissed, showUpdateModal])

  const handleUpdateDismiss = () => {
    setShowUpdateModal(false)
    setUpdateDismissed(true)
    update.dismissUpdate()
  }

  // Track if we're attempting auto-reconnect from saved session on page load
  // This prevents flashing LoginScreen on page reload
  const [isAutoReconnecting, setIsAutoReconnecting] = useState(() => {
    // Check synchronously on first render if we have a saved session
    if (getSession() !== null) return true
    // FAST token can auto-connect without password when "Remember Me" was checked
    const rememberMe = localStorage.getItem('xmpp-remember-me') === 'true'
    const savedJid = localStorage.getItem('xmpp-last-jid')
    const savedServer = localStorage.getItem('xmpp-last-server')
    // Fallback: derive server from JID domain when savedServer is empty
    // (backward compat with older sessions that stored '' for the server field)
    const effectiveServer = savedServer || (savedJid ? savedJid.split('@')[1] : null)
    return !!(rememberMe && savedJid && effectiveServer && hasFastToken(savedJid))
  })

  // Track if we've ever been online this session
  // Used to distinguish initial page load reconnect from wake-from-sleep reconnect
  const [hasBeenOnline, setHasBeenOnline] = useState(false)

  const showWebUnlockDialog = useWebUnlockDialogStore((s) => s.isOpen)
  const openWebUnlockDialog = useWebUnlockDialogStore((s) => s.openWebUnlockDialog)
  const closeWebUnlockDialog = useWebUnlockDialogStore((s) => s.closeWebUnlockDialog)
  // Set when auto-init detects a server-side OpenPGP identity for this
  // account but no local key. Forces the user through IdentityChoiceDialog
  // instead of the standard unlock dialog (which would otherwise reach
  // ensureKeyMaterial, hit the crypto guard, and surface an opaque error).
  // Keeping this state lifted here matches the existing pattern for
  // showWebUnlockDialog: App is the single owner of the connect-time
  // E2EE bootstrap flow.
  const [pendingIdentityChoice, setPendingIdentityChoice] = useState<{
    accountJid: string
    hasBackup: boolean
    publishedFingerprints: string[]
  } | null>(null)
  // Holds the armored file content while the user types the file
  // passphrase. Decoupled from `pendingIdentityChoice` so the choice
  // dialog can dismiss as soon as the file is picked.
  const [pendingImportFile, setPendingImportFile] = useState<string | null>(null)

  // Auto-reconnect on page reload if session exists
  useSessionPersistence(tabCoordination.claimConnection)

  // Track when we first come online, and clear auto-reconnecting flag
  useEffect(() => {
    if (status === 'online') {
      setIsAutoReconnecting(false)
      setHasBeenOnline(true)
      // Mark that we've been online this session. LoginScreen reads this flag
      // to detect post-disconnect transitions and trigger a webview reload
      // (workaround for WRY losing native event delivery on macOS).
      // Uses '__wry_' prefix so clearLocalData() won't remove it (it only
      // clears 'fluux:' prefixed keys).
      sessionStorage.setItem('__wry_was_online', '1')
      // Register E2EE plugins now that the account JID is available.
      // Fire-and-forget: a failure must not block the chat path.
      // On web, after registration the key may be in locked state — show the
      // unlock dialog so the user can supply the session passphrase.
      void registerE2EEPlugins(client).then(async () => {
        if (isTauri || !isOpenpgpEnabled()) return
        // Web auto-init: if the server already advertises an OpenPGP
        // identity but the local IndexedDB has no key (cleared cookies,
        // new browser profile, fresh install of Fluux web on the same
        // account), route the user to IdentityChoiceDialog up-front
        // instead of through the unlock dialog. The crypto guard would
        // refuse silent generation either way, but a clean dialog is
        // friendlier than a generic unlock failure.
        const accountJid = jid ? jid.split('/')[0] : null
        const plugin = client.e2ee?.getPlugin('openpgp') as
          | { hasNoLocalKey?: () => Promise<boolean> }
          | null
          | undefined
        if (accountJid && plugin?.hasNoLocalKey) {
          try {
            const hasNoLocal = await plugin.hasNoLocalKey()
            if (hasNoLocal) {
              const state = await probeRemoteIdentityState(client, accountJid)
              if (state.hasServerIdentity) {
                setPendingIdentityChoice({
                  accountJid,
                  hasBackup: state.backupMessage !== null,
                  publishedFingerprints: state.publishedFingerprints,
                })
                return
              }
            }
          } catch {
            // Probe failure (transient network, server down): fall
            // through to the unlock dialog. The crypto guard remains
            // effective; the worst case is a confused error message
            // until the user re-toggles via Settings.
          }
        }
        if (isKeyLocked()) {
          openWebUnlockDialog()
        }
      })
    } else if (status !== 'connecting') {
      // For any non-online, non-connecting status (error, disconnected, reconnecting),
      // check if session was cleared — if so, stop showing the reconnecting spinner
      const hasSession = getSession() !== null
      if (!hasSession) {
        setIsAutoReconnecting(false)
      }
    }
  }, [status, client, jid, openWebUnlockDialog])

  // --- Identity-choice handlers (web first-login safety net) ---
  // Each resolves `pendingIdentityChoice` with one explicit recovery
  // path. Failures stay inside the dialog (the dialog's try/catch
  // surfaces the error to the user); success closes the dialog and
  // emits a toast. Toast strings reuse settings.encryption.restoreSuccess
  // — the user-visible outcome is identical regardless of which path
  // ran (the account is now usable for E2EE).

  const handleIdentityRestoreFromServer = useCallback(
    async (passphrase: string) => {
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            restoreSecretKey?: (pp: string) => Promise<unknown>
          }
        | null
        | undefined
      if (!plugin?.restoreSecretKey) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      await plugin.restoreSecretKey(passphrase)
      setPendingIdentityChoice(null)
      client.notifyE2EEKeyUnlocked?.()
      addToast('success', t('settings.encryption.restoreSuccess'))
    },
    [client, t, addToast],
  )

  const handleIdentityImportFromFile = useCallback(async () => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { pickKeyFile?: () => Promise<string | null> }
      | null
      | undefined
    if (!plugin?.pickKeyFile) return
    const content = await plugin.pickKeyFile()
    if (!content) return
    // Close the choice dialog and hand off to the passphrase dialog.
    setPendingIdentityChoice(null)
    setPendingImportFile(content)
  }, [client])

  const handleImportFilePassphrase = useCallback(
    async (passphrase: string) => {
      if (!pendingImportFile) return
      const plugin = client.e2ee?.getPlugin('openpgp') as
        | {
            importKeyFromFile?: (armored: string, pp: string) => Promise<unknown>
          }
        | null
        | undefined
      if (!plugin?.importKeyFromFile) {
        throw new Error(t('settings.encryption.backupPluginUnavailable'))
      }
      await plugin.importKeyFromFile(pendingImportFile, passphrase)
      setPendingImportFile(null)
      client.notifyE2EEKeyUnlocked?.()
      addToast('success', t('settings.encryption.restoreSuccess'))
    },
    [client, pendingImportFile, t, addToast],
  )

  const handleIdentityReplaceIdentity = useCallback(async () => {
    const plugin = client.e2ee?.getPlugin('openpgp') as
      | { retireAndGenerateIdentity?: () => Promise<unknown> }
      | null
      | undefined
    if (!plugin?.retireAndGenerateIdentity) {
      throw new Error(t('settings.encryption.backupPluginUnavailable'))
    }
    await plugin.retireAndGenerateIdentity()
    setPendingIdentityChoice(null)
    client.notifyE2EEKeyUnlocked?.()
    addToast('success', t('settings.encryption.restoreSuccess'))
  }, [client, t, addToast])

  // Check if we have a stored session (for reconnect scenarios)
  const hasSession = getSession() !== null

  // Show loading state during initial auto-reconnect attempt (prevents login flash on reload)
  // Only show for initial page load reconnect, NOT for wake-from-sleep reconnect.
  // Once we've been online, stay in ChatLayout and show inline reconnect indicator.
  // Uses status !== 'online' to cover all intermediate states (reconnecting, error, etc.)
  if (isAutoReconnecting && !hasBeenOnline && status !== 'online') {
    return (
      <>
        <TitleBar />
        <div className="flex h-screen items-center justify-center bg-fluux-bg">
          <div className="text-center">
            <div className="animate-spin rounded-full size-8 border-b-2 border-fluux-brand mx-auto mb-4" />
            <p className="text-fluux-muted">Reconnecting...</p>
          </div>
        </div>
      </>
    )
  }

  // Show tab coordination screen when blocked or taken over (web only)
  if (!isTauri && (tabCoordination.blocked || tabCoordination.takenOver)) {
    return (
      <>
        <TitleBar />
        <TabBlockedScreen
          takenOver={tabCoordination.takenOver}
          onTakeOver={tabCoordination.takeOver}
        />
      </>
    )
  }

  // Show login when not online and no stored session exists.
  // When a session exists (e.g., during SDK reconnection after sleep), stay on ChatLayout
  // where the inline reconnect indicator shows. Uses status !== 'online' to cover all
  // non-connected states (disconnected, connecting, reconnecting, error).
  if (status !== 'online' && !hasSession) {
    return (
      <>
        <TitleBar />
        <LoginScreen claimConnection={tabCoordination.claimConnection} />
      </>
    )
  }

  // Show main chat interface when online or reconnecting
  // Routes are defined but ChatLayout still handles view logic internally (Phase 1)
  // Phase 2 will migrate view selection to route-based rendering
  return (
    <>
      <TitleBar />
      <Routes>
        {/* Phase 1: All routes render ChatLayout, which handles view internally */}
        {/* Phase 2 will move view selection logic to route components */}
        <Route path="/messages/:jid?" element={<ChatLayout />} />
        <Route path="/rooms/:jid?" element={<ChatLayout />} />
        <Route path="/contacts/:jid?" element={<ChatLayout />} />
        <Route path="/archive/:jid?" element={<ChatLayout />} />
        <Route path="/events" element={<ChatLayout />} />
        <Route path="/search" element={<ChatLayout />} />
        <Route path="/admin/*" element={<ChatLayout />} />
        <Route path="/settings/:category?" element={<ChatLayout />} />
        {/* Default redirect to messages */}
        <Route path="/" element={<Navigate to="/messages" replace />} />
        {/* Catch-all for unknown routes */}
        <Route path="*" element={<Navigate to="/messages" replace />} />
      </Routes>
      {/* Update modal - shown on app launch when update is available */}
      {/* Disabled on Linux - users update through their distro package manager */}
      {showUpdateModal && update.available && update.updaterEnabled && (
        <UpdateModal
          state={update}
          onDownload={update.downloadAndInstall}
          onRelaunch={update.relaunchApp}
          onDismiss={handleUpdateDismiss}
        />
      )}
      {showWebUnlockDialog && (
        <UnlockEncryptionDialog
          client={client}
          onClose={() => closeWebUnlockDialog()}
        />
      )}
      {pendingIdentityChoice && (
        <IdentityChoiceDialog
          hasServerBackup={pendingIdentityChoice.hasBackup}
          publishedFingerprints={pendingIdentityChoice.publishedFingerprints}
          onRestoreFromServer={handleIdentityRestoreFromServer}
          onImportFromFile={handleIdentityImportFromFile}
          onReplaceIdentity={handleIdentityReplaceIdentity}
          onCancel={() => setPendingIdentityChoice(null)}
        />
      )}
      {pendingImportFile && (
        <RestorePassphraseDialog
          title={t('settings.encryption.importFileDialogTitle')}
          body={t('settings.encryption.importFileDialogBody')}
          confirmLabel={t('settings.encryption.importFileAction')}
          onConfirm={handleImportFilePassphrase}
          onCancel={() => setPendingImportFile(null)}
        />
      )}
    </>
  )
}

export default App
