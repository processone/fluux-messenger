import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'child_process'
import { readFileSync, rmSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'
import { resolveAnomalyGate } from './src/anomaly/gate'
import { anomalyBuildAudit } from './scripts/anomalyBuildAudit'

// Resolve packages via Node's module resolution (walks up parent dirs) instead of
// a hardcoded ../../node_modules path. The latter assumes apps/fluux sits directly
// under the repo root and breaks in git worktrees (apps/fluux lives under
// .claude/worktrees/<name>/), where ../../node_modules does not exist.
const localRequire = createRequire(resolve(__dirname, 'package.json'))

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

/**
 * `npm run build:e2e` sets this. It produces a BUNDLED demo that keeps development
 * semantics — `import.meta.env.DEV` stays true, so the harness seams the Playwright
 * suites depend on (`__fluuxGetVirtOffset`, `__fluuxTriggerLoadOlder`,
 * `__fluuxScrollShadow`) are still installed. The dev server serves the same app as
 * hundreds of separate ES modules, which WebKitGTK re-parses in every fresh browser
 * context; a bundle is one request's worth of work instead.
 *
 * An env var rather than `--mode`, because reading the mode means wrapping the whole
 * config in a function and reindenting 150 lines of unrelated code.
 */
const isE2EBuild = process.env.FLUUX_E2E_BUILD === '1'

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [
    react(),
    babel({
      plugins: [['babel-plugin-react-compiler', {}]],
    }),
    // Remove demo assets (public/demo/, demo.html) from production builds. The e2e
    // build exists precisely to serve the demo, so it opts out.
    {
      name: 'strip-demo',
      apply: 'build',
      closeBundle() {
        if (isE2EBuild) return
        const dist = resolve(__dirname, 'dist')
        rmSync(resolve(dist, 'demo'), { recursive: true, force: true })
        rmSync(resolve(dist, 'demo.html'), { force: true })
      },
    },
    VitePWA({
      registerType: 'autoUpdate',
      // Don't auto-inject registration - we'll do it manually to skip in Tauri
      injectRegister: false,
      // Use injectManifest strategy for custom service worker with push notification support
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'logo.png'],
      manifest: {
        name: 'Fluux Messenger',
        short_name: 'Fluux',
        description: 'Modern XMPP chat client, pleasant to use',
        theme_color: '#1a1b1e',
        background_color: '#1a1b1e',
        display: 'standalone',
        scope: './',
        start_url: './',
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
      injectManifest: {
        // Cache app shell and assets — exclude demo files from SW precache
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2}'],
        globIgnores: ['demo/**', 'demo.html'],
      },
    }),
    // Asserts the anomaly tree is present exactly where the gate says it should be.
    anomalyBuildAudit(resolveAnomalyGate(mode, process.env)),
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
      '@xmpp/sasl-scram-sha-1': localRequire.resolve('@xmpp/sasl-scram-sha-1'),
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
    'process.env': '{}',
    'process.version': '"v18.0.0"',
    // Shim process properties needed by SCRAM-SHA-1 crypto deps (stream-browserify, safe-buffer).
    // process.nextTick is shimmed via global injection in index.html since define only supports literals.
    'process.browser': 'true',
    'process.stdout': 'null',
    'process.stderr': 'null',
    // Inject version info at build time
    __APP_VERSION__: JSON.stringify(appVersion),
    __GIT_COMMIT__: JSON.stringify(gitCommit),
    // Anomaly instrumentation gate. A build-time literal, so the guarded tree is
    // dead-code eliminated in release. See src/anomaly/gate.ts for the matrix.
    __FLUUX_ANOMALY__: JSON.stringify(resolveAnomalyGate(mode, process.env)),
  },
  optimizeDeps: {
    exclude: ['@fluux/sdk'], // Don't pre-bundle local SDK so changes are picked up
  },
  build: {
    modulePreload: false,
    rolldownOptions: {
      input: isE2EBuild
        ? {
            main: resolve(__dirname, 'index.html'),
            demo: resolve(__dirname, 'demo.html'),
          }
        : {
            main: resolve(__dirname, 'index.html'),
          },
      onwarn(warning, warn) {
        // Suppress warnings about Node.js modules being externalized for browser compatibility
        // These come from @xmpp/resolve (DNS for SRV lookups) and SCRAM-SHA-1 crypto deps
        if (warning.message?.includes('externalized for browser compatibility')) {
          return
        }
        warn(warning)
      },
      output: {
        codeSplitting: {
          groups: [
            // SDK chunks (source paths only, not node_modules)
            // SDK Core first (higher priority) so react layer doesn't pull in core deps
            { name: 'sdk-core', test: /fluux-sdk\/src\/(core|stores|types|utils|bindings)\//, priority: 20 },
            // SDK React layer (provider, hooks - depends on React + stores)
            { name: 'sdk-react', test: /fluux-sdk\/src\/(provider|hooks|react)\//, priority: 15 },
            // Vendor chunks - all from node_modules
            // React core (very stable, good for long-term caching)
            { name: 'vendor-react', test: /node_modules\/(react|react-dom)\//, priority: 20 },
            // Zustand + use-sync-external-store (React state management)
            { name: 'vendor-zustand', test: /node_modules\/(zustand|use-sync-external-store)\//, priority: 18 },
            // XMPP protocol libraries
            { name: 'vendor-xmpp', test: /node_modules\/(@xmpp|ltx)\//, priority: 18 },
            // Date formatting
            { name: 'vendor-date-fns', test: /node_modules\/date-fns\//, priority: 18 },
            // Tauri plugins
            { name: 'vendor-tauri', test: /node_modules\/@tauri-apps\//, priority: 18 },
            // i18next core (no React dependency)
            { name: 'vendor-i18n', test: /node_modules\/(i18next|i18next-browser-languagedetector)\//, priority: 16 },
            // react-i18next (depends on React + i18next)
            { name: 'vendor-react-i18n', test: /node_modules\/react-i18next\//, priority: 16 },
            // XState (state machine library)
            { name: 'vendor-xstate', test: /node_modules\/xstate\//, priority: 16 },
            // Icons
            { name: 'vendor-icons', test: /node_modules\/lucide-react\//, priority: 16 },
            // Builtin themes (CSS variable definitions)
            { name: 'themes', test: /themes\/builtins\//, priority: 10 },
          ],
        },
      },
    },
  },
}))
