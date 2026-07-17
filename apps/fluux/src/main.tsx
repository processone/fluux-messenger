import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { XMPPProvider } from '@fluux/sdk'
import { ThemeProvider } from './providers/ThemeProvider'
import { RenderLoopBoundary, RenderLoopWarningBanner } from './components/RenderLoopBoundary'
import App from './App'
import './i18n'
import './index.css'

// Initialize global Tauri file drop listener immediately (before React renders)
import './utils/tauriFileDrop'
import { tauriProxyAdapter } from './utils/tauriProxyAdapter'
import { installBeforeInputGuard } from './utils/tauriInputFix'
import { logStartupCapabilities } from './utils/startupDiagnostics'
import { startStallSentinel } from './utils/stallSentinel'
import { registerServiceWorker } from './utils/serviceWorkerUpdate'
import { sweepExpiredPassphrases } from '@fluux/openpgp-plugin'
import { requestPersistentStorage } from './utils/persistStorage'
import { getReconnectIntent } from './utils/reconnectIntent'
import { captureWebLoginPrefill } from './utils/loginPrefillSources'
import { useLoginPrefillStore } from './stores/loginPrefillStore'

// Check if running in Tauri
const isTauri = '__TAURI_INTERNALS__' in window

// Mark the desktop app on <html> (synchronously, before first paint) so CSS can
// exclude it from the mobile safe-area insets. On macOS the overlay title bar
// (titleBarStyle: "Overlay") makes WebKit report a non-zero
// env(safe-area-inset-top); applied to #root that inset pushes the whole app —
// including the AppBar that hosts the native traffic lights — down off the
// window's top edge, so the fixed-position dots read as too high in the bar.
// Desktop windows have no notch/home-indicator, so dropping the insets there is
// purely correct; the web PWA keeps them.
if (isTauri) document.documentElement.dataset.tauri = 'true'

// Enable native TCP/TLS proxy in Tauri unless explicitly disabled
const disableTcpProxy = localStorage.getItem('fluux:disable-tcp-proxy') === 'true'
const proxyAdapter = isTauri && !disableTcpProxy ? tauriProxyAdapter : undefined

// Register service worker only in browser (not Tauri).
// Tauri uses a custom protocol that doesn't support service workers.
// registerServiceWorker also wires auto-reload-on-update so deployed updates
// land without needing to reinstall an installed PWA (see serviceWorkerUpdate.ts).
if (!isTauri) {
  registerServiceWorker()
  // Purge any cached passphrases past their 24h expiry as early as possible
  // (covers reopen-after-24h and stale cross-account records).
  void sweepExpiredPassphrases()
  // Ask the browser to mark this origin's storage as persistent so the
  // 'fluux-media' runtime cache can't push us over quota and get the whole
  // origin (incl. IndexedDB / OMEMO device identity) evicted. Best-effort.
  void requestPersistentStorage()
}

// Web: capture any login-prefill params from the launch URL (e.g. a shared
// link) and stash them for LoginScreen to seed. Desktop uses the xmpp: deep
// link path instead. Runs once at boot, before React mounts.
if (!isTauri) {
  const webPrefill = captureWebLoginPrefill()
  if (webPrefill) {
    useLoginPrefillStore.getState().setPrefill(webPrefill)
  }
}

// Add 'user-interacted' class to html on first user interaction
// This enables focus rings only after the user has interacted with the app
const enableFocusRings = () => {
  document.documentElement.classList.add('user-interacted')
  // Remove listeners after first interaction
  document.removeEventListener('mousedown', enableFocusRings)
  document.removeEventListener('keydown', enableFocusRings)
}
document.addEventListener('mousedown', enableFocusRings)
document.addEventListener('keydown', enableFocusRings)

// Emergency reload shortcut (Cmd/Ctrl+Alt+Shift+R)
// Works outside React when the app is frozen due to render loops
document.addEventListener('keydown', (e) => {
  // Use e.code for reliable key detection regardless of Shift state
  // Also check e.key with lowercase for fallback compatibility
  const isRKey = e.code === 'KeyR' || e.key?.toLowerCase() === 'r'
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey && isRKey) {
    e.preventDefault()
    console.warn('[Emergency] Force reload triggered')
    window.location.reload()
  }
})

// Block control characters Tauri's macOS webview inserts on arrow-key boundary hits
installBeforeInputGuard()

// Freeze-triage diagnostics (log-only, forwarded to fluux.log in Tauri):
// engine capability line + main-thread stall sentinel.
logStartupCapabilities()
startStallSentinel()

// Auto-recover from dynamic import failures. Two failure modes share the
// same recovery path:
//  - Web: Vite's production build uses content-hashed chunk filenames, so a
//    tab open across a deploy may hold URLs that 404. Reloading picks up
//    fresh hashes.
//  - Tauri: chunks are served through the `tauri://localhost` custom
//    protocol (WKURLSchemeHandler on macOS). After wake-from-sleep or a
//    programmatic webview reload, the scheme handler can be transiently
//    unreachable — reloading straight away just hits the same failure.
//
// Vite dispatches 'vite:preloadError' when a preload link or import()
// fetch fails. The already-rejected import can't be resumed in place, so
// we still reload — but we probe the document URL with bounded backoff
// first, so the reload lands when the runtime is actually healthy again.
// Safeguard: at most one reload per 60s so a persistent failure surfaces
// instead of looping forever.
let preloadReloadPending = false
window.addEventListener('vite:preloadError', async (event) => {
  const KEY = 'fluux:preload-error-reload-at'
  const last = Number(sessionStorage.getItem(KEY) || '0')
  if (Date.now() - last < 60_000) return
  if (preloadReloadPending) return
  preloadReloadPending = true

  event.preventDefault()
  console.warn('[Fluux] Dynamic import failed, probing before reload:', event)

  const PROBE_DELAYS_MS = [150, 400, 800, 1500]
  const probeUrl = new URL(window.location.pathname, window.location.origin).href
  for (const delay of PROBE_DELAYS_MS) {
    await new Promise((r) => setTimeout(r, delay))
    try {
      const res = await fetch(probeUrl, { cache: 'reload' })
      if (res.ok) break
    } catch {
      // keep probing until the delay budget is exhausted
    }
  }

  sessionStorage.setItem(KEY, String(Date.now()))
  window.location.reload()
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RenderLoopBoundary>
      <XMPPProvider
        debug={import.meta.env.DEV}
        proxyAdapter={proxyAdapter}
        shouldAutoReconnect={() => getReconnectIntent() === 'active'}
      >
        <ThemeProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ThemeProvider>
      </XMPPProvider>
      {import.meta.env.DEV && <RenderLoopWarningBanner />}
    </RenderLoopBoundary>
  </React.StrictMode>,
)
