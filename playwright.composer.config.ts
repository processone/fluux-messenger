import { defineConfig, devices } from '@playwright/test'

// Composer geometry invariants. Kept separate from the scroll suite so each gate
// can be run (and diagnosed) on its own, but wired the same way: both engines,
// against the demo dev server.
export default defineConfig({
  testDir: './scripts',
  testMatch: 'composer-geometry.ts',
  // The measurements themselves are fast (<5s); the budget is for WebKit booting
  // the demo bundle on a busy CI runner, which the scroll suite has seen exceed 90s.
  timeout: 180_000,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 800 },
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
})
