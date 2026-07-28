/**
 * Shared demo boot for the Playwright suites.
 *
 * Both the scroll and the composer harness need the same three things before they can
 * measure anything: the demo loaded, React mounted, and the stress seeding finished.
 * Keeping that here gives the readiness contract with demo.tsx a single owner.
 */
import type { Page } from '@playwright/test'

/**
 * WebKit on a loaded CI runner has been observed taking >45s (occasionally >90s) just to
 * boot the demo bundle. Generous ceiling so a slow boot proceeds into the test body
 * instead of burning a retry; a warm run clears it in a second or two.
 */
const MOUNT_TIMEOUT_MS = 120_000

/** Seeding is fast once the bundle is warm — this ceiling only catches a genuine hang. */
const SEED_TIMEOUT_MS = 30_000

/** Navigate to a demo URL and return once it is mounted and fully seeded. */
export async function bootDemo(page: Page, url: string): Promise<void> {
  // Explicit, so the ceiling does not depend on where the Page came from: inside a test
  // page.goto carries no limit of its own and is bounded by the 180s test budget, while a
  // Page from a raw browser.launch() gets Playwright's 30s default. Pinning it here also
  // keeps navigation under the test budget, leaving ~60s for the body.
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: MOUNT_TIMEOUT_MS })
  // The sidebar nav proves React mounted.
  await page.waitForSelector('[data-nav="messages"]', { timeout: MOUNT_TIMEOUT_MS })
  await waitForDemoSeeded(page)
}

/**
 * Wait for the demo's stress seeding to actually complete.
 *
 * demo.tsx sets `__fluuxDemoReady` once runStressScenario's last scheduled event has been
 * emitted. This replaced a fixed 1.2s sleep that was both wasteful on a fast boot and a
 * silent race on a slow one — the seeding duration is a function of messagesPerRoom and
 * msgStepMs, so no constant can be right for every scenario.
 */
export async function waitForDemoSeeded(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (window as Window & { __fluuxDemoReady?: boolean }).__fluuxDemoReady === true,
    undefined,
    { timeout: SEED_TIMEOUT_MS },
  )
}
