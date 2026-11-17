import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const sdk = resolve(__dirname, '../fluux-sdk/src')

export default defineConfig({
  resolve: {
    // Resolve the SDK from source, like the app does, so the package tests need no SDK build.
    alias: [
      { find: /^@fluux\/sdk\/xmpp$/, replacement: resolve(sdk, 'xmpp/index.ts') },
      { find: /^@fluux\/sdk$/, replacement: sdk },
    ],
  },
  test: {
    globals: true,
    environment: 'happy-dom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts'],
    exclude: ['src/**/*.manual.test.ts', '**/node_modules/**'],
  },
})
