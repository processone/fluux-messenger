import { defineConfig } from '@playwright/test'

export default defineConfig({
  timeout: 120_000, testDir: '.', testMatch: 'modal-keyboard.ts', workers: 1,
  use: { baseURL: 'http://127.0.0.1:5196', viewport: { width: 390, height: 844 }, hasTouch: true, reducedMotion: 'reduce' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: { cwd: '..', command: 'npm run dev -w @xmpp/fluux -- --host 127.0.0.1 --port 5196 --strictPort', url: 'http://127.0.0.1:5196', reuseExistingServer: true },
})
