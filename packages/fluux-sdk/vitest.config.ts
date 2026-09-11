import { defineConfig } from 'vitest/config'
import { availableParallelism } from 'node:os'

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    silent: true,
    // Leave CPU and memory headroom for crypto tests and concurrent development builds.
    maxWorkers: Math.min(2, Math.max(1, availableParallelism() - 1)),
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'examples/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'src/index.ts'],
    },
  },
})
