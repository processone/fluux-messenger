/**
 * Demo video recorder for Fluux Messenger.
 *
 * Drives the demo (`/demo.html`) with Playwright and records a promo video of
 * the major features. Produces two variants:
 *   - reel: short highlight (~90s)
 *   - full: comprehensive tour (~3–4 min)
 *
 * Usage:
 *   npm run demo:video         # both variants
 *   npm run demo:video:reel    # reel only
 *   npm run demo:video:full    # full only
 *
 * Output (gitignored):
 *   video/fluux-demo-reel.webm  + .mp4
 *   video/fluux-demo-full.webm  + .mp4
 *
 * Capture strategy A: Playwright recordVideo (WebM) → ffmpeg → MP4. If motion
 * looks choppy, swap the capture layer for deterministic CDP frames at a
 * constant fps without touching the storyboard.
 */

import { test, type Browser } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import {
  RENDER_SIZE, BASE_URL, DEMO_URL,
  openDemo, waitForAppReady, installPolishLayers,
  coverWithTitle, hideTitleCard, titleCard, convertToMp4,
} from './helpers'
import { scenesFor, type Variant } from './storyboard'

const OUTPUT_DIR = 'video'
const RAW_DIR = `${OUTPUT_DIR}/.raw`

async function record(browser: Browser, variant: Variant): Promise<void> {
  mkdirSync(RAW_DIR, { recursive: true })

  // Pre-warm the dev server (off-camera): the first cold load of the large
  // demo bundle takes several seconds to compile in Vite dev, which would show
  // as a white flash at the very start of the recording. Warming it first lets
  // the recorded navigation reach the app almost immediately.
  const warm = await browser.newContext()
  const warmPage = await warm.newPage()
  await warmPage.goto(DEMO_URL, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => {})
  await warm.close()

  const context = await browser.newContext({
    // Lay out + capture natively at the denser RENDER_SIZE so the UI fills the
    // frame (and cursor coordinates stay native); convertToMp4 upscales the
    // result to VIDEO_SIZE (1080p) with a high-quality lanczos filter.
    viewport: RENDER_SIZE,
    colorScheme: 'dark',
    baseURL: BASE_URL,
    recordVideo: { dir: RAW_DIR, size: RENDER_SIZE },
  })
  const page = await context.newPage()
  const video = page.video()

  try {
    // Open the page and immediately cover it with the intro card so the
    // app's load happens off-camera (no white flash, no pre-roll glimpse).
    await openDemo(page)
    await installPolishLayers(page)
    await coverWithTitle(page, 'Fluux Messenger', 'A modern XMPP client')
    await waitForAppReady(page)
    await page.waitForTimeout(1600) // hold the intro card
    await hideTitleCard(page)

    for (const scene of scenesFor(variant)) {
      // eslint-disable-next-line no-console
      console.log(`  ▶ ${variant}: ${scene.id}`)
      await scene.run(page)
    }

    await titleCard(page, 'Fluux Messenger', 'Open. Secure. Yours.', 2800)
  } finally {
    await context.close() // finalises the WebM
  }

  if (video) {
    const webm = `${OUTPUT_DIR}/fluux-demo-${variant}.webm`
    await video.saveAs(webm)
    // eslint-disable-next-line no-console
    console.log(`  ✓ WebM: ${webm}`)
    convertToMp4(webm, `${OUTPUT_DIR}/fluux-demo-${variant}.mp4`)
  }
}

test('reel — Fluux demo video', async ({ browser }) => {
  await record(browser, 'reel')
})

test('full — Fluux demo video', async ({ browser }) => {
  await record(browser, 'full')
})
