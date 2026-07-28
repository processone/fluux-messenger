import { defineConfig } from 'vitest/config'

/**
 * The persistence cost benchmark (issue #1138).
 *
 * Kept out of the default suite: it is a measurement, not an assertion, and it
 * takes far longer than a unit test. Run it with `npm run bench:persist`.
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['bench/**/*.bench.ts'],
    // No `silent` — the report goes to stdout.
    testTimeout: 120_000,
    // Sequential: the stores and the throttle are module-level singletons, and
    // a second worker's CPU contention would show up in `cpuMs`.
    fileParallelism: false,
    pool: 'forks',
    maxForks: 1,
    minForks: 1,
  },
})
