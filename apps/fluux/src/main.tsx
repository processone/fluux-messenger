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
  const isRKey = e.code === 'KeyR' || e.key.toLowerCase() === 'r'
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.shiftKey && isRKey) {
    e.preventDefault()
    console.warn('[Emergency] Force reload triggered')
    window.location.reload()
  }
})

// Block control characters Tauri's macOS webview inserts on arrow-key boundary hits
installBeforeInputGuard()

// Auto-recover from dynamic import failures. Vite's production build uses
// content-hashed chunk filenames, so a tab that was open before a deploy may
// hold stale URLs that now 404 — and a hosted SPA typically rewrites 404s to
// index.html, which Safari rejects as "not a valid JavaScript MIME type".
// React.lazy has no retry logic, so the error bubbles to RenderLoopBoundary.
// Vite dispatches 'vite:preloadError' from its runtime when import() fails;
// reloading the page transparently recovers. Safeguard: at most one reload
// per 60s so a persistent failure surfaces instead of looping forever.
window.addEventListener('vite:preloadError', (event) => {
  const KEY = 'fluux:preload-error-reload-at'
  const last = Number(sessionStorage.getItem(KEY) || '0')
  if (Date.now() - last < 60_000) return
  sessionStorage.setItem(KEY, String(Date.now()))
  event.preventDefault()
  console.warn('[Fluux] Dynamic import failed, reloading to recover:', event)
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
