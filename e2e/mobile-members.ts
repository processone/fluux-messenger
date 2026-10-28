import { test, expect, type Locator, type Page } from '@playwright/test'
import type { roomStore } from '@fluux/sdk/stores'
import type { DemoClient } from '@fluux/sdk/demo'
import { bootDemo } from './harness/demoBoot'
import { CLEAR_OF_BOTTOM_PX, wheelAwayFromBottom } from './harness/scrollHarness'

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
    const composer = page.locator('.message-input[contenteditable="true"]')
    await expect(composer).toHaveAttribute('aria-placeholder', 'Message #Team Chat')
    expect(await composer.evaluate((el) => !!el.closest('[inert]'))).toBe(true)
    await longPress(row)
    const whisper = page.getByRole('button', { name: 'Whisper', exact: true })
    await expect(whisper).toBeVisible()
    await row.dispatchEvent('touchend', { touches: [] })
    await whisper.tap()
    await expect(row).toHaveCount(0)
    await expect(composer).toHaveAttribute('aria-placeholder', `Whisper to ${nick}...`)
    await expect(composer).toBeFocused()
    expect(await composer.evaluate((el) => !!el.closest('[inert]'))).toBe(false)
    expect(await composer.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe('none')
    if (browserName === 'webkit') {
      expect(await composer.evaluate((el) => getComputedStyle(el).getPropertyValue('-webkit-touch-callout'))).not.toBe('none')
    }
    await expect(page.locator('input[type="file"]')).toBeEnabled()
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
  await expect(page.locator('.message-input[contenteditable="true"]')).toHaveAttribute('aria-placeholder', `Whisper to ${nick}...`)
})

// The captain's ruling on Escape with an open menu: "Escape closes the menu first". It must not
// also jump the history to the newest message; with no menu open, Escape still does that.
test('desktop Escape closes an open member menu without jumping the history, then jumps once no menu is open', async ({ page }) => {
  const nick = await openRoom(page)
  const list = page.locator('[data-message-list]')
  const distanceFromBottom = () => list.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)
  // Leave the newest message with wheel input, as a reader does. The conversation counts only
  // wheel, touch and keys as a reader's scroll, so a scrollTop written by the test can be undone by
  // its next layout correction: in WebKit on Linux the list was back at the newest message before
  // the menu opened.
  await wheelAwayFromBottom(page, CLEAR_OF_BOTTOM_PX)
  const row = page.locator('.touch-menu-row').filter({ has: page.getByText(nick, { exact: true }) }).last()
  await row.click({ button: 'right' })
  const whisper = page.getByRole('button', { name: 'Whisper', exact: true })
  await expect(whisper).toBeVisible()
  const before = await distanceFromBottom()
  expect(before).toBeGreaterThan(CLEAR_OF_BOTTOM_PX)

  await page.keyboard.press('Escape')
  await expect(whisper).toHaveCount(0)
  // Give a scroll started by the same key press two frames to land before measuring.
  const after = await list.evaluate(el => new Promise<number>(resolve => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(el.scrollHeight - el.scrollTop - el.clientHeight)))
  }))
  expect(Math.abs(after - before)).toBeLessThan(2)

  await page.keyboard.press('Escape')
  await expect.poll(distanceFromBottom).toBeLessThan(2)
})

// The captain's ruling on review R3: with stacked overlays, Escape closes only the one on top.
// The member menu and the sidebar room menu come from the two menu owners; the sidebar menu is
// added at the end of the page, after the help dialog, so "on top" means "opened last".
for (const menu of ['member', 'sidebar room'] as const) {
  test(`desktop Escape closes shortcut help opened over the ${menu} menu, then the menu`, async ({ page }) => {
    const nick = await openRoom(page)
    const item = menu === 'member'
      ? page.getByRole('button', { name: 'Whisper', exact: true })
      : page.getByRole('button', { name: 'Leave room', exact: true })
    if (menu === 'member') {
      await page.locator('.touch-menu-row').filter({ has: page.getByText(nick, { exact: true }) }).last().click({ button: 'right' })
    } else {
      await page.locator('.sidebar-row').filter({ hasText: 'Team Chat' }).first().click({ button: 'right' })
    }
    await expect(item).toBeVisible()
    await page.keyboard.press('Control+?')
    const help = page.getByRole('heading', { name: 'Keyboard Shortcuts', exact: true })
    await expect(help).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(help).toHaveCount(0)
    await expect(item).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(item).toHaveCount(0)
  })
}

async function openImageMenuInLightbox(page: Page) {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => {
    const demo = window as unknown as { __demoClient: DemoClient }
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 400
    const context = canvas.getContext('2d')!
    context.fillStyle = '#5274a0'
    context.fillRect(0, 0, canvas.width, canvas.height)
    const jid = 'emma@fluux.chat'
    demo.__demoClient.emitSDK('chat:message', {
      message: {
        type: 'chat', id: 'escape-stack-image', conversationId: jid,
        stanzaId: undefined, originId: undefined, from: 'you@fluux.chat',
        body: '', isOutgoing: true, timestamp: new Date(),
        attachment: { url: canvas.toDataURL(), name: 'escape-stack.png', mediaType: 'image/png', width: 640, height: 400 },
      },
      isLiveArrival: true,
    })
    location.hash = `#/messages/${encodeURIComponent(jid)}`
  })
  await page.getByRole('img', { name: 'escape-stack.png', exact: true }).click()
  const viewer = page.locator('[data-lightbox="image"]')
  await expect(viewer).toBeVisible()
  await viewer.getByRole('img').click({ button: 'right' })
  const save = page.getByRole('button', { name: 'Save image', exact: true })
  await expect(save).toBeVisible()
  return { viewer, save }
}

