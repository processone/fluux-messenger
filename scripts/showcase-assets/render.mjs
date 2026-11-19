/**
 * Renders the showcase scene's images (apps/fluux/public/demo/showcase/) from the
 * HTML sources next to this script. They are drawn rather than photographed so
 * the demo ships no third-party imagery.
 *
 * Usage: node scripts/showcase-assets/render.mjs
 */

import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '../../apps/fluux/public/demo/showcase')

const images = [
  { name: 'poster', width: 1200, height: 900 },
  { name: 'stage', width: 1200, height: 750 },
  { name: 'trail', width: 1200, height: 800 },
  { name: 'og', width: 1200, height: 630 },
]

const browser = await chromium.launch()
for (const { name, width, height } of images) {
  const page = await browser.newPage({ viewport: { width, height } })
  await page.goto(`file://${join(here, `${name}.html`)}`)
  await page.screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 86 })
  await page.close()
}
await browser.close()
