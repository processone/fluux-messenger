import { useState, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useConnection, useXMPPContext, hasFastToken } from '@fluux/sdk'
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

  const { status } = useConnection()
  const { client } = useXMPPContext()
  const tabCoordination = useTabCoordination(() => {
    // When another tab takes over, disconnect this client
    void client.disconnect()
  })
  useTauriCloseHandler()
  useTauriTrayRestore()
  useIgnoreSync()
  useExternalLinkHandler()
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
    return !!(rememberMe && savedJid && savedServer && hasFastToken(savedJid))
  })

  // Track if we've ever been online this session
  // Used to distinguish initial page load reconnect from wake-from-sleep reconnect
  const [hasBeenOnline, setHasBeenOnline] = useState(false)

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
    } else if (status !== 'connecting') {
      // For any non-online, non-connecting status (error, disconnected, reconnecting),
      // check if session was cleared — if so, stop showing the reconnecting spinner
      const hasSession = getSession() !== null
      if (!hasSession) {
        setIsAutoReconnecting(false)
      }
    }
  }, [status])

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
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-fluux-brand mx-auto mb-4" />
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
    </>
  )
}

export default App