test('desktop Escape closes the image menu inside the lightbox, then the lightbox', async ({ page }) => {
  const { viewer, save } = await openImageMenuInLightbox(page)

  await page.keyboard.press('Escape')
  await expect(save).toHaveCount(0)
  await expect(viewer).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
})

// Review R6 under the same ruling. The lightbox is added at the end of the page, so shortcut
// help opened over it is drawn behind it, and the image menu is still the overlay on top.
test('desktop Escape closes the image menu first when shortcut help opens behind the lightbox', async ({ page }) => {
  const { viewer, save } = await openImageMenuInLightbox(page)
  await page.keyboard.press('Control+?')
  const help = page.getByRole('heading', { name: 'Keyboard Shortcuts', exact: true })
  await expect(help).toHaveCount(1)

  await page.keyboard.press('Escape')
  await expect(save).toHaveCount(0)
  await expect(viewer).toBeVisible()
  await expect(help).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(viewer).toHaveCount(0)
  await expect(help).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
})

// Review R5 applies the same ruling to the emoji picker. The picker's own search box keeps
// every key it receives, and its first Escape only leaves the search, so each journey starts
// there.
async function openEmojiPicker(page: Page, button: Locator) {
  await button.click()
  const picker = page.locator('em-emoji-picker')
  await expect(picker).toBeVisible()
  const search = picker.locator('input').first()
  await search.focus()
  await page.keyboard.press('Escape')
  await expect(search).not.toBeFocused()
  await expect(picker).toBeVisible()
  return picker
}

async function openDemoAt(page: Page, hash: string) {
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate((hash) => {
    (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation()
    location.hash = hash
  }, hash)
}

test('desktop Escape closes shortcut help opened over the emoji picker, then the picker', async ({ page }) => {
  await openDemoAt(page, '#/messages/emma%40fluux.chat')
  const picker = await openEmojiPicker(page, page.locator('[class~="[grid-area:emoji]"] > button'))
  await page.keyboard.press('Control+?')
  const help = page.getByRole('heading', { name: 'Keyboard Shortcuts', exact: true })
  await expect(help).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
  await expect(picker).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
})

test('desktop Escape closes the emoji picker in the poll window, then the window', async ({ page }) => {
  // Reduced motion closes a window at once, so a poll window wrongly closed by the picker's
  // Escape is already gone when the picker is. The app follows the system setting, and
  // resets any value written to the page directly.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openDemoAt(page, '#/rooms/team%40conference.fluux.chat')
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced')
  await page.getByRole('button', { name: 'Attach file', exact: true }).click()
  await page.getByRole('button', { name: 'Create Poll', exact: true }).click()
  const poll = page.getByRole('heading', { name: 'Create Poll', exact: true })
  await expect(poll).toBeVisible()
  const picker = await openEmojiPicker(page, page.getByTitle('Click to change emoji', { exact: true }).last())

  await page.keyboard.press('Escape')
  await expect(picker).toHaveCount(0)
  await expect(poll).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(poll).toHaveCount(0)
})

// The encryption setup dialog in Settings opens when this device's key cannot be unlocked.
// The demo's key can always be unlocked, so the test tells its plugin otherwise once the
// page is showing. The page checks again when the signed-in address changes, so the test
// then gives the address a resource. Patching before the page shows would not work: in
// this development build React runs the page's first check twice and the second one skips.
test('desktop Escape closes shortcut help opened over the encryption setup dialog, then backs out of the dialog', async ({ page }) => {
  await openDemoAt(page, '#/settings/encryption')
  const encryption = page.getByRole('switch', { name: 'OpenPGP end-to-end encryption', exact: true })
  await expect(encryption).toHaveAttribute('aria-checked', 'true')
  await page.evaluate(() => {
    const demo = window as unknown as {
      __demoClient: { e2ee: { getPlugin(id: string): unknown } }
      __connectionStore: { getState(): { jid: string }; setState(state: { jid: string }): void }
    }
    const plugin = demo.__demoClient.e2ee.getPlugin('openpgp') as { isKeyRecoveryNeeded?: () => boolean }
    plugin.isKeyRecoveryNeeded = () => true
    const connection = demo.__connectionStore
    connection.setState({ jid: `${connection.getState().jid.split('/')[0]}/e2e` })
  })
  const setup = page.getByRole('heading', { name: 'An OpenPGP identity already exists for this account', exact: true })
  await expect(setup).toBeVisible()
  await page.getByRole('button', { name: /^Replace the published identity/ }).click()
  const confirm = page.getByRole('button', { name: 'Yes, replace identity', exact: true })
  await expect(confirm).toBeVisible()
  await page.keyboard.press('Control+?')
  const help = page.getByRole('heading', { name: 'Keyboard Shortcuts', exact: true })
  await expect(help).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(help).toHaveCount(0)
  await expect(confirm).toBeVisible()
  await expect(encryption).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(confirm).toHaveCount(0)
  await expect(setup).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(setup).toHaveCount(0)
})

test('whisper stages pasted and dropped files, confirms before upload, and restores the room picker on exit', async ({ page }) => {
  const nick = await openRoom(page)
  await page.evaluate(() => {
    const connection = (window as Window & { __connectionStore?: { setState: (value: unknown) => void } }).__connectionStore!
    connection.setState({ httpUploadService: { jid: 'upload.example.test', maxFileSize: 1024 * 1024 } })
  })
  const row = page.locator('.touch-menu-row').filter({ has: page.getByText(nick, { exact: true }) }).last()
  await row.click({ button: 'right' })
  await page.getByRole('button', { name: 'Whisper', exact: true }).click()
  const composer = page.locator('.message-input[contenteditable="true"]')
  await expect(page.locator('input[type="file"]')).toBeEnabled()
  await composer.evaluate(el => {
    const data = new DataTransfer()
    data.items.add(new File(['synthetic'], 'private.pdf', { type: 'application/pdf' }))
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }))
  })
  await expect(page.getByText('private.pdf', { exact: true })).toBeVisible()
  await expect(composer).toHaveAttribute('aria-placeholder', `Whisper to ${nick}...`)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Send a whisper attachment?' })).toBeVisible()
  await expect(page.getByText('The whisper is ephemeral, but files stay on the upload server according to its retention policy. Recipients can download and keep copies.')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click()
  await expect(page.getByRole('heading', { name: 'Send a whisper attachment?' })).toHaveCount(0)
  await expect(composer).toBeFocused()
  await composer.press('Escape')
  await expect(composer).toHaveAttribute('aria-placeholder', 'Message #Team Chat')
  await expect(page.locator('input[type="file"]')).toBeEnabled()
  await page.locator('input[type="file"]').setInputFiles({ name: 'public.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic') })
  await expect(page.getByText('public.txt', { exact: true })).toBeVisible()
})

