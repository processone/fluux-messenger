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
    await page.setViewportSize({ width, height: 600 })
    await bootDemo(page, DEMO_URL)
    await page.getByText('Emma Wilson', { exact: true }).first().click()
    const composer = page.locator('textarea').first()
    await composer.waitFor({ state: 'visible', timeout: 30_000 })
    await composer.fill(Array.from({ length: 8 }, (_, i) => `Draft line ${i + 1} that the notice must not hide`).join('\n'))

    await page.evaluate(() => {
      const store = (window as unknown as { __toastStore: { getState: () => { addToast: (...a: unknown[]) => string } } }).__toastStore
      store.getState().addToast('info', 'Mia Thompson: Just the regression test pass — James is running it now. We should be good to ship on schedule', 0)
      store.getState().addToast('error', 'Message not sent: the server took too long to answer. Check your connection and try again in a moment, then resend it', 0)
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

    // Opening Find while notices are shown keeps the stack under the Find bar.
    await page.keyboard.press('ControlOrMeta+f')
    const find = page.locator('[data-find-on-page-bar]')
    await find.waitFor({ state: 'visible' })
    await expect.poll(async () => {
      const f = (await find.boundingBox())!
      const st = (await stack.boundingBox())!
      return st.y >= f.y + f.height
    }).toBe(true)
    const s2 = (await stack.boundingBox())!
    const c2 = (await composer.boundingBox())!
    expect(s2.y + s2.height).toBeLessThanOrEqual(c2.y)
  })
}
