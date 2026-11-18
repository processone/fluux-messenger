import { defineConfig, devices } from '@playwright/test'
import { requireLockedInstall } from './harness/installGuard'

// Before anything runs: see e2e/harness/installGuard.ts.
requireLockedInstall()

// Live proof of one-to-one forwarding against a disposable local XMPP server (see e2e/forward-direct.live.ts).
// Nothing here starts a server or an app: set FLUUX_LIVE_APP and FLUUX_LIVE_ACCOUNTS first.
export default defineConfig({
  testDir: '.',
  testMatch: 'forward-direct.live.ts',
  timeout: 600_000,
  workers: 1,
  retries: 0,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: { actionTimeout: 15_000, ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 }, baseURL: process.env.FLUUX_LIVE_APP },
})
