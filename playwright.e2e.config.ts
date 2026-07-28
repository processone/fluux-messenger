import { defineConfig, devices } from '@playwright/test'

/**
 * The suites run against a BUILT demo served by `vite preview`, not the dev server.
 *
 * The dev server ships the app as ~3600 separate ES modules, and WebKitGTK re-parses that
 * graph in every fresh browser context — once per test. On a 2-core CI runner the first
 * webkit test blew its 120s mount budget doing it, failing its first attempt in ~15 of 16
 * observed green runs while `retries: 2` quietly relabelled it "flaky".
 *
 * `npm run build:e2e` keeps development semantics (`import.meta.env.DEV` stays true, so the
 * harness seams survive) and asserts those seams are present before the suites start.
 *
 * Set FLUUX_E2E_DEV_SERVER=1 to run against the dev server instead — useful when you are
 * editing components and want HMR while debugging a single test. The default is the build,
 * so a local run and a CI run exercise the same artefact.
 */
const useDevServer = process.env.FLUUX_E2E_DEV_SERVER === '1'
const BASE_URL = useDevServer ? 'http://localhost:5173' : 'http://localhost:4173'

/**
 * The browser-level invariant gates: scroll positioning and composer geometry.
 *
 * Both suites were previously separate configs, each spawning its own `npm run dev`.
 * That paid vite's cold transform of the demo bundle twice per CI job and left the two
 * runs unable to share workers — the composer suite sat idle while scroll finished, and
 * vice versa. One config, four projects, one dev server.
 *
 * Each suite is still runnable and diagnosable on its own, which is why the projects are
 * named per suite rather than per engine:
 *
 *   npm run test:scroll                        # both engines, scroll only
 *   npm run test:composer                      # both engines, composer only
 *   npm run test:e2e                           # everything (what CI runs)
 *   npx playwright test --config playwright.e2e.config.ts --project=scroll-webkit
 *
 * WebKit matters specifically: it reserves scrollbar gutters differently from Blink and
 * resolves row heights on a coarser cadence, and it is the engine the desktop app runs.
 */

const SUITES = [
  { name: 'scroll', testMatch: 'scroll-invariants.ts' },
  { name: 'composer', testMatch: 'composer-geometry.ts' },
] as const

const ENGINES = [
  { name: 'chromium', use: devices['Desktop Chrome'] },
  { name: 'webkit', use: devices['Desktop Safari'] },
] as const

export default defineConfig({
  testDir: './scripts',

  // No globalSetup warm-up, and no more load-time optimisation aimed at the first-attempt
  // webkit stall. Two attempts were made and both failed: a warm-up that loaded the demo
  // once before the projects started (cost 33-37s, changed nothing across three runs), and
  // serving a bundle instead of the dev server's module graph (kept, for its per-test and
  // variance gains, but it does not fix the stall either).
  //
  // Both assumed a loading cost. Instrumenting the boot showed why neither could work: a
  // healthy boot on the same runner is ~1s in chromium and ~3.5s in webkit, against a 120s
  // ceiling. The failure is a ~30x cliff, so something stalls — it is not slow loading.
  // scripts/e2e/demoBoot.ts now attributes that stall to a stage instead of guessing.

  // Per-test budget. Generous because WebKit on a busy CI runner can take 45s+ just to
  // boot the demo bundle before the test body starts. Ceiling only: warm runs finish in
  // ~3s, and the measurements themselves are sub-second.
  timeout: 180_000,

  // Tests within a file share a worker and run in declaration order. With four projects
  // the two workers stay fed across both suites instead of draining one then the other.
  fullyParallel: false,

  // CI: retry twice to absorb timing noise on slower runners (the suites gate on async
  // measurement settling). Locally: no retries, so flakes surface immediately.
  retries: process.env.CI ? 2 : 0,

  // Fail the run if a stray `.only` is committed — a blocking gate must run every test.
  forbidOnly: !!process.env.CI,

  // CI: GitHub annotations on failures + a self-contained HTML report (with traces)
  // uploaded as an artifact. Locally: a readable list.
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 800 },
    // NOT 'on-first-retry'. That records the trace *during* the retry — which passes — so
    // the failing first attempt was never captured, and every trace uploaded from CI so far
    // has shown a healthy run. 'retain-on-failure' traces each attempt and discards the
    // passing ones, which is the only setting that catches an intermittent first-attempt
    // failure. It costs some per-test recording overhead; that is worth paying while the
    // first-attempt webkit stall is open, and worth revisiting once it is closed.
    trace: 'retain-on-failure',
  },

  projects: SUITES.flatMap(suite =>
    ENGINES.map(engine => ({
      name: `${suite.name}-${engine.name}`,
      testMatch: suite.testMatch,
      use: { ...engine.use },
    })),
  ),

  webServer: {
    // build:e2e builds the SDK too, so this is the only build the e2e job needs.
    command: useDevServer ? 'npm run dev' : 'npm run build:e2e && npm run preview:e2e',
    url: BASE_URL,
    // CI always starts a fresh server; locally reuse a running one if present.
    reuseExistingServer: !process.env.CI,
    // The build runs inside this budget (~10s locally, more on a cold CI runner), so it
    // is roomier than the dev server's would need to be.
    timeout: useDevServer ? 120_000 : 240_000,
  },
})
