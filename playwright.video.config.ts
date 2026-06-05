import { defineConfig } from '@playwright/test'

/**
 * Playwright config for the demo *video* pipeline (scripts/video/record.ts).
 *
 * Separate from playwright.config.ts (screenshots) so the two never collide:
 * here we WANT motion (no reducedMotion), a 1080p canvas, and a long timeout
 * for the multi-minute walkthrough. Video is recorded per-context inside the
 * test (see record.ts) rather than via `use.video`, so we control the output
 * path and the MP4 conversion.
 */
export default defineConfig({
  testDir: './scripts/video',
  testMatch: 'record.ts',
  // Full tour can run several minutes + ffmpeg conversion afterwards.
  timeout: 360_000,
  fullyParallel: false,
  retries: 0,
  workers: 1,
  use: {
    baseURL: 'http://localhost:5173',
    // The recording context (record.ts) sets its own dense viewport + 1.5×
    // device scale for native-resolution screencast capture; this is just the
    // fixture default.
    viewport: { width: 1280, height: 720 },
    // Backstop: never let a missing element hang the whole multi-minute run.
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    // Keep the (headless) renderer painting continuously — otherwise the page
    // is treated as backgrounded and the CDP screencast captures almost no
    // frames during the run.
    launchOptions: {
      args: [
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    },
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 60_000,
  },
})
