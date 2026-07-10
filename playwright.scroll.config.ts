import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './scripts',
  testMatch: 'scroll-invariants.ts',
  // Per-test budget. Generous because WebKit on a busy CI runner can take 45s+ just to boot the
  // demo bundle + run the stress seeding before the test body starts; 60s left no margin and the
  // slow-boot case failed the mount wait outright instead of proceeding.
  timeout: 120_000,
  fullyParallel: false,
  // CI: retry twice to absorb timing noise on slower runners (the suite gates on async
  // measurement settling). Locally: no retries, so flakes surface immediately.
  retries: process.env.CI ? 2 : 0,
  // Fail the run if a stray `.only` is committed — a blocking gate must run every test.
  forbidOnly: !!process.env.CI,
  // CI: GitHub annotations on failures + a self-contained HTML report (with traces)
  // uploaded as an artifact. Locally: a readable list.
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 800 },
    // Capture a trace on the first retry so CI failures are debuggable.
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    // CI always starts a fresh server; locally reuse a running dev server if present.
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
