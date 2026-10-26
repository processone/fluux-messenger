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
import type { connectionStore, chatStore, roomStore } from '@fluux/sdk/stores'
import { bootDemo } from './harness/demoBoot'

const SHOTS = process.env.CONNECTION_STEP_SHOTS
const GRACE_MS = 2000

type Store = typeof connectionStore
type Scope = Parameters<ReturnType<Store['getState']>['beginUpdate']>[0][number]
type W = Window & { __connectionStore?: Store; __chatStore?: typeof chatStore; __roomStore?: typeof roomStore; __owners?: Array<() => void> }

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
// preparation. Its unknown-target handle affects only the public aggregate;
// plain online-return checks release it the way finished sync would.
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

    // FLM-168: exercise the actual application and single SDK owner with
    // controlled producer completion, independently from server timing.
    for (const view of ['chat', 'room'] as const) {
      test(`${view}: scoped retrieval is brief, preserves layout and has no expiry`, async ({ page }, info) => {
        await bootDemo(page, '/demo.html?tutorial=false')
        await page.evaluate(() => (window as unknown as { __demoClient: { stopAnimation(): void } }).__demoClient.stopAnimation())
        const nav = view === 'chat' ? 'messages' : 'rooms'
        const name = view === 'chat' ? 'Emma Wilson' : 'Team Chat'
        const scope = view === 'chat' ? 'chat:emma@fluux.chat' : 'room:team@conference.fluux.chat'
        await page.locator(`[data-nav="${nav}"]`).click()
        await page.getByTestId('sidebar-pane').getByText(name, { exact: true }).first().click()
        await page.mouse.move(1100, 700)
        const header = page.locator('header').last()
        await expect(header).toContainText(name)
        const baseline = await headerHeight(page)
        const normal = await header.innerText()
        const begin = (scopes: Scope[]) => page.evaluate(scopes => {
          const w = window as W
          w.__owners ??= []
          w.__owners.push(w.__connectionStore!.getState().beginUpdate(scopes))
        }, scopes)
        const end = () => page.evaluate(() => (window as W).__owners!.shift()!())
        const stable = async () => expect(await headerHeight(page)).toBe(baseline)

        // Unknown/global preparation and another conversation do not affect this header.
        await begin(['chat:other@fluux.chat'])
        await page.waitForTimeout(2200)
        await expect(header.getByTestId('update-text')).toHaveCount(0)
        await expect(header.getByTestId('update-icon')).toHaveCount(0)
        await end()
        // Short local work stays silent.
        await begin([scope, nav])
        await page.waitForTimeout(600)
        await end()
        await expect(header.getByTestId('update-text')).toHaveCount(0)

        // Measure the message surface as well as the fixed header; no inserted banner.
        const messageSurface = page.locator('[data-message-id]').first()
        const top = await messageSurface.evaluate(el => el.getBoundingClientRect().top).catch(() => null)
        await begin([scope, nav])
        await page.waitForTimeout(1000)
        await expect(header.getByTestId('update-text')).toHaveCount(0)
        await expect(header.getByTestId('update-text')).toContainText('Retrieving messages', { timeout: 2500 })
        await stable()
        await shot(page, `${vp.label}-${view}-scoped-brief`)
        const started = await page.evaluate(scope => (window as W).__connectionStore!.getState().updates[scope as Scope]!.startedAt, scope)
        const announced = await header.getByTestId('update-announcement').textContent()
        await expect(header.getByTestId('update-icon')).toBeVisible({ timeout: 4000 })
        // Accessible retrieval text is additional header content, not a subtitle change.
        for (const line of normal.split('\n').map(line => line.trim()).filter(Boolean)) {
          await expect(header).toContainText(line)
        }
        await stable()
        expect(await header.getByTestId('update-announcement').textContent()).toBe(announced)
        await expect(header.getByTestId('update-icon').locator('svg')).not.toHaveClass(/animate-spin/)
        if (top !== null) expect(await messageSurface.evaluate(el => el.getBoundingClientRect().top)).toBe(top)
        await shot(page, `${vp.label}-${view}-scoped-icon`)
        // Explanation opens without opening room info or moving the messages.
        const trigger = header.getByRole('button', { name: new RegExp(`Retrieving messages for ${name}`) })
        const explanation = page.getByRole('tooltip').filter({ hasText: `Retrieving messages for ${name}` })
        await trigger.focus()
        await page.keyboard.press('Enter')
        await expect(explanation).toBeVisible()
        await expect(explanation.locator('..')).toHaveCSS('opacity', '1')
        await trigger.press('Enter')
        await expect(explanation).toHaveCount(0)
        await trigger.click()
        await expect(explanation).toBeVisible()
        await expect(explanation.locator('..')).toHaveCSS('opacity', '1')
        await trigger.click()
        await expect(explanation).toHaveCount(0)

        // Navigate away, then come back after the brief window: no new grace/text.
        if (vp.label === 'iphone') await page.getByRole('button', { name: /back/i }).first().click()
        await page.locator('[data-nav="settings"]').click()
        await expect(page.getByTestId('update-text')).toHaveCount(0)
        await expect(page.getByTestId('update-icon')).toHaveCount(0)
        await page.locator(`[data-nav="${nav}"]`).click()
        await page.getByTestId('sidebar-pane').getByText(name, { exact: true }).first().click()
        await expect(header.getByTestId('update-icon')).toBeVisible()
        await expect(header.getByTestId('update-text')).toHaveCount(0)
        expect(await page.evaluate(scope => (window as W).__connectionStore!.getState().updates[scope as Scope]!.startedAt, scope)).toBe(started)
        // The icon is still present after the former 15-second cutoff.
        await page.waitForTimeout(Math.max(0, 15_200 - (Date.now() - started)))
        await expect(header.getByTestId('update-icon')).toBeVisible()
        await stable()
        await end()
        await expect(header.getByTestId('update-icon')).toHaveCount(0)
        await expect(header.getByTestId('update-announcement')).toContainText(`Message retrieval ended for ${name}`)
        await stable()

        // FLM-171 F1: a short verification must not replay the retained end.
        await page.evaluate(() => (window as W).__connectionStore!.getState().setIsVerifying(true))
        await page.waitForTimeout(250)
        await page.evaluate(() => (window as W).__connectionStore!.getState().setIsVerifying(false))
        await expect(header.getByTestId('update-announcement')).toHaveText('')

        // ChatHeader and RoomHeader reuse their component instance across targets.
        const otherName = await page.evaluate(view => {
          const w = window as W
          return view === 'chat'
            ? w.__chatStore!.getState().conversations.get('sophia@fluux.chat')!.name
            : w.__roomStore!.getState().rooms.get('design@conference.fluux.chat')!.name!
        }, view)
        if (vp.label === 'iphone') await page.getByRole('button', { name: /back/i }).first().click()
        await page.getByTestId('sidebar-pane').getByText(otherName, { exact: true }).first().click()
        await expect(header).toContainText(otherName)
        await expect(header.getByTestId('update-announcement')).toHaveText('')
        if (vp.label === 'iphone') await page.getByRole('button', { name: /back/i }).first().click()
        await page.getByTestId('sidebar-pane').getByText(name, { exact: true }).first().click()
        await expect(header).toContainText(name)
        await expect(header.getByTestId('update-announcement')).toHaveText('')

        // Completion during verification is also historical on healthy return.
        await begin([scope])
        await expect(header.getByTestId('update-text')).toBeVisible({ timeout: 3000 })
        await page.evaluate(() => (window as W).__connectionStore!.getState().setIsVerifying(true))
        await end()
        await page.waitForTimeout(250)
        await page.evaluate(() => (window as W).__connectionStore!.getState().setIsVerifying(false))
        await expect(header.getByTestId('update-announcement')).toHaveText('')
        info.annotations.push({ type: 'scoped-update', description: `${vp.label} ${view}: ${baseline}px; own scope start unchanged; no 15-second expiry` })
      })
    }

    test('list scopes stay independent and never replace titles or own presence', async ({ page }) => {
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.evaluate(() => (window as unknown as { __demoClient: { stopAnimation(): void } }).__demoClient.stopAnimation())
      await page.locator('[data-nav="rooms"]').click()
      const bar = page.getByTestId('sidebar-header')
      const height = await bar.evaluate(el => el.getBoundingClientRect().height)
      await page.evaluate(() => {
        const w = window as W
        w.__owners = [w.__connectionStore!.getState().beginUpdate(['rooms'])]
      })
      await expect(bar.getByTestId('update-icon')).toBeVisible({ timeout: 3500 })
      await expect(bar.locator('h1')).toHaveText('Rooms')
      expect(await bar.evaluate(el => el.getBoundingClientRect().height)).toBe(height)
      await shot(page, `${vp.label}-scoped-list`)
      await page.locator('[data-nav="messages"]').click()
      await expect(bar.getByTestId('update-icon')).toHaveCount(0)
      await page.getByTestId('sidebar-pane').getByText('Emma Wilson', { exact: true }).first().click()
      await expect(page.locator('header').last().getByTestId('update-icon')).toHaveCount(0)
      await expect(page.getByTestId('connection-step')).toHaveCount(0)
      await page.evaluate(() => (window as W).__owners!.shift()!())
      // FLM-171 F1: returning to a completed list, including via Contacts,
      // must not turn its historical snapshot into a new completion event.
      if (vp.label === 'iphone') await page.getByRole('button', { name: /back/i }).first().click()
      await page.locator('[data-nav="rooms"]').click()
      await expect(bar.getByTestId('update-announcement')).toHaveText('')
      await page.locator('[data-nav="contacts"]').click()
      await expect(bar.getByTestId('update-announcement')).toHaveText('')
      await page.locator('[data-nav="rooms"]').click()
      await expect(bar.getByTestId('update-announcement')).toHaveText('')
    })

    test('list title shows the step on narrow screens only', async ({ page }) => {
      await bootDemo(page, '/demo.html?tutorial=false')
      await page.locator('[data-nav="messages"]').click()
      const title = page.getByTestId('sidebar-pane').locator('h1')
      await expect(title).toBeVisible()
      // The h1 line box may differ (12px step vs title); the fixed-height bar around it must not.
      const bar = page.getByTestId('sidebar-header')
      const before = await bar.evaluate((el) => el.getBoundingClientRect().height)
      await setConnection(page, 'connecting')
      await page.waitForTimeout(GRACE_MS + 300)
      const step = bar.getByTestId('connection-step')
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
