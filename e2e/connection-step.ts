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

// The demo never receives the session inputs that end the SDK's session
// preparation (it holds the "Updating..." step for up to its time limit), so the
// plain online-return checks end it the way the finished sync would.
const finishSync = (page: Page) =>
  page.evaluate(() => (window as W).__connectionStore!.getState().resetCatchUp())

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
        // Read the baseline only once the clicked conversation is open.
        await expect(header).toContainText(view === 'chat' ? 'Emma Wilson' : 'Team Chat')
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
        // Exactly one screen-reader announcer is exposed for the step.
        await expect(page.getByRole('status').filter({ hasText: 'Connecting' })).toHaveCount(1)
        expect(await headerHeight(page)).toBe(baseline)
        await shot(page, `${vp.label}-${view}-3-connecting`)

        await setConnection(page, 'verifying')
        await expect(step).toContainText('Verifying')
        expect(await headerHeight(page)).toBe(baseline)

        // Back online: the normal subtitle returns, same height.
        await setConnection(page, 'online')
        await finishSync(page)
        await expect(page.getByTestId('connection-step')).toHaveCount(0)
        expect(await headerHeight(page)).toBe(baseline)
        expect(await header.innerText()).toBe(subtitleBefore)
        await shot(page, `${vp.label}-${view}-4-back-online`)

        info.annotations.push({ type: 'header-height', description: `${vp.label} ${view}: ${baseline}px in every state` })
      })
    }

    // The demo has no XMPP server, so the journey plays the SDK's side of the
    // handoff through the real store owners (the same beginCatchUp the session
    // preparation, MAM fetches and room passes use): preparation takes over at
    // 'online', a fetch owner takes over from it, and the step ends with the
    // last owner. The header must never show presence in between.
    test(`${vp.label}: header keeps "Updating..." from reconnecting until the last catch-up owner ends`, async ({ page }) => {
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.evaluate(() => (window as unknown as { __demoClient?: { stopAnimation(): void } }).__demoClient?.stopAnimation())
      await page.locator('[data-nav="messages"]').click()
      await page.getByTestId('sidebar-pane').getByText('Emma Wilson', { exact: true }).first().click()
      const header = page.locator('header').last()
      await expect(header).toBeVisible()
      const baseline = await headerHeight(page)
      const presence = await header.innerText()

      // Every header text change from here on is recorded in the page.
      await page.evaluate(() => {
        const w = window as unknown as { __seen: string[] }
        w.__seen = []
        const h = Array.from(document.querySelectorAll('header')).pop()!
        new MutationObserver(() => w.__seen.push(h.innerText)).observe(h, { subtree: true, childList: true, characterData: true })
      })

      await setConnection(page, 'reconnecting', 1, null)
      const step = header.getByTestId('connection-step')
      await expect(step).toContainText('Connecting', { timeout: GRACE_MS + 1000 })

      // Online: the SDK's own session preparation owns the step from the status
      // change (no owner is begun here), so presence never reappears.
      await setConnection(page, 'online')
      await expect(step).toContainText('Updating...')
      await expect(page.getByRole('status').filter({ hasText: 'Updating' })).toHaveCount(1)
      expect(await headerHeight(page)).toBe(baseline)
      await shot(page, `${vp.label}-chat-5-updating`)

      // The sync's catch-up owners take over from preparation (the demo has no
      // session inputs to end it, so it is replaced in one synchronous step), then
      // hand over to each other; the step stays throughout.
      await page.evaluate(() => {
        const w = window as W & { __owners: Array<() => void> }
        const s = w.__connectionStore!.getState()
        s.resetCatchUp()
        w.__owners = [s.beginCatchUp(), s.beginCatchUp()]
      })
      await page.waitForTimeout(300)
      await expect(step).toContainText('Updating...')
      await page.evaluate(() => (window as W & { __owners: Array<() => void> }).__owners.shift()!())
      await expect(step).toContainText('Updating...')

      // Last owner ends: the normal subtitle returns.
      await page.evaluate(() => (window as W & { __owners: Array<() => void> }).__owners.shift()!())
      await expect(page.getByTestId('connection-step')).toHaveCount(0)
      expect(await headerHeight(page)).toBe(baseline)
      expect(await header.innerText()).toBe(presence)

      // Presence appeared only after the last owner ended (the final snapshot).
      const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen)
      expect(seen.slice(0, -1).filter((t) => t === presence)).toEqual([])
    })

    test(`${vp.label}: the "Updating..." time limit survives navigating between conversations`, async ({ page }) => {
      test.setTimeout(60_000)
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.evaluate(() => (window as unknown as { __demoClient?: { stopAnimation(): void } }).__demoClient?.stopAnimation())
      await page.locator('[data-nav="messages"]').click()
      const list = page.getByTestId('sidebar-pane')
      await list.getByText('Emma Wilson', { exact: true }).first().click()
      await expect(page.locator('header').last()).toBeVisible()

      // A catch-up that never ends (a stuck owner) keeps isCatchingUp true.
      await page.evaluate(() => { (window as W).__connectionStore!.getState().beginCatchUp() })
      const step = () => page.locator('header').last().getByTestId('connection-step')
      await expect(step()).toContainText('Updating...', { timeout: GRACE_MS + 1000 })
      await expect(step()).toHaveCount(0, { timeout: 16_000 })

      // Opening another conversation mounts a new header: the expired step stays gone.
      if (vp.label === 'iphone') await page.getByRole('button', { name: /back/i }).first().click()
      await page.locator('[data-nav="rooms"]').click()
      await list.getByText('Team Chat', { exact: true }).first().click()
      await page.waitForTimeout(GRACE_MS + 500)
      await expect(step()).toHaveCount(0)
      expect(await page.evaluate(() => (window as W).__connectionStore!.getState().isCatchingUp)).toBe(true)
    })

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
      await expect(page.getByRole('status').filter({ hasText: 'Connecting' })).toHaveCount(1)
      expect(await bar.evaluate((el) => el.getBoundingClientRect().height)).toBe(before)
      await shot(page, `${vp.label}-list-title`)
    })
  })
}