for (const supportsRetention of [true, false]) {
  test(`whisper uploads privately and reports server retention (advertised=${supportsRetention})`, async ({ page }) => {
    const nick = await openRoom(page)
    const requests: string[] = []
    await page.route('**/upload-fixture/**', async route => {
      requests.push(route.request().method())
      await route.fulfill({ status: 200, body: 'synthetic attachment' })
    })
    await page.evaluate(({ supportsRetention }) => {
      const win = window as Window & { __demoClient?: DemoClient; __connectionStore?: { setState: (value: unknown) => void }; __uploadHints?: unknown[] }
      win.__uploadHints = []
      win.__connectionStore!.setState({ httpUploadService: { jid: 'upload.example.test', maxFileSize: 1024 * 1024, supportsRetention } })
      win.__demoClient!.server.requestUploadSlot = async (_name, _size, _type, options) => {
        win.__uploadHints!.push(options)
        return { putUrl: `${location.origin}/upload-fixture/put`, getUrl: `${location.origin}/upload-fixture/private.pdf`, appliedRetentionSeconds: supportsRetention ? 7200 : undefined }
      }
    }, { supportsRetention })
    const row = page.locator('.touch-menu-row').filter({ has: page.getByText(nick, { exact: true }) }).last()
    await row.click({ button: 'right' })
    await page.getByRole('button', { name: 'Whisper', exact: true }).click()
    await page.locator('input[type="file"]').setInputFiles({ name: 'private.pdf', mimeType: 'application/pdf', buffer: Buffer.from('synthetic attachment') })
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Send a whisper attachment?' })).toBeVisible()
    expect(requests).toEqual([])
    await page.getByRole('button', { name: 'Send private message', exact: true }).click()
    await expect.poll(() => requests).toEqual(['PUT'])
    await expect(page.getByRole('link', { name: /private.pdf/ })).toBeVisible()
    const result = await page.evaluate(() => {
      const win = window as Window & { __roomStore?: typeof roomStore; __uploadHints?: unknown[] }
      const state = win.__roomStore!.getState()
      return { message: state.messages.get(state.activeRoomJid!)!.at(-1), hints: win.__uploadHints }
    })
    expect(result.hints).toEqual([{ suggestedRetentionSeconds: 86400 }])
    expect(result.message).toMatchObject({ isPrivate: true, whisperWith: nick, attachment: { name: 'private.pdf' } })
    await expect(page.getByRole('link', { name: /private.pdf/ })).toBeVisible()
    if (supportsRetention) {
      await expect(page.getByText('Upload server retention: 2 hr. Recipients can download and keep copies.')).toBeVisible()
    } else {
      await expect(page.getByText('The whisper is ephemeral, but files stay on the upload server according to its retention policy. Recipients can download and keep copies.')).toBeVisible()
    }
  })
}
