/**
 * Sidebar account row (FLM-508 layout B), in the real demo app: one 48 px row that opens one
 * menu, reachable by Tab, Enter and Alt+Y, a bottom sheet on a phone, one height in every
 * connection state, and the full name and displayed status on hover. jsdom has no layout, so
 * geometry and the real focus trap are proven here.
 *
 * Set ACCOUNT_ROW_SHOTS=<dir> to also save screenshots.
 */
import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

const SHOTS = process.env.ACCOUNT_ROW_SHOTS
const GRACE_MS = 2000
const LONG_STATUS = 'Out of office until the end of next week, please leave a message and I will answer'

type W = Window & {
  __connectionStore?: { getState(): { setStatus(s: never): void; setReconnectState(a: number, t: number | null): void; jid: string | null } }
  __eventsStore?: { getState(): { addSystemNotification(type: string, title: string, message: string): void } }
}

async function boot(page: Page, sidebarWidth?: number) {
  if (sidebarWidth) await page.addInitScript(w => localStorage.setItem('sidebar-width', String(w)), sidebarWidth)
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => (window as unknown as { __demoClient: { stopAnimation(): void } }).__demoClient.stopAnimation())
}

async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const row = (page: Page) => page.getByTestId('account-row')
const rowHeight = (page: Page) => row(page).evaluate(el => el.getBoundingClientRect().height)

const setConnection = (page: Page, status: string, attempt = 0, targetInMs: number | null = null) =>
  page.evaluate(([s, a, t]) => {
    const store = (window as W).__connectionStore!.getState()
    const jid = (store.jid ?? 'demo@example.com').split('/')[0]
    sessionStorage.setItem(`xmpp-session:${jid}`, JSON.stringify({ jid, password: 'x', server: 'example.com' }))
    store.setReconnectState(a as number, t === null ? null : Date.now() + (t as number))
    store.setStatus(s as never)
  }, [status, attempt, targetInMs] as const)

