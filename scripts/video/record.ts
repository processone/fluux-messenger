/**
 * Demo video recorder for Fluux Messenger.
 *
 * Drives the demo (`/demo.html`) with Playwright and records a promo video of
 * the major features, in two variants:
 *   - reel: short highlight (~90s)
 *   - full: comprehensive tour (~3–4 min)
 *
 * Usage:
 *   npm run demo:video         # both variants
 *   npm run demo:video:reel    # reel only
 *   npm run demo:video:full    # full only
 *
 * Output (gitignored): video/fluux-demo-<variant>.mp4 (+ .webm)
 *
 * Capture: a deterministic stepped recorder (see director.ts) takes one native
 * 1920×1080 screenshot per output frame from a dense (1280×720 @ 1.5×) render,
 * then ffmpeg assembles an exact, smooth constant-fps video — no upscaling, no
 * virtual-time fragility.
 */

import { test, type Browser } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { RENDER_SIZE, BASE_URL, DEMO_URL } from './helpers'
import { Director } from './director'
import { scenesFor, type Variant } from './storyboard'

const OUTPUT_DIR = 'video'

async function record(browser: Browser, variant: Variant): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true })

  // Pre-warm the dev server (off-camera) so the recorded run reaches the app
  // fast instead of waiting on a cold Vite compile.
  const warm = await browser.newContext()
  await (await warm.newPage()).goto(DEMO_URL, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {})
  await warm.close()

  const context = await browser.newContext({
    // Dense layout (fills the frame) rendered at 1.5× so screenshots are a
    // native 1920×1080 — no upscaling. Native mouse coordinates (no zoom).
    viewport: RENDER_SIZE,
    deviceScaleFactor: 1.5,
    colorScheme: 'dark',
    baseURL: BASE_URL,
  })
  const page = await context.newPage()
  const d = new Director(page, `${OUTPUT_DIR}/.frames-${variant}`)

  let ok = false
  try {
    await d.setup('Fluux Messenger', 'A modern XMPP client')
    await d.intro(2700)
    for (const scene of scenesFor(variant)) {
      // eslint-disable-next-line no-console
      console.log(`  ▶ ${variant}: ${scene.id}`)
      await scene.run(d)
    }
    await d.outro('Fluux Messenger', 'Open. Secure. Yours.', 3800)
    ok = true
  } finally {
    await context.close()
  }

  if (ok) {
    const { frames, seconds } = d.finish(`${OUTPUT_DIR}/fluux-demo-${variant}`)
    // eslint-disable-next-line no-console
    console.log(`  ✓ ${variant}: video/fluux-demo-${variant}.mp4 (${frames} frames, ${seconds.toFixed(1)}s)`)
    d.cleanup()
  }
}

test('reel — Fluux demo video', async ({ browser }) => {
  await record(browser, 'reel')
})

test('full — Fluux demo video', async ({ browser }) => {
  await record(browser, 'full')
})
