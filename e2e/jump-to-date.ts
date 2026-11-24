import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { bootDemo } from './harness/demoBoot'
import { activateChat, navigateToStressRoom, settle } from './harness/scrollHarness'

// Approved day-pill plan: exercise the real picker and timeline, with the existing
// disposable demo histories. These browser checks do not qualify native phone pickers.
type Kind = 'chat' | 'room'
test.use({ colorScheme: 'dark' })
const thread = (page: Page) => page.locator('[data-conversation-thread]:not([inert])')
const actions = (page: Page) => thread(page).locator('[data-header-overflow-trigger]')
const list = (page: Page) => thread(page).locator('[data-message-list]')
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Jump to date', exact: true })
const separator = (page: Page) => thread(page).locator('[data-date-separator] [data-date-pill]').first()
const floating = (page: Page) => thread(page).locator('[data-floating-date] [data-date-pill]')

async function setup(page: Page, kind: Kind) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, '/demo.html?tutorial=false&virt=1')
  await page.evaluate(() => {
    const scope = window as unknown as { __demoClient: { stopAnimation(): void }; __toastStore: { setState(value: { toasts: never[] }): void } }
    scope.__demoClient.stopAnimation()
    scope.__toastStore.setState({ toasts: [] })
  })
  if (kind === 'chat') await activateChat(page, 'emma@fluux.chat')
  else await navigateToStressRoom(page, true, 'team@conference.fluux.chat')
  await list(page).evaluate(el => { el.scrollTop = 0 })
  await settle(page)
  // Initial inactive-conversation notices can be queued during activation; dismiss them
  // after activation settles so a touch intended for the timeline cannot open another chat.
  await page.evaluate(() => (window as unknown as { __toastStore: { setState(value: { toasts: never[] }): void } }).__toastStore.setState({ toasts: [] }))
  await expect(page.locator('[data-toast-stack]')).toHaveCount(0)
}

async function shot(page: Page, name: string) {
  const folder = process.env.FLUUX_DATE_SHOTS
  if (!folder) return
  mkdirSync(folder, { recursive: true })
  await page.screenshot({ path: join(folder, `${name}.png`), animations: 'disabled' })
}

async function pickerReady(page: Page) {
  await expect(dialog(page)).toBeVisible()
  // Measure settled hit targets, not the panel's temporary enter-animation scale.
  await dialog(page).evaluate(async el => { await Promise.all(el.getAnimations().map(animation => animation.finished)) })
}

async function openMenu(page: Page) {
  await actions(page).click()
  await page.getByRole('menuitem', { name: 'Jump to date', exact: true })
    .or(page.getByRole('button', { name: 'Jump to date', exact: true })).click()
  await pickerReady(page)
}

async function showFloating(page: Page) {
  await list(page).evaluate(el => {
    el.scrollTop = Math.min(300, el.scrollHeight - el.clientHeight - 150)
    el.dispatchEvent(new Event('scroll'))
  })
  await expect(thread(page).locator('[data-floating-date]')).toHaveAttribute('aria-hidden', 'false')
  await settle(page)
}

