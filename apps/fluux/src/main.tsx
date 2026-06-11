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

// Check if running in Tauri
const isTauri = '__TAURI_INTERNALS__' in window

// Enable native TCP/TLS proxy in Tauri unless explicitly disabled
const disableTcpProxy = localStorage.getItem('fluux:disable-tcp-proxy') === 'true'
const proxyAdapter = isTauri && !disableTcpProxy ? tauriProxyAdapter : undefined

// Register service worker only in browser (not Tauri)
// Tauri uses a custom protocol that doesn't support service workers
if (!isTauri && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // Service worker registration failed - ignore silently
      // This can happen in development or unsupported environments
    })
  })
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
      <XMPPProvider debug={import.meta.env.DEV} proxyAdapter={proxyAdapter}>
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
