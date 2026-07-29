import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { resolveAnomalyGate } from './src/anomaly/gate'

export default defineConfig({
  plugins: [react()],
  define: {
    // Same resolver as vite.config.ts, so the gate matrix has one definition.
    // Tests run as 'development', so the instrumentation is on unless a run
    // explicitly sets FLUUX_ANOMALY=0.
    __FLUUX_ANOMALY__: JSON.stringify(resolveAnomalyGate('development', process.env)),
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@fluux/sdk': resolve(__dirname, '../../packages/fluux-sdk/src'),
    },
  },
  test: {
    globals: true,
    // Default DOM environment. happy-dom is ~2x faster to construct than jsdom; tests that
    // need jsdom-specific behavior opt back in per-file with `// @vitest-environment jsdom`.
    environment: 'happy-dom',
    silent: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['src/**/*.manual.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    },
  },
})
