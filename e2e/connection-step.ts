/**
 * Playwright journey for the reconnection step shown in the conversation header
 * (FLM-120). jsdom has no layout, so "the header never changes height" can only
 * be proven here, in real engines, at desktop and iPhone widths.
 *
 * The demo runs on the SDK's real connection store; the test drives it through
 * `__connectionStore` the way the XMPP client would during an outage.
 *
 * Set CONNECTION_STEP_SHOTS=<dir> to also save screenshots of each state.
 */
import { test, expect, type Page } from '@playwright/test'
import type { connectionStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'

const SHOTS = process.env.CONNECTION_STEP_SHOTS
const GRACE_MS = 2000

type Store = typeof connectionStore
type W = Window & { __connectionStore?: Store }

const setConnection = (page: Page, status: string, attempt = 0, targetInMs: number | null = null) =>
  page.evaluate(([s, a, t]) => {
    // A transient drop keeps a stored session; without one App routes a
    // non-online status to the login screen (a fresh login in progress).
    const store = (window as W).__connectionStore!.getState()
    const jid = (store.jid ?? 'demo@example.com').split('/')[0]
    sessionStorage.setItem(`xmpp-session:${jid}`, JSON.stringify({ jid, password: 'x', server: 'example.com' }))
    store.setReconnectState(a as number, t === null ? null : Date.now() + (t as number))
    store.setStatus(s as never)
  }, [status, attempt, targetInMs] as const)

async function headerHeight(page: Page): Promise<number> {
  return page.locator('main header, header').last().evaluate((el) => el.getBoundingClientRect().height)
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const VIEWPORTS = [
  { label: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  { label: 'iphone', use: { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } },
] as const

for (const vp of VIEWPORTS) {
  test.describe(`connection step (${vp.label})`, () => {
    test.use(vp.use)

    for (const view of ['chat', 'room'] as const) {
      test(`${view} header shows each step without changing height`, async ({ page }, info) => {
        await bootDemo(page, '/demo.html?tutorial=false')
        await page.evaluate(() => (window as unknown as { __demoClient?: { stopAnimation(): void } }).__demoClient?.stopAnimation())

        if (view === 'chat') {
          await page.locator('[data-nav="messages"]').click()
          await page.getByTestId('sidebar-pane').getByText('Emma Wilson', { exact: true }).first().click()
        } else {
          await page.locator('[data-nav="rooms"]').click()
          await page.getByTestId('sidebar-pane').getByText('Team Chat', { exact: true }).first().click()
        }
        const header = page.locator('header').last()
        await expect(header).toBeVisible()
        const baseline = await headerHeight(page)
        const subtitleBefore = await header.innerText()
        await shot(page, `${vp.label}-${view}-1-online`)

        // Within the grace nothing is shown.
        await setConnection(page, 'reconnecting', 2, 30_000)
        await page.waitForTimeout(GRACE_MS - 800)
        await expect(page.getByTestId('connection-step')).toHaveCount(0)

        // Countdown step.
        const step = header.getByTestId('connection-step')
        await expect(step).toBeVisible({ timeout: 3000 })
        await expect(step).toContainText(/\d+\s?s/)
        expect(await headerHeight(page)).toBe(baseline)
        await shot(page, `${vp.label}-${view}-2-countdown`)

        // A running retry: still 'reconnecting' but no countdown target.
        await setConnection(page, 'reconnecting', 2, null)
        await expect(step).toContainText('Connecting')
        expect(await headerHeight(page)).toBe(baseline)
        await shot(page, `${vp.label}-${view}-3-connecting`)

        await setConnection(page, 'verifying')
        await expect(step).toContainText('Verifying')
        expect(await headerHeight(page)).toBe(baseline)

        // Back online: the normal subtitle returns, same height.
        await setConnection(page, 'online')
        await expect(page.getByTestId('connection-step')).toHaveCount(0)
        expect(await headerHeight(page)).toBe(baseline)
        expect(await header.innerText()).toBe(subtitleBefore)
        await shot(page, `${vp.label}-${view}-4-back-online`)

        info.annotations.push({ type: 'header-height', description: `${vp.label} ${view}: ${baseline}px in every state` })
      })
    }

    test('list title shows the step on narrow screens only', async ({ page }) => {
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.locator('[data-nav="messages"]').click()
      const title = page.getByTestId('sidebar-pane').locator('h1')
      await expect(title).toBeVisible()
      // The h1 line box may differ (12px step vs title); the fixed-height bar around it must not.
      const bar = title.locator('xpath=..')
      const before = await bar.evaluate((el) => el.getBoundingClientRect().height)
      await setConnection(page, 'connecting')
      await page.waitForTimeout(GRACE_MS + 300)
      const step = title.getByTestId('connection-step')
      if (vp.label === 'iphone') {
        await expect(step).toBeVisible()
        await expect(title.getByText('Messages', { exact: true })).toBeHidden()
      } else {
        await expect(step).toBeHidden()
        await expect(title.getByText('Messages', { exact: true })).toBeVisible()
      }
      expect(await bar.evaluate((el) => el.getBoundingClientRect().height)).toBe(before)
      await shot(page, `${vp.label}-list-title`)
    })
  })
}
