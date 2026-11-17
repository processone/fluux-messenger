import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Interop tests are heavy and require docker; opt-in via VITEST_INTEROP=1.
    exclude: process.env.VITEST_INTEROP ? [] : ['**/interop/**', '**/node_modules/**'],
  },
})
