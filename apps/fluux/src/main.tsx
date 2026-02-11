import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { XMPPProvider } from '@fluux/sdk'
import { ThemeProvider } from './providers/ThemeProvider'
import { RenderLoopBoundary } from './components/RenderLoopBoundary'
import App from './App'
import './i18n'
import './index.css'

// Initialize global Tauri file drop listener immediately (before React renders)
import './utils/tauriFileDrop'
import { tauriProxyAdapter } from './utils/tauriProxyAdapter'

// Check if running in Tauri
const isTauri = '__TAURI_INTERNALS__' in window

// Enable native TCP/TLS proxy in Tauri unless explicitly disabled
const disableTcpProxy = localStorage.getItem('fluux:disable-tcp-proxy') === 'true'
const proxyAdapter = isTauri && !disableTcpProxy ? tauriProxyAdapter : undefined

// Register service worker only in browser (not Tauri)
// Tauri uses a custom protocol that doesn't support service workers
if (!isTauri && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RenderLoopBoundary>
      <XMPPProvider debug={import.meta.env.DEV} proxyAdapter={proxyAdapter}>
        <ThemeProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ThemeProvider>
      </XMPPProvider>
    </RenderLoopBoundary>
  </React.StrictMode>,
)
