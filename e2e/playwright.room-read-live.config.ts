import { defineConfig, devices } from '@playwright/test'
import { requireLockedInstall } from './harness/installGuard'

requireLockedInstall()

// Disposable loopback server only. This never uses the signed-in app profile.
export default defineConfig({
  testDir: '.',
  testMatch: 'room-read-markers.live.ts',
  timeout: 300_000,
  workers: 1,
  retries: 0,
  expect: { timeout: 15_000 },
  reporter: 'list',
  // Native focus loss needs a headed window; the step disables focus emulation.
  use: { ...devices['Desktop Chrome'], headless: false, actionTimeout: 15_000,
    viewport: { width: 1280, height: 800 }, baseURL: process.env.FLUUX_LIVE_APP },
})