test.describe('account row (desktop)', () => {
  test.use({ viewport: { width: 1280, height: 800 } })

  test('one row opens one menu with every former item, and choices apply', async ({ page }) => {
    await boot(page)
    expect(await rowHeight(page)).toBe(48)
    // The bottom block holds exactly one control: no separate three-dot button.
    await expect(row(page).locator('xpath=ancestor::div[contains(@class,"pb-safe-2")]').getByRole('button')).toHaveCount(1)
    await shot(page, 'desktop-row')
    await row(page).click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await shot(page, 'desktop-menu')
    for (const name of ['Online', 'Away', 'Do Not Disturb']) {
      await expect(menu.getByRole('menuitemradio', { name })).toBeVisible()
    }
    await expect(menu.getByLabel('Status Message')).toBeVisible()
    for (const name of ['View profile', "What's New", 'Keyboard Shortcuts', 'Report an Issue', 'About', 'Log out']) {
      await expect(menu.getByRole('menuitem', { name: new RegExp(name, 'i') })).toBeVisible()
    }
    await menu.getByRole('menuitemradio', { name: 'Away' }).click()
    await expect(menu).toHaveCount(0)
    await expect(row(page)).toContainText('Away')
    await row(page).click()
    await page.getByRole('menu').getByLabel('Status Message').fill('In a meeting')
    await page.getByRole('menu').getByRole('button', { name: 'Save' }).click()
    await expect(row(page)).toContainText('In a meeting')
    await row(page).click()
    await page.getByRole('menuitem', { name: /view profile/i }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page).toHaveURL(/settings\/profile/)
  })

  test('a long status ends in an ellipsis inside the sidebar and hover discloses it in full', async ({ page }) => {
    await boot(page, 200)
    await row(page).click()
    await page.getByRole('menu').getByLabel('Status Message').fill(LONG_STATUS)
    await page.getByRole('menu').getByRole('button', { name: 'Save' }).click()
    await expect(row(page)).toContainText('Out of office')
    const geo = await row(page).evaluate(el => {
      const pane = el.closest('[data-testid="sidebar-pane"]')!.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      const line = [...el.querySelectorAll('span.truncate')].find(s => s.textContent?.startsWith('Out of office')) as HTMLElement
      return { rowRight: r.right, paneRight: pane.right, truncated: line.scrollWidth > line.clientWidth, overflow: getComputedStyle(line).textOverflow }
    })
    expect(geo.rowRight).toBeLessThanOrEqual(geo.paneRight)
    expect(geo.truncated).toBe(true)
    expect(geo.overflow).toBe('ellipsis')
    await row(page).hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText(LONG_STATUS, { timeout: 3000 })
    const name = (await row(page).locator('span.truncate').first().textContent())!
    await expect(tip).toContainText(name)
    await expect(row(page)).toHaveAccessibleName(new RegExp(LONG_STATUS))
    await shot(page, 'desktop-long-status-tooltip')
  })

  test('Tab reaches the row, Enter opens the menu, arrows walk it, Escape returns focus, Alt+Y opens it', async ({ page }) => {
    await boot(page)
    await page.locator('[data-nav="messages"]').click()
    await page.getByTestId('sidebar-pane').getByText('Emma Wilson', { exact: true }).first().click()
    const focused = () => page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.getAttribute('role') ?? document.activeElement?.tagName)
    let reached = false
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press('Tab')
      reached = (await focused()) === 'account-row'
    }
    expect(reached).toBe(true)
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: 'Online' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitemradio', { name: 'Away' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(row(page)).toBeFocused()
    // Shift+Tab walks the cycle backwards, back to the composer side.
    await page.keyboard.press('Shift+Tab')
    expect(await focused()).not.toBe('account-row')
    await page.locator('body').click({ position: { x: 700, y: 400 } })
    await page.keyboard.press('Alt+y')
    await expect(page.getByRole('menu')).toBeVisible()
  })

  test('the row keeps 48 px in every connection state and recovery actions stay available', async ({ page }, info) => {
    await boot(page)
    const baseline = await rowHeight(page)
    expect(baseline).toBe(48)
    const heights: string[] = []
    const check = async (label: string) => {
      const h = await rowHeight(page)
      heights.push(`${label}=${h}`)
      expect(h).toBe(baseline)
    }
    await check('online')

    // Within the grace window nothing changes.
    await setConnection(page, 'reconnecting', 2, 30_000)
    await page.waitForTimeout(GRACE_MS - 800)
    await expect(page.getByRole('button', { name: 'Cancel reconnection' })).toHaveCount(0)
    await expect(row(page)).toContainText('Online')

    await expect(row(page)).toContainText(/\d+\s?s/, { timeout: 3000 })
    await check('reconnecting')
    // The hover text is the countdown the row displays.
    await expect(row(page)).toHaveAccessibleName(/\d+\s?s/)
    await shot(page, 'desktop-reconnecting')

    // Recovery actions: presence is disabled, Log out is not.
    await row(page).click()
    const menu = page.getByRole('menu')
    for (const radio of await menu.getByRole('menuitemradio').all()) await expect(radio).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: /log out/i })).toBeEnabled()
    await shot(page, 'desktop-reconnecting-menu')
    await page.keyboard.press('Escape')
    await check('reconnecting-menu-closed')
    const cancel = page.getByRole('button', { name: 'Cancel reconnection' })
    await expect(cancel).toBeVisible()
    await check('reconnecting-with-cancel')

    await setConnection(page, 'verifying')
    await expect(row(page)).toContainText('Verifying')
    await check('verifying')

    // Terminal states (error, disconnected) send the real app to its login screen, so those
    // lines are covered by the component tests, not here.
    await setConnection(page, 'online')
    await expect(row(page)).toContainText('Online')
    await expect(cancel).toHaveCount(0)

    await page.evaluate(() => (window as W).__eventsStore!.getState().addSystemNotification('auth-error', 'Sign-in expired', 'Sign in again'))
    await expect(row(page)).toContainText('Sign-in expired')
    await check('sign-in-alert')
    await expect(row(page)).toHaveAccessibleName(/Sign-in expired/)
    await shot(page, 'desktop-alert')
    info.annotations.push({ type: 'row-height', description: heights.join(' ') })
  })
})

test.describe('account row (phone)', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })

  for (const online of [true, false]) {
    test(`opens a bottom sheet with 44 px rows and Tab wraps once at both ends (${online ? 'online' : 'offline'})`, async ({ page }) => {
      await boot(page)
      if (!online) {
        await setConnection(page, 'reconnecting', 1, 30_000)
        await page.waitForTimeout(GRACE_MS + 300)
      }
      expect(await rowHeight(page)).toBe(48)
      await row(page).tap()
      const sheet = page.getByRole('dialog')
      await expect(sheet).toBeVisible()
      // Let the slide-up animation finish before the picture.
      await page.waitForTimeout(600)
      await shot(page, `phone-sheet-${online ? 'online' : 'offline'}`)
      const rows = await sheet.getByRole('menuitem').evaluateAll(els => els.map(el => el.getBoundingClientRect().height))
      expect(rows.length).toBeGreaterThan(3)
      for (const h of rows) expect(h).toBeGreaterThanOrEqual(44)
      const box = await sheet.boundingBox()
      expect(box!.y + box!.height).toBeGreaterThan(844 - 2)

      const names = () => sheet.evaluate(el => {
        const items = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)')]
        const i = items.indexOf(document.activeElement as HTMLElement)
        return { first: i === 0, last: i === items.length - 1, count: items.length, index: i }
      })
      const lastIndex = (await names()).count - 1
      await sheet.evaluate(el => {
        const items = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled)')]
        items[items.length - 1].focus()
      })
      expect((await names()).last).toBe(true)
      await page.keyboard.press('Tab')
      expect((await names()).index).toBe(0)
      await page.keyboard.press('Shift+Tab')
      expect((await names()).index).toBe(lastIndex)
    })
  }
})