for (const kind of ['chat', 'room'] as const) {
  test(`${kind}: separator, floating pill and menu keep their date and keyboard focus`, async ({ page, browserName }) => {
    await setup(page, kind)
    const day = await separator(page).evaluate(el => el.closest<HTMLElement>('[data-date-separator]')!.dataset.dateSeparator!)
    const top = await list(page).evaluate(el => el.scrollTop)
    await separator(page).focus()
    await expect(separator(page)).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(separator(page).locator('svg')).toHaveAttribute('aria-hidden', 'true')
    await shot(page, `after-${browserName}-${kind}-separator`)
    await page.keyboard.press('Enter')
    await expect(dialog(page).getByLabel('Date', { exact: true })).toHaveValue(day)
    await expect(dialog(page).getByLabel('Date', { exact: true })).toBeFocused()
    // Native date inputs have internal segments; the trap still treats the input as one tab stop.
    await page.keyboard.press('Shift+Tab')
    await expect(dialog(page).getByRole('button', { name: 'A year ago', exact: true })).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(dialog(page).getByLabel('Date', { exact: true })).toBeFocused()
    await shot(page, `after-${browserName}-${kind}-picker`)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(separator(page)).toBeFocused()
    expect(await list(page).evaluate(el => el.scrollTop)).toBe(top)

    await showFloating(page)
    const label = await floating(page).getAttribute('aria-label')
    await floating(page).focus()
    await shot(page, `after-${browserName}-${kind}-floating`)
    await page.keyboard.press('Space')
    await expect(dialog(page)).toBeVisible()
    expect(label).toContain('Jump to date')
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(floating(page)).toBeFocused()
    await openMenu(page)
    const today = await page.evaluate(() => {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    })
    await expect(dialog(page).getByLabel('Date', { exact: true })).toHaveValue(today)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(actions(page)).toBeFocused()
  })

  test(`${kind}: disappearing pills leave focus on conversation actions`, async ({ page }) => {
    await setup(page, kind)
    await separator(page).click()
    await expect(dialog(page)).toBeVisible()
    await list(page).evaluate(el => { el.scrollTop = 300; el.dispatchEvent(new Event('scroll')) })
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(actions(page)).toBeFocused()

    await showFloating(page)
    await floating(page).focus()
    await list(page).evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
    const overlay = thread(page).locator('[data-floating-date]')
    await expect(overlay).toHaveAttribute('aria-hidden', 'true')
    await expect(overlay).toHaveAttribute('inert')
    await expect(actions(page)).toBeFocused()
    await expect(floating(page)).toHaveAttribute('tabindex', '-1')
    // With no visible date pill, the existing menu still opens the same picker.
    await openMenu(page)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(actions(page)).toBeFocused()
  })

  test(`${kind}: touch controls fit 320 and 390 pixel screens`, async ({ browser, browserName }) => {
    for (const width of [320, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark' })
      try {
        const page = await context.newPage()
        await setup(page, kind)
        const pillBox = (await separator(page).boundingBox())!
        expect(pillBox.width).toBeGreaterThanOrEqual(44)
        expect(pillBox.height).toBeGreaterThanOrEqual(44)
        const row = (await separator(page).locator('..').boundingBox())!
        // Only the compact target is interactive, not the full-width date row.
        expect(pillBox.width).toBeLessThan(row.width)
        await list(page).evaluate(el => {
          el.addEventListener('touchstart', () => { (el as HTMLElement).dataset.outsideTouch = 'true' }, { once: true, passive: true })
        })
        await page.touchscreen.tap(row.x + 4, pillBox.y + pillBox.height / 2)
        await expect(list(page)).toHaveAttribute('data-outside-touch', 'true')
        await expect(dialog(page)).toHaveCount(0)
        if (browserName === 'chromium') {
          const session = await context.newCDPSession(page)
          try {
            await session.send('Input.synthesizeScrollGesture', {
              x: row.x + 4, y: pillBox.y + pillBox.height / 2, yDistance: -150, speed: 400, gestureSourceType: 'touch',
            })
            await expect.poll(() => list(page).evaluate(el => el.scrollTop)).toBeGreaterThan(0)
          } finally { await session.detach() }
          await list(page).evaluate(el => { el.scrollTop = 0 })
          await settle(page)
        }
        await separator(page).tap()
        await pickerReady(page)
        const controls = dialog(page).locator('input, button')
        for (const control of await controls.all()) {
          const box = (await control.boundingBox())!
          expect(box.height).toBeGreaterThanOrEqual(44)
          expect(box.width).toBeGreaterThanOrEqual(44)
          expect(box.x).toBeGreaterThanOrEqual(0)
          expect(box.x + box.width).toBeLessThanOrEqual(width)
          expect(box.y).toBeGreaterThanOrEqual(0)
          expect(box.y + box.height).toBeLessThanOrEqual(844)
        }
        await shot(page, `after-${browserName}-${kind}-touch-${width}-picker`)
        await dialog(page).getByRole('button', { name: 'Close', exact: true }).tap()
        await expect(dialog(page)).toHaveCount(0)
        await expect(separator(page)).toBeFocused()
        await list(page).evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
        await openMenu(page)
        await dialog(page).getByRole('button', { name: 'Close', exact: true }).tap()
        await expect(dialog(page)).toHaveCount(0)
      } finally { await context.close() }
    }
  })

  test(`${kind}: archive errors are announced and a pending dialog does not focus the next conversation`, async ({ page }) => {
    await setup(page, kind)
    // Only the disposable demo archive boundary is held; the real picker, lookup and close guard run.
    await page.evaluate(kind => {
      const scope = window as unknown as { __demoClient: { messages: Record<string, (options: Record<string, unknown>) => Promise<unknown>> } }
      const method = kind === 'chat' ? 'queryMAM' : 'queryRoomMAM'
      const original = scope.__demoClient.messages[method].bind(scope.__demoClient.messages)
      scope.__demoClient.messages[method] = options => options.dateLookup
        ? Promise.reject(new Error('Archive unavailable in isolated demo check')) : original(options)
    }, kind)
    await openMenu(page)
    const value = await dialog(page).getByLabel('Date', { exact: true }).inputValue()
    const absentDay = `${Number(value.slice(0, 4)) - 1}${value.slice(4)}`
    await dialog(page).getByLabel('Date', { exact: true }).fill(absentDay)
    await dialog(page).getByRole('button', { name: 'Go', exact: true }).click()
    await expect(dialog(page).getByRole('alert')).toHaveText('Could not reach the message archive. Try again once you are online.')
    expect(await dialog(page).ariaSnapshot()).toContain('alert: Could not reach the message archive')
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)

    await page.evaluate(kind => {
      const scope = window as unknown as {
        __demoClient: { messages: Record<string, (options: Record<string, unknown>) => Promise<unknown>> }
        __dateRelease?: () => void
        __datePending?: boolean
        __dateActionsFocused: number
      }
      const method = kind === 'chat' ? 'queryMAM' : 'queryRoomMAM'
      const original = scope.__demoClient.messages[method].bind(scope.__demoClient.messages)
      scope.__demoClient.messages[method] = options => {
        if (!options.dateLookup) return original(options)
        scope.__datePending = true
        return new Promise(resolve => { scope.__dateRelease = () => resolve({ messages: [], complete: false }) })
      }
      scope.__dateActionsFocused = 0
      document.addEventListener('focusin', event => {
        if (event.target instanceof HTMLElement && event.target.hasAttribute('data-header-overflow-trigger')) scope.__dateActionsFocused++
      })
    }, kind)
    await openMenu(page)
    await dialog(page).getByLabel('Date', { exact: true }).fill(absentDay)
    await dialog(page).getByRole('button', { name: 'Go', exact: true }).click()
    await page.waitForFunction(() => (window as unknown as { __datePending?: boolean }).__datePending)
    // Ignore focus events from opening the menu: only the conversation switch is under test.
    await page.evaluate(() => { (window as unknown as { __dateActionsFocused: number }).__dateActionsFocused = 0 })
    if (kind === 'chat') await activateChat(page, 'james@fluux.chat')
    else {
      const next = await page.evaluate(() => (window as unknown as { __roomStore: { getState(): { joinedRooms(): { jid: string }[] } } }).__roomStore.getState().joinedRooms().find(room => room.jid !== 'team@conference.fluux.chat')!.jid)
      await navigateToStressRoom(page, true, next)
    }
    await expect(dialog(page)).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __dateActionsFocused: number }).__dateActionsFocused)).toBe(0)
    const messages = thread(page).locator('[data-date-focus-target]')
    await messages.focus()
    await page.evaluate(() => (window as unknown as { __dateRelease: () => void }).__dateRelease())
    await settle(page)
    await expect(messages).toBeFocused()
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test(`${kind}: larger text preserves the reader and completed jumps focus messages`, async ({ page }) => {
    await setup(page, kind)
    await showFloating(page)
    const anchor = await list(page).evaluate(el => {
      const bounds = el.getBoundingClientRect()
      const row = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().top >= bounds.top)
      return { id: row!.dataset.messageId!, top: row!.getBoundingClientRect().top }
    })
    await page.addStyleTag({ content: '[data-date-pill] { font-size: 150% } [data-date-pill] > span { font-size: inherit; white-space: normal }' })
    await settle(page)
    const currentTop = await page.locator(`[data-message-id="${anchor.id}"]`).first().evaluate(el => el.getBoundingClientRect().top)
    expect(Math.abs(currentTop - anchor.top)).toBeLessThanOrEqual(2)
    await openMenu(page)
    const input = dialog(page).getByLabel('Date', { exact: true })
    await input.fill(await page.evaluate(() => {
      const now = new Date()
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    }))
    await dialog(page).getByRole('button', { name: 'Go', exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(thread(page).locator('[data-date-focus-target]')).toBeFocused()
    await settle(page)
    const top = await list(page).evaluate(el => el.scrollTop)
    await settle(page)
    expect(await list(page).evaluate(el => el.scrollTop)).toBe(top)
  })
}
