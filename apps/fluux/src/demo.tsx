/**
 * Demo entry point — renders the full Fluux UI with realistic fake data.
 *
 * Access via /demo.html in the dev server or production build.
 * No XMPP server required.
 */

import React from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { XMPPProvider, DemoClient } from '@fluux/sdk'
import { ThemeProvider } from './providers/ThemeProvider'
import { RenderLoopBoundary } from './components/RenderLoopBoundary'
import App from './App'
import './i18n'
import './index.css'

// Clear all persisted state to prevent stale data from real/previous sessions.
// Demo uses its own transient state — we don't want leftover data from the
// real app or from a previous demo reload.
const DEMO_STORAGE_PREFIXES = ['fluux:', 'fluux-', 'xmpp-']
for (const key of Object.keys(localStorage)) {
  if (DEMO_STORAGE_PREFIXES.some(prefix => key.startsWith(prefix))) {
    localStorage.removeItem(key)
  }
}
// Clear IndexedDB caches (async, best-effort)
indexedDB.deleteDatabase('fluux-message-cache')
indexedDB.deleteDatabase('fluux-avatar-cache')

// Create demo client and populate stores synchronously before first render
const demoClient = new DemoClient()
demoClient.populateDemo()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RenderLoopBoundary>
      <XMPPProvider client={demoClient}>
        <ThemeProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ThemeProvider>
      </XMPPProvider>
    </RenderLoopBoundary>
  </React.StrictMode>,
)

// Start live animations after React has mounted
setTimeout(() => {
  demoClient.startAnimation()
}, 100)
