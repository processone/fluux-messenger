import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './scripts',
  testMatch: 'ux-screenshots.ts',
  timeout: 120_000,
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 800 },
    // Through `contextOptions`, not as a bare `use` key: `reducedMotion` is not a
    // Playwright test option, so the top-level form type-checks against nothing and is
    // dropped before the browser context is built — the animations it means to disable
    // stayed on.
    contextOptions: { reducedMotion: 'reduce' },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
})
