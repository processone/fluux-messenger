/**
 * Renders the blog hero compositions in this directory to screenshots/.
 *
 * Each *.html file here is a self-contained 1200×675 layout (see shared.css)
 * that references committed marketing screenshots and app fonts relatively,
 * so it renders offline. Output is captured at 2x (2400×1350); the blog CMS
 * serves a 1200px-wide resize.
 *
 * Usage: node scripts/blog-hero/render.mjs [name-filter]
 */
import { chromium } from '@playwright/test'
import { readdirSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const outDir = resolve(dir, '../../screenshots')
const filter = process.argv[2]
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => !filter || f.includes(filter))

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 1200, height: 675 },
  deviceScaleFactor: 2,
})

for (const f of files) {
  await page.goto('file://' + resolve(dir, f))
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  const out = resolve(outDir, basename(f, '.html') + '.png')
  await page.screenshot({ path: out })
  console.log('rendered', out)
}

await browser.close()
