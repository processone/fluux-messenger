import { test, expect, type Locator, type Page } from '@playwright/test'
import type { roomStore } from '@fluux/sdk/stores'
import type { DemoClient } from '@fluux/sdk/demo'
import { bootDemo } from './harness/demoBoot'

const pageErrors = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const errors: string[] = []
  pageErrors.set(page, errors)
  page.on('pageerror', (error) => {
    // Deferred resize observations are delivered on the next frame.
    // https://drafts.csswg.org/resize-observer/#deliver-resize-loop-error
    if (error.message === 'ResizeObserver loop completed with undelivered notifications.') {
      test.info().annotations.push({ type: 'resize-observer-notice', description: error.message })
    } else {
      errors.push(error.message)
    }
  })
})
test.afterEach(({ page }) => {
  expect(pageErrors.get(page)).toEqual([])
})

async function openRoom(page: Page) {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => {
    (window as Window & { __demoClient?: DemoClient }).__demoClient?.stopAnimation()
  })
  await page.locator('[data-nav="rooms"]').click()
  await page.getByTestId('sidebar-pane').getByText('Team Chat', { exact: true }).click()
  await page.getByRole('button', { name: 'Show members', exact: true }).click()
  return page.evaluate(() => {
    const store = (window as Window & { __roomStore?: typeof roomStore }).__roomStore!
    const state = store.getState()
    const room = state.getRoom(state.activeRoomJid!)!
    return [...room.occupants.values()].find((occupant) => occupant.nick !== room.nickname)!.nick
  })
}

async function expectTouchStyles(row: Locator, browserName: string) {
  await expect(row).toHaveCSS('user-select', 'none')
  if (browserName === 'webkit') {
    if (await row.evaluate(() => CSS.supports('-webkit-touch-callout', 'none'))) {
      await expect(row).toHaveCSS('-webkit-touch-callout', 'none')
    } else {
      test.info().annotations.push({ type: 'engine-limit', description: 'This desktop WebKit build does not implement the iOS touch-callout property.' })
    }
    await expect(row).toHaveCSS('-webkit-user-select', 'none')
  }
  await expect(row.locator('input, textarea')).toHaveCount(0)
}

async function longPress(row: Locator) {
  const box = (await row.boundingBox())!
  const touch = { identifier: 1, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }
  await row.dispatchEvent('touchstart', { touches: [touch], changedTouches: [touch] })
}

test.describe('mobile members', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('long press offers Whisper and returns to the focused private composer', async ({ page, browserName }) => {
    const nick = await openRoom(page)
    const row = page.locator('.touch-menu-row').filter({ has: page.getByText(nick, { exact: true }) }).last()
    await expect(row).toBeVisible()
    expect(await row.evaluate((el) => !!el.closest('[inert], [aria-hidden="true"]'))).toBe(false)
    await expectTouchStyles(row, browserName)
    const composer = page.locator('textarea.message-input')
    await expect(composer).toHaveAttribute('placeholder', 'Message #Team Chat')
    expect(await composer.evaluate((el) => !!el.closest('[inert]'))).toBe(true)
    await longPress(row)
    const whisper = page.getByRole('button', { name: 'Whisper', exact: true })
    await expect(whisper).toBeVisible()
    await row.dispatchEvent('touchend', { touches: [] })
    await whisper.tap()
    await expect(row).toHaveCount(0)
    await expect(composer).toHaveAttribute('placeholder', `Whisper to ${nick}...`)
    await expect(composer).toBeFocused()
    expect(await composer.evaluate((el) => !!el.closest('[inert]'))).toBe(false)
    expect(await composer.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe('none')
    if (browserName === 'webkit') {
      expect(await composer.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-touch-callout'))).not.toBe('none')
    }
    await expect(page.getByText('Files cannot be sent in private room messages.', { exact: true })).toBeVisible()
    await expect(page.locator('input[type="file"]')).toBeDisabled()
    await page.screenshot({ path: test.info().outputPath('mobile-whisper.png') })
  })

  test('conversation and room long-press rows suppress native selection', async ({ page, browserName }) => {
    await bootDemo(page, '/demo.html?tutorial=false')
    const conversation = page.locator('.sidebar-row').filter({ hasText: 'Emma Wilson' }).first()
    await expectTouchStyles(conversation, browserName)
    await longPress(conversation)
    await expect(page.getByRole('button', { name: 'Archive', exact: true })).toBeVisible()
    await conversation.dispatchEvent('touchend', { touches: [] })
    await page.keyboard.press('Escape')
    await page.locator('[data-nav="rooms"]').click()
    const room = page.locator('.sidebar-row').filter({ hasText: 'Team Chat' }).first()
    await expectTouchStyles(room, browserName)
    await longPress(room)
    await expect(page.getByRole('button', { name: 'Leave room', exact: true })).toBeVisible()
    await room.dispatchEvent('touchend', { touches: [] })
    await page.screenshot({ path: test.info().outputPath('mobile-room-menu.png') })
  })
})

test('desktop Whisper keeps the inline member panel open', async ({ page }) => {
  const nick = await openRoom(page)
  const row = page.locator('.touch-menu-row').filter({ has: page.getByText(nick, { exact: true }) }).last()
  await row.click({ button: 'right' })
  await page.getByRole('button', { name: 'Whisper', exact: true }).click()
  await expect(row).toBeVisible()
  await expect(page.locator('textarea.message-input')).toHaveAttribute('placeholder', `Whisper to ${nick}...`)
})

test('whisper rejects pasted and dropped files and restores the room picker on exit', async ({ page }) => {
  const nick = await openRoom(page)
  await page.evaluate(() => {
    const connection = (window as Window & { __connectionStore?: { setState: (value: unknown) => void } }).__connectionStore!
    connection.setState({ httpUploadService: { jid: 'upload.example.test', maxFileSize: 1024 * 1024 } })
  })
  const row = page.locator('.touch-menu-row').filter({ has: page.getByText(nick, { exact: true }) }).last()
  await row.click({ button: 'right' })
  await page.getByRole('button', { name: 'Whisper', exact: true }).click()
  const composer = page.locator('textarea.message-input')
  await expect(page.getByText('Files cannot be sent in private room messages.', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Attach file', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Attach file', exact: true }).last()).toBeDisabled()
  await page.getByRole('button', { name: 'Attach file', exact: true }).first().click()
  await composer.evaluate(el => {
    const data = new DataTransfer()
    data.items.add(new File(['synthetic'], 'private.png', { type: 'image/png' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(page.getByText('private.png', { exact: true })).toHaveCount(0)
  await expect(composer).toHaveAttribute('placeholder', `Whisper to ${nick}...`)
  await expect(page.getByText('Files cannot be sent in private room messages.', { exact: true }).first()).toBeVisible()
  await composer.press('Escape')
  await expect(composer).toHaveAttribute('placeholder', 'Message #Team Chat')
  await expect(page.locator('input[type="file"]')).toBeEnabled()
  await page.locator('input[type="file"]').setInputFiles({ name: 'public.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') })
  await expect(page.getByText('public.txt', { exact: true })).toBeVisible()
})
