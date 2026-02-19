import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// Get git commit hash at build time
function getGitCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim()
  } catch {
    return 'unknown'
  }
}

// Get version from package.json
function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const gitCommit = getGitCommit()
const appVersion = getVersion()

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Don't auto-inject registration - we'll do it manually to skip in Tauri
      injectRegister: false,
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'logo.png'],
      manifest: {
        name: 'Fluux Messenger',
        short_name: 'Fluux',
        description: 'Modern XMPP chat client - pleasant to use',
        theme_color: '#4a90d9',
        background_color: '#1a1a2e',
        display: 'standalone',
        scope: '/',
        start_url: '/',
        orientation: 'portrait-primary',
        categories: ['communication', 'social'],
        icons: [
          {
            src: 'icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: 'icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: 'icon-192-maskable.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: 'icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        // Activate new SW immediately without waiting for tabs to close
        skipWaiting: true,
        clientsClaim: true,
        // Cache app shell and assets
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        // Don't cache API/WebSocket requests
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': '/src',
      // Alias SDK to source for chunk splitting (allows manualChunks to split core vs react)
      '@fluux/sdk': resolve(__dirname, '../../packages/fluux-sdk/src'),
      // Override @xmpp/client's browser field which excludes SCRAM-SHA-1 from browser builds.
      // The sasl-scram-sha-1 package uses create-hash/create-hmac (browserify-era crypto)
      // which need buffer and stream polyfills. Without this, servers that only offer
      // SCRAM-SHA-1 (no PLAIN) cannot authenticate.
      '@xmpp/sasl-scram-sha-1': resolve(__dirname, '../../node_modules/@xmpp/sasl-scram-sha-1/index.js'),
      // Node.js polyfills needed by SCRAM-SHA-1's crypto dependencies (cipher-base, safe-buffer)
      buffer: 'buffer/',
      stream: 'stream-browserify',
    },
    // Force single instance of @xmpp/xml to fix instanceof checks in iqCallee
    // See: https://github.com/xmppjs/xmpp.js/issues/1108
    dedupe: ['@xmpp/xml', 'ltx'],
  },
  define: {
    global: 'globalThis',
    'process.env': {},
    'process.version': '"v18.0.0"',
    // Inject version info at build time
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
  },
  optimizeDeps: {
    exclude: ['@fluux/sdk'], // Don't pre-bundle local SDK so changes are picked up
  },
  build: {
    rollupOptions: {
      onwarn(warning, warn) {
        // Suppress warnings about Node.js modules being externalized for browser compatibility
        // These come from @xmpp/resolve (DNS for SRV lookups) and SCRAM-SHA-1 crypto deps
        if (warning.message?.includes('externalized for browser compatibility')) {
          return
        }
        warn(warning)
      },
      output: {
        manualChunks(id) {
          // Skip non-node_modules for vendor chunks
          if (!id.includes('node_modules/')) {
            // SDK chunks - only match source files, not node_modules
            // SDK React layer (provider, hooks - depends on React + stores)
            if (
              id.includes('fluux-sdk/src/provider/') ||
              id.includes('fluux-sdk/src/hooks/') ||
              id.includes('fluux-sdk/src/react/')
            ) {
              return 'sdk-react'
            }
            // SDK Core (XMPPClient, modules, stores, types, utils - no React dependency)
            if (id.includes('fluux-sdk/src/')) {
              return 'sdk-core'
            }
            // Let app code go to default chunk
            return
          }

          // Vendor chunks - all from node_modules
          // React core (very stable, good for long-term caching)
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
            return 'vendor-react'
          }
          // Zustand + use-sync-external-store (React state management)
          if (id.includes('node_modules/zustand/') || id.includes('node_modules/use-sync-external-store/')) {
            return 'vendor-zustand'
          }
          // XMPP protocol libraries
          if (id.includes('node_modules/@xmpp/') || id.includes('node_modules/ltx/')) {
            return 'vendor-xmpp'
          }
          // Date formatting
          if (id.includes('node_modules/date-fns/')) {
            return 'vendor-date-fns'
          }
          // Tauri plugins
          if (id.includes('node_modules/@tauri-apps/')) {
            return 'vendor-tauri'
          }
          // i18next core (no React dependency)
          if (id.includes('node_modules/i18next/') || id.includes('node_modules/i18next-browser-languagedetector/')) {
            return 'vendor-i18n'
          }
          // react-i18next (depends on React + i18next)
          if (id.includes('node_modules/react-i18next/')) {
            return 'vendor-react-i18n'
          }
          // XState (state machine library)
          if (id.includes('node_modules/xstate/')) {
            return 'vendor-xstate'
          }
          // Icons
          if (id.includes('node_modules/lucide-react/')) {
            return 'vendor-icons'
          }
          // Other node_modules go to default chunk
        },
      },
    },
  },
})
