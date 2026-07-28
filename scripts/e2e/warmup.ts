/**
 * Playwright globalSetup: warm the vite dev server before any test runs.
 *
 * Why this exists. The suites run with `fullyParallel: false`, so each project's first
 * test is also the one that pays vite's cold transform of the demo bundle. Measured
 * locally that first test costs ~18s against ~3s once warm; on a 2-core CI runner, with
 * both engines demanding the same uncached graph at once, it has been observed to blow
 * the 120s mount budget outright. The symptom was a "flaky" first test that in fact
 * failed on the first attempt of 13 consecutive green runs and only passed on retry —
 * roughly two minutes of every run, spent proving the bundle compiles.
 *
 * Loading the demo once here moves that cost outside any per-test budget and removes the
 * contention: by the time the projects start, the module graph is already transformed.
 *
 * Best-effort by design. A failure here is logged and swallowed rather than thrown: the
 * tests keep their own generous mount budgets, so a warm-up that cannot run leaves the
 * suite exactly as it was before. Warming must never be able to turn a slow boot into a
 * hard failure.
 */
import { chromium, type FullConfig } from '@playwright/test'
import { bootDemo } from './demoBoot'

/** No stress params: the module graph is identical, without paying for the seeding. */
const WARMUP_PATH = '/demo.html?tutorial=false'

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use?.baseURL ?? 'http://localhost:5173'
  const startedAt = Date.now()

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await bootDemo(page, `${baseURL}${WARMUP_PATH}`)
    console.log(`[warmup] demo bundle transformed in ${Math.round((Date.now() - startedAt) / 1000)}s`)
  } catch (error) {
    console.warn(
      `[warmup] skipped after ${Math.round((Date.now() - startedAt) / 1000)}s: ${(error as Error).message}\n` +
        '[warmup] tests will run against a cold server; their own mount budgets still apply.',
    )
  } finally {
    await browser.close()
  }
}
