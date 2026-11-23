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
const LONG_NAME = 'Alexandria Montgomery-Featherstonehaugh the Third'
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

  test('opening focus cannot steal status message input on the next frame', async ({ page }) => {
    await page.clock.install()
    await boot(page)
    const menu = page.getByRole('menu')
    await row(page).click()
    await menu.getByRole('menuitemradio', { name: 'Away' }).click()
    await expect(row(page)).toContainText('Away')

    // Recreate the WebKit shard failure: the second open and field focus happen
    // before the next frame, which must not move focus back to the presence item.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000))
    await row(page).press('Enter')
    const away = menu.getByRole('menuitemradio', { name: 'Away', checked: true })
    const openedOnAway = await away.evaluate(el => el === document.activeElement)
    const status = menu.getByLabel('Status Message')
    await status.focus()
    await page.clock.runFor(32)
    const keptFocus = await status.evaluate(el => el === document.activeElement)
    await page.keyboard.insertText('In a meeting')
    const typed = await status.inputValue()
    await page.clock.resume()
    await menu.getByRole('button', { name: 'Save' }).click()
    await expect(menu).toHaveCount(0)
    const displayed = await row(page).innerText()
    await shot(page, 'status-after-fast-open')
    expect({ openedOnAway, keptFocus, typed, displayed }).toEqual({
      openedOnAway: true,
      keptFocus: true,
      typed: 'In a meeting',
      displayed: expect.stringContaining('In a meeting'),
    })

    await row(page).click()
    await expect(status).toHaveValue('In a meeting')
  })

  test('a long name and a long status end in ellipses inside the sidebar and hover discloses both in full', async ({ page }) => {
    await boot(page, 200)
    await page.evaluate(n => (window as unknown as { __connectionStore: { getState(): { setOwnNickname(n: string): void } } }).__connectionStore.getState().setOwnNickname(n), LONG_NAME)
    await expect(row(page)).toContainText('Alexandria')
    await row(page).click()
    await page.getByRole('menu').getByLabel('Status Message').fill(LONG_STATUS)
    await page.getByRole('menu').getByRole('button', { name: 'Save' }).click()
    await expect(row(page)).toContainText('Out of office')
    const geo = await row(page).evaluate(el => {
      const pane = el.closest('[data-testid="sidebar-pane"]')!.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      const line = [...el.querySelectorAll('span.truncate')].find(s => s.textContent?.startsWith('Out of office')) as HTMLElement
      const nameEl = [...el.querySelectorAll('span.truncate')].find(s => s.textContent?.startsWith('Alexandria')) as HTMLElement
      const chevron = el.querySelector('svg:last-of-type')!.getBoundingClientRect()
      const ends = (n: HTMLElement) => ({ truncated: n.scrollWidth > n.clientWidth, overflow: getComputedStyle(n).textOverflow })
      return { rowRight: r.right, paneRight: pane.right, chevronRight: chevron.right, status: ends(line), name: ends(nameEl) }
    })
    expect(geo.rowRight).toBeLessThanOrEqual(geo.paneRight)
    expect(geo.chevronRight).toBeLessThanOrEqual(geo.rowRight)
    expect(geo.status).toEqual({ truncated: true, overflow: 'ellipsis' })
    expect(geo.name).toEqual({ truncated: true, overflow: 'ellipsis' })
    await row(page).hover()
    const tip = page.getByRole('tooltip')
    await expect(tip).toContainText(LONG_STATUS, { timeout: 3000 })
    await expect(tip).toContainText(LONG_NAME)
    await expect(row(page)).toHaveAccessibleName(new RegExp(`${LONG_NAME}, ${LONG_STATUS}`))
    await shot(page, 'desktop-long-status-tooltip')
  })

  test('Tab order is composer, account row, sidebar list; Shift+Tab reverses; Enter, arrows, Escape and Alt+Y work', async ({ page }) => {
    await boot(page)
    await page.locator('[data-nav="messages"]').click()
    await page.getByTestId('sidebar-pane').getByText('Emma Wilson', { exact: true }).first().click()
    const composer = page.getByPlaceholder('Message Emma Wilson', { exact: true })
    const sidebarList = page.getByTestId('sidebar-pane').locator('.focus-zone')
    await composer.click()
    await expect(composer).toBeFocused()
    // Tab from the composer lands on the account row, the fourth area.
    await page.keyboard.press('Tab')
    await expect(row(page)).toBeFocused()
    // The next Tab wraps to the sidebar list; Shift+Tab from there returns to the row.
    await page.keyboard.press('Tab')
    await expect(sidebarList).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect(row(page)).toBeFocused()
    // Shift+Tab from the row goes back to the composer.
    await page.keyboard.press('Shift+Tab')
    await expect(composer).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(row(page)).toBeFocused()

    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: 'Online' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitemradio', { name: 'Away' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(row(page)).toBeFocused()

    // Alt+Y from the message list opens the menu.
    await page.locator('[data-message-id]').first().click()
    await expect(row(page)).not.toBeFocused()
    await page.keyboard.press('Alt+y')
    await expect(page.getByRole('menu')).toBeVisible()
    await expect(page.getByRole('menu').getByRole('menuitemradio', { name: 'Online' })).toBeFocused()
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

    // A brief drop that recovers inside the grace window never flashes anything.
    await setConnection(page, 'reconnecting', 1, 30_000)
    await page.waitForTimeout(GRACE_MS - 1200)
    await setConnection(page, 'online')
    await page.waitForTimeout(GRACE_MS)
    await expect(row(page)).toContainText('Online')
    await expect(row(page).locator('.animate-spin')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Cancel reconnection' })).toHaveCount(0)
    await check('brief-drop-recovered')

    // A real outage: within the grace window nothing changes.
    await page.evaluate(() => {
      const w = window as unknown as { __cancelCalls: number; __demoClient: { cancelReconnect: () => void } }
      w.__cancelCalls = 0
      w.__demoClient.cancelReconnect = () => { w.__cancelCalls++ }
    })
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
    await expect(menu.getByLabel('Status Message')).toBeDisabled()
    await expect(menu.getByRole('button', { name: 'Save' })).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: /log out/i })).toBeEnabled()
    await shot(page, 'desktop-reconnecting-menu')
    await page.keyboard.press('Escape')
    await check('reconnecting-menu-closed')
    const cancel = page.getByRole('button', { name: 'Cancel reconnection' })
    await expect(cancel).toBeVisible()
    await check('reconnecting-with-cancel')
    await cancel.click()
    expect(await page.evaluate(() => (window as unknown as { __cancelCalls: number }).__cancelCalls)).toBe(1)

    await setConnection(page, 'verifying')
    await expect(row(page)).toContainText('Verifying')
    await check('verifying')

    await setConnection(page, 'online')
    await expect(row(page)).toContainText('Online')
    await expect(cancel).toHaveCount(0)
    await check('recovered')

    await page.evaluate(() => (window as W).__eventsStore!.getState().addSystemNotification('auth-error', 'Sign-in expired', 'Sign in again'))
    await expect(row(page)).toContainText('Sign-in expired')
    await check('sign-in-alert')
    await expect(row(page)).toHaveAccessibleName(/Sign-in expired/)
    await shot(page, 'desktop-alert')
    info.annotations.push({ type: 'row-height', description: heights.join(' ') })
  })

  test('a connection error replaces the sidebar with the login screen, so the row never shows it', async ({ page }) => {
    await boot(page)
    await expect(row(page)).toBeVisible()
    await setConnection(page, 'error')
    await expect(row(page)).toHaveCount(0)
    await expect(page.getByTestId('sidebar-pane')).toHaveCount(0)
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

test.describe('account row (short phone viewport)', () => {
  test.use({ viewport: { width: 390, height: 420 }, hasTouch: true, isMobile: true })

  test('the sheet stays inside the viewport, scrolls, and every item is reachable', async ({ page }) => {
    await boot(page)
    expect(await rowHeight(page)).toBe(48)
    await row(page).tap()
    const sheet = page.getByRole('dialog')
    await expect(sheet).toBeVisible()
    await page.waitForTimeout(600)
    const geo = await sheet.evaluate(el => {
      const scroller = [...el.querySelectorAll<HTMLElement>('div')].find(d => getComputedStyle(d).overflowY === 'auto')!
      const r = el.getBoundingClientRect()
      return { top: r.top, bottom: r.bottom, scrolls: scroller.scrollHeight > scroller.clientHeight }
    })
    expect(geo.top).toBeGreaterThanOrEqual(0)
    expect(geo.bottom).toBeLessThanOrEqual(420)
    expect(geo.scrolls).toBe(true)
    await shot(page, 'phone-short-sheet')
    // Log out, the last item, is reachable by scrolling and by keyboard.
    const logout = sheet.getByRole('menuitem', { name: /log out/i })
    await logout.scrollIntoViewIfNeeded()
    await expect(logout).toBeInViewport()
    await sheet.getByRole('menuitemradio', { name: 'Online' }).focus()
    await page.keyboard.press('Shift+Tab')
    await expect(logout).toBeFocused()
    await expect(logout).toBeInViewport()
  })
})
