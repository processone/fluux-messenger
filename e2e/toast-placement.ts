/**
 * In-app notices sit at the top end, under the conversation header, so they never
 * cover the composer the user is typing in, and never take the draft or focus
 * (FLM-228). jsdom has no layout, so the overlap can only be checked on real boxes.
 */
import { test, expect, type Locator } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

const DEMO_URL = '/demo.html?tutorial=false'
const WIDTHS = [1400, 700, 390]
/** 600 is a normal short window; 380 leaves little room above an 8-line draft. */
const HEIGHTS = [600, 380]
const VIEWS = ['chat', 'room'] as const
const DRAFT = Array.from({ length: 8 }, (_, i) => `Draft line ${i + 1} that the notice must not hide`).join('\n')

for (const view of VIEWS) {
  for (const width of WIDTHS) {
    for (const height of HEIGHTS) {
      test(`${view}: notice stays clear of the composer at ${width}x${height}`, async ({ page }) => {
        await page.setViewportSize({ width, height })
        await bootDemo(page, DEMO_URL)

        let composer: Locator
        if (view === 'chat') {
          await page.getByText('Emma Wilson', { exact: true }).first().click()
          composer = page.locator('textarea').first()
        } else {
          await page.locator('[data-nav="rooms"]').click()
          await page.getByText('Team Chat', { exact: true }).first().click()
          composer = page.locator('.message-input[contenteditable="true"]').first()
        }
        await composer.waitFor({ state: 'visible', timeout: 30_000 })
        await composer.focus()
        for (const [i, line] of DRAFT.split('\n').entries()) {
          if (i > 0) await page.keyboard.press('Shift+Enter')
          await page.keyboard.insertText(line)
        }
        const read = () => composer.evaluate((el) => (el as HTMLTextAreaElement).value ?? el.textContent)
        const draft = await read()

        await page.evaluate(() => {
          const store = (window as unknown as { __toastStore: { getState: () => { addToast: (...a: unknown[]) => string } } }).__toastStore
          store.getState().addToast('info', 'Mia Thompson: Just the regression test pass — James is running it now. We should be good to ship on schedule', 0)
          store.getState().addToast('error', 'Message not sent: the server took too long to answer. Check your connection and try again in a moment, then resend it', 0)
          store.getState().addToast('success', 'Copied', 0)
        })
        const stack = page.locator('[data-toast-stack]')
        await stack.waitFor({ state: 'attached' })
        await page.waitForTimeout(400) // entry animation

        // The draft and focus are untouched by the notices.
        expect(await read()).toBe(draft)
        await expect(composer).toBeFocused()

        // The stack is under the header and never reaches the composer (it may be empty).
        const s = (await stack.boundingBox())!
        const c = (await composer.boundingBox())!
        const h = (await page.locator('main header').first().boundingBox())!
        expect(s.y).toBeGreaterThanOrEqual(h.y + h.height)
        // An empty stack (no room left above the composer) covers nothing.
        if (s.height > 0) expect(s.y + s.height).toBeLessThanOrEqual(c.y)

        // Opening Find while notices are shown keeps the stack under the Find bar.
        await page.keyboard.press('ControlOrMeta+f')
        const find = page.locator('[data-find-on-page-bar]')
        await find.waitFor({ state: 'visible' })
        await expect.poll(async () => {
          const f = (await find.boundingBox())!
          const st = (await stack.boundingBox())!
          const c2 = (await composer.boundingBox())!
          return st.y >= f.y + f.height && (st.height === 0 || st.y + st.height <= c2.y)
        }).toBe(true)
      })
    }
  }
}
