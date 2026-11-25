import { expect, test, type Page, type Locator } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { bootDemo } from './harness/demoBoot'
import { activateChat, navigateToStressRoom, settle } from './harness/scrollHarness'

// Approved day-pill plan: exercise the real picker and timeline, with the existing
// disposable demo histories. These browser checks do not qualify native phone pickers.
type Kind = 'chat' | 'room'
test.use({ colorScheme: 'dark', timezoneId: 'Europe/Paris' })
const MESSAGE_DAY = '2026-03-02'
const HISTORY_DAY = '2026-03-01'
const ABSENT_DAY = '2024-02-29'
const thread = (page: Page) => page.locator('[data-conversation-thread]:not([inert])')
const actions = (page: Page) => thread(page).locator('[data-header-overflow-trigger]')
const list = (page: Page) => thread(page).locator('[data-message-list]')
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Jump to date', exact: true })
const separator = (page: Page) => thread(page).locator('[data-date-separator] [data-date-pill]').first()
const floating = (page: Page) => thread(page).locator('[data-floating-date] [data-date-pill]')

async function setup(page: Page, kind: Kind) {
  await page.clock.setFixedTime(new Date('2026-03-02T00:30:00Z'))
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

// Traverse the application's real zone route rather than directly focusing a pill.
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 40; step++) {
    if (await target.evaluate(el => el === document.activeElement)) return
    await page.keyboard.press('Tab')
  }
  await expect(target).toBeFocused()
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
    const top = await list(page).evaluate(el => el.scrollTop)
    await tabTo(page, separator(page))
    await expect(separator(page)).toHaveAttribute('aria-haspopup', 'dialog')
    await expect(separator(page).locator('svg')).toHaveAttribute('aria-hidden', 'true')
    await shot(page, `after-${browserName}-${kind}-separator`)
    await page.keyboard.press('Enter')
    await expect(dialog(page).getByLabel('Date', { exact: true })).toHaveValue(HISTORY_DAY)
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

    // Today's first message is known from the demo fixture; park just inside it,
    // not on its separator, so the floating opener has a different day.
    await list(page).evaluate((el, id) => {
      const row = el.querySelector<HTMLElement>(`[data-message-id="${id}"]`)!
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top + 4
      el.dispatchEvent(new Event('scroll'))
    }, kind === 'chat' ? 'demo-emma-1' : 'demo-room-5')
    await expect(thread(page).locator('[data-floating-date]')).toHaveAttribute('aria-hidden', 'false')
    await settle(page)
    const label = await floating(page).getAttribute('aria-label')
    await tabTo(page, floating(page))
    await shot(page, `after-${browserName}-${kind}-floating`)
    await page.clock.setFixedTime(new Date('2026-03-03T00:30:00Z'))
    await page.keyboard.press('Space')
    await expect(dialog(page)).toBeVisible()
    expect(label).toContain('Jump to date')
    await expect(dialog(page).getByLabel('Date', { exact: true })).toHaveValue(MESSAGE_DAY)
    await page.keyboard.press('Escape')
    await expect(dialog(page)).toHaveCount(0)
    await expect(floating(page)).toBeFocused()
    // The menu uses the new today, not either pill's historical day.
    await tabTo(page, actions(page))
    await page.keyboard.press('Space')
    await tabTo(page, page.getByRole('menuitem', { name: 'Jump to date', exact: true }))
    await page.keyboard.press('Enter')
    await pickerReady(page)
    await expect(dialog(page).getByLabel('Date', { exact: true })).toHaveValue('2026-03-03')
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

  test(`${kind}: Tab enters the conversation when the sidebar is hidden`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await setup(page, kind)
    await thread(page).getByRole('button', { name: kind === 'chat' ? 'Back to conversations' : 'Back to rooms', exact: true }).focus()
    await page.keyboard.press('Tab')
    await expect(actions(page)).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(thread(page).locator('[data-date-focus-target]')).toBeFocused()
    await tabTo(page, separator(page))
    await page.keyboard.press('Enter')
    await expect(dialog(page)).toBeVisible()
  })

  test(`${kind}: touch controls fit 320 and 390 pixel screens`, async ({ browser, browserName }) => {
    for (const width of [320, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'dark', timezoneId: 'Europe/Paris' })
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
            const scroller = (await list(page).boundingBox())!
            const x = row.x + 4
            const y = scroller.y + scroller.height * 0.75
            await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
            for (let step = 1; step <= 12; step++) {
              await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - step * 12 }] })
              await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())))
            }
            await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
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
      const scope = window as unknown as { __demoClient: { messages: Record<string, (options: Record<string, unknown>) => Promise<unknown>> }; __dateOriginalArchive?: (options: Record<string, unknown>) => Promise<unknown> }
      const method = kind === 'chat' ? 'queryMAM' : 'queryRoomMAM'
      const original = scope.__demoClient.messages[method].bind(scope.__demoClient.messages)
      scope.__dateOriginalArchive = original
      scope.__demoClient.messages[method] = options => options.dateLookup
        ? Promise.reject(new Error('Archive unavailable in isolated demo check')) : original(options)
    }, kind)
    await openMenu(page)
    const absentDay = ABSENT_DAY
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
        __dateOriginalArchive: (options: Record<string, unknown>) => Promise<unknown>
        __dateArchivePending: number
      }
      const method = kind === 'chat' ? 'queryMAM' : 'queryRoomMAM'
      const original = scope.__dateOriginalArchive
      scope.__dateArchivePending = 0
      const read = (options: Record<string, unknown>) => {
        scope.__dateArchivePending++
        return original(options).finally(() => { scope.__dateArchivePending-- })
      }
      let hold = true
      scope.__demoClient.messages[method] = options => {
        if (!options.dateLookup) return original(options)
        if (!hold) return read(options)
        hold = false
        scope.__datePending = true
        return new Promise((resolve, reject) => { scope.__dateRelease = () => { void read(options).then(resolve, reject) } })
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
    const composer = thread(page).locator('.message-input')
    await composer.focus()
    await settle(page)
    const before = await list(page).evaluate(el => ({ scroll: el.scrollTop, rows: [...el.querySelectorAll<HTMLElement>('[data-message-row-id]')].map(row => row.dataset.messageRowId), selected: el.querySelector<HTMLElement>('.message-highlight')?.dataset.messageId }))
    await page.evaluate(() => (window as unknown as { __dateRelease: () => void }).__dateRelease())
    await page.waitForFunction(() => (window as unknown as { __dateArchivePending: number }).__dateArchivePending === 0)
    await settle(page)
    await expect(composer).toBeFocused()
    expect(await list(page).evaluate(el => ({ scroll: el.scrollTop, rows: [...el.querySelectorAll<HTMLElement>('[data-message-row-id]')].map(row => row.dataset.messageRowId), selected: el.querySelector<HTMLElement>('.message-highlight')?.dataset.messageId }))).toEqual(before)
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  for (const outcome of ['cancel', 'foreground'] as const) {
    test(`${kind}: pending lookup retains focus and respects ${outcome}`, async ({ page }) => {
      await setup(page, kind)
      // Delay the demo archive, then release its real answer rather than inventing a landing row.
      await page.evaluate(kind => {
        const scope = window as unknown as {
          __demoClient: { messages: Record<string, (options: Record<string, unknown>) => Promise<unknown>> }
          __dateRelease: () => void
          __datePending: boolean
          __dateRequests: number
        }
        const method = kind === 'chat' ? 'queryMAM' : 'queryRoomMAM'
        const original = scope.__demoClient.messages[method].bind(scope.__demoClient.messages)
        let hold = true
        scope.__dateRequests = 0
        scope.__demoClient.messages[method] = options => {
          if (!options.dateLookup) return original(options)
          scope.__dateRequests++
          if (!hold) return original(options)
          hold = false
          scope.__datePending = true
          return new Promise((resolve, reject) => { scope.__dateRelease = () => { void original(options).then(resolve, reject) } })
        }
      }, kind)
      await openMenu(page)
      const input = dialog(page).getByLabel('Date', { exact: true })
      await input.fill(ABSENT_DAY)
      await input.press('Enter')
      await page.waitForFunction(() => (window as unknown as { __datePending: boolean }).__datePending)
      await expect(input).toBeFocused()
      await page.keyboard.press('Tab')
      const go = dialog(page).getByRole('button', { name: 'Searching...', exact: true })
      await expect(go).toBeFocused()
      await page.keyboard.press('Enter')
      expect(await page.evaluate(() => (window as unknown as { __dateRequests: number }).__dateRequests)).toBe(1)
      const top = await list(page).evaluate(el => el.scrollTop)
      if (outcome === 'cancel') await page.keyboard.press('Escape')
      else {
        await page.keyboard.press('ControlOrMeta+k')
        await expect(page.getByPlaceholder('Go to...', { exact: true })).toBeFocused()
      }
      await page.evaluate(() => (window as unknown as { __dateRelease: () => void }).__dateRelease())
      await expect(dialog(page)).toHaveCount(0)
      if (outcome === 'cancel') {
        await expect(actions(page)).toBeFocused()
        expect(await list(page).evaluate(el => el.scrollTop)).toBe(top)
      } else {
        await expect(page.getByPlaceholder('Go to...', { exact: true })).toBeFocused()
        await settle(page)
        const landedScroll = await list(page).evaluate(el => el.scrollTop)
        await page.keyboard.press('Escape')
        await expect(page.getByRole('dialog')).toHaveCount(0)
        await expect(thread(page).locator('[data-date-focus-target]')).toBeFocused()
        expect(await list(page).evaluate(el => el.scrollTop)).toBe(landedScroll)
      }
    })
  }

  test(`${kind}: larger text preserves the reader and completed jumps focus messages`, async ({ page }) => {
    await setup(page, kind)
    await showFloating(page)
    const anchor = await list(page).evaluate(el => {
      const bounds = el.getBoundingClientRect()
      const row = [...el.querySelectorAll<HTMLElement>('[data-message-id]')].find(row => row.getBoundingClientRect().top >= bounds.top)
      return { id: row!.dataset.messageId!, top: row!.getBoundingClientRect().top }
    })
    const dateRow = thread(page).locator('[data-date-separator]').first()
    const dateHeight = (await dateRow.boundingBox())!.height
    await page.addStyleTag({ content: '[data-date-pill] { font-size: 200%; line-height: 1.5 } [data-date-pill] > span { font-size: inherit; line-height: inherit; white-space: normal }' })
    await settle(page)
    expect((await dateRow.boundingBox())!.height).toBeGreaterThan(dateHeight)
    const currentTop = await page.locator(`[data-message-id="${anchor.id}"]`).first().evaluate(el => el.getBoundingClientRect().top)
    expect(Math.abs(currentTop - anchor.top)).toBeLessThanOrEqual(2)
    await openMenu(page)
    const input = dialog(page).getByLabel('Date', { exact: true })
    await input.fill(MESSAGE_DAY)
    await page.evaluate(() => {
      const target = document.querySelector<HTMLElement>('[data-conversation-thread]:not([inert]) [data-date-focus-target]')!
      const focus = target.focus.bind(target)
      target.focus = options => {
        const scroller = target.querySelector('[data-message-list]')!
        const before = scroller.scrollTop
        focus(options)
        ;(window as unknown as { __dateFocusScroll: { before: number; after: number } }).__dateFocusScroll = { before, after: scroller.scrollTop }
      }
    })
    // At 01:30 Paris time, Emma's first current-day message is 45 minutes old;
    // the team's first current-day message is its 1.5-hour-old deployment report.
    const expectedId = kind === 'chat' ? 'demo-emma-1' : 'demo-room-5'
    const landed = list(page).locator(`[data-message-row-id][data-message-id="${expectedId}"]`)
    await dialog(page).getByRole('button', { name: 'Go', exact: true }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(landed).toHaveClass(/message-highlight/)
    await expect(thread(page).locator('[data-date-focus-target]')).toBeFocused()
    await settle(page)
    const focusScroll = await page.evaluate(() => (window as unknown as { __dateFocusScroll: { before: number; after: number } }).__dateFocusScroll)
    expect(focusScroll.after).toBe(focusScroll.before)
    await expect(landed).toBeVisible()
    const bounds = (await list(page).boundingBox())!
    const row = (await landed.boundingBox())!
    expect(row.y).toBeGreaterThanOrEqual(bounds.y)
    expect(row.y).toBeLessThan(bounds.y + bounds.height)
  })
}
