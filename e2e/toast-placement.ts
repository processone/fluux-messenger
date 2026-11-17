/**
 * In-app notices sit at the top end, under the conversation header, so they never
 * cover the composer the user is typing in (FLM-228). jsdom has no layout, so the
 * overlap can only be checked on real boxes.
 */
import { test, expect } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

const DEMO_URL = '/demo.html?tutorial=false'
const WIDTHS = [1400, 700, 390]

for (const width of WIDTHS) {
  test(`notice stays clear of the composer at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 })
    await bootDemo(page, DEMO_URL)
    await page.getByText('Emma Wilson', { exact: true }).first().click()
    const composer = page.locator('textarea').first()
    await composer.waitFor({ state: 'visible', timeout: 30_000 })
    await composer.fill('A long draft that the notice must not hide while it is being typed')

    await page.evaluate(() => {
      const store = (window as unknown as { __toastStore: { getState: () => { addToast: (...a: unknown[]) => string } } }).__toastStore
      store.getState().addToast('info', 'Mia Thompson: Just the regression test pass — James is running it now. We should be good to ship on schedule', 0)
      store.getState().addToast('success', 'Copied', 0)
    })
    const stack = page.locator('[data-toast-stack]')
    await stack.waitFor({ state: 'visible' })
    await page.waitForTimeout(400) // entry animation

    const s = (await stack.boundingBox())!
    const c = (await composer.boundingBox())!
    const h = (await page.locator('main header').first().boundingBox())!
    expect(s.y).toBeGreaterThanOrEqual(h.y + h.height)
    expect(s.y + s.height).toBeLessThanOrEqual(c.y)
  })
}
