import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, type Page } from '@playwright/test'
import type { DemoClient } from '@fluux/sdk/demo'
import type { FileAttachment, LinkPreview } from '@fluux/sdk'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'

// FLM-347: a right-click on a message opens Fluux's message menu at the pointer. The browser
// integration test proves the menu in both engines; the native menu is covered by the Mac check.
const PEER = 'emma@fluux.chat'
const SHOTS = process.env.FLUUX_CONTEXT_MENU_SHOTS
const shot = async (page: Page, name: string, engine: string) => {
  if (!SHOTS) return
  mkdirSync(SHOTS, { recursive: true })
  await page.screenshot({ path: join(SHOTS, `${engine}-${name}.png`) })
}

async function setup(page: Page, bodies: { id: string; from: string; body: string; attachment?: FileAttachment; linkPreview?: LinkPreview }[]) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, '/demo.html?tutorial=false')
  await page.evaluate(() => (window as unknown as { __demoClient: DemoClient }).__demoClient.stopAnimation())
  await activateChat(page, PEER)
  await page.evaluate(({ bodies, peer }) => {
    const scope = window as unknown as { __demoClient: DemoClient }
    let t = Date.now() + 1000
    for (const m of bodies) {
      scope.__demoClient.emitSDK('chat:message', { message: {
        type: 'chat', id: m.id, conversationId: peer, from: m.from === 'me' ? 'you@fluux.chat' : peer, body: m.body,
        stanzaId: undefined, originId: undefined, timestamp: new Date(t++), isOutgoing: m.from === 'me',
        ...(m.attachment && { attachment: m.attachment }),
        ...(m.linkPreview && { linkPreview: m.linkPreview }),
      }, isLiveArrival: true })
    }
  }, { bodies, peer: PEER })
  await page.keyboard.press('End')
  // Arriving rows re-lay the list out and scroll it, which rightly dismisses an open menu; start from a still list.
  const last = page.locator(`[data-message-id="${bodies[bodies.length - 1].id}"][data-message-body]`)
  await expect(last).toBeVisible()
  let previous = ''
  await expect.poll(async () => { const now = JSON.stringify(await last.boundingBox()); const same = now === previous; previous = now; await page.waitForTimeout(250); return same }).toBe(true)
}
const row = (page: Page, id: string) => page.locator(`[data-message-id="${id}"][data-message-body]`)
const menu = (page: Page) => page.getByRole('menu', { name: 'More options' })

test.describe('message right-click menu', () => {
  test('opens at the pointer with reactions first, and closes with focus and view reset', async ({ page, browserName }) => {
    await setup(page, [{ id: 'ctx-a', from: 'peer', body: 'First message with some words' }, { id: 'ctx-z', from: 'peer', body: 'A later message' }])
    const body = row(page, 'ctx-a')
    await expect(body).toBeVisible()
    const textBox = (await body.getByText('First message with some words').boundingBox())!
    const at = { x: textBox.x + 40, y: textBox.y + textBox.height / 2 }
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    const m = (await menu(page).boundingBox())!
    expect(Math.abs(m.x - at.x)).toBeLessThan(260)
    const labels = await menu(page).getByRole('button').evaluateAll(els => els.map(e => e.getAttribute('aria-label') ?? e.textContent?.trim()))
    expect(labels.slice(0, 4)).toEqual(['React with 👍', 'React with ❤️', 'React with 😂', 'More reactions'])
    expect(labels).toContain('Reply')
    // Right-click selects the word under the pointer in some engines; the menu opens over no selection.
    expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('')
    await expect(menu(page).getByRole('button', { name: 'Copy', exact: true })).toHaveCount(0)
    await shot(page, 'menu', browserName)

    // The emoji picker is a second view; Escape and an outside click close the menu, which reopens on the actions.
    await menu(page).getByRole('button', { name: 'More reactions' }).click()
    await expect(menu(page).getByRole('button', { name: 'Reply' })).toHaveCount(0)
    // The picker is lazy: wait for its real search field and emoji grid, not the empty loading strip.
    const picker = menu(page).locator('em-emoji-picker')
    await expect(picker.locator('input[type="search"]')).toBeVisible()
    await expect(picker.locator('button[aria-label]').first()).toBeVisible()
    expect((await picker.boundingBox())!.height).toBeGreaterThan(200)
    await expect.poll(() => picker.evaluate(el => el.shadowRoot?.activeElement?.tagName), { timeout: 10_000 }).toBe('INPUT')
    await shot(page, 'picker', browserName)
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await page.mouse.click(at.x, at.y, { button: 'right' })
    await expect(menu(page).getByRole('button', { name: 'Reply' })).toBeVisible()
    await page.mouse.click(5, 5)
    await expect(menu(page)).toHaveCount(0)
  })

  test('Copy over a selection spanning two senders matches the keyboard copy', async ({ page, browserName }) => {
    await setup(page, [
      { id: 'sel-a', from: 'peer', body: 'Alpha line from Emma' },
      { id: 'sel-b', from: 'me', body: 'Bravo line from me' },
    ])
    const a = row(page, 'sel-a'); const b = row(page, 'sel-b')
    await expect(b).toBeVisible()
    await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-message-id="sel-a"][data-message-body], [data-message-id="sel-b"][data-message-body]')]
      const range = document.createRange()
      range.setStartBefore(rows[0]); range.setEndAfter(rows[1])
      const sel = window.getSelection()!
      sel.removeAllRanges(); sel.addRange(range)
      ;(window as unknown as { __copied: string[] }).__copied = []
      document.addEventListener('copy', e => (window as unknown as { __copied: string[] }).__copied.push(e.clipboardData?.getData('text/plain') || `<empty ${e.defaultPrevented}>`))
    })
    const box = (await b.getByText('Bravo line from me').boundingBox())!
    // The browser's own copy command fires the same copy event as the shortcut, in every engine.
    await page.evaluate(() => document.execCommand('copy'))
    const baseline = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.length)
    await page.mouse.move(box.x + 20, box.y + 5)
    await page.evaluate(() => { /* keep selection */ })
    await page.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' })
    await expect(menu(page).getByRole('button', { name: 'Copy', exact: true })).toBeVisible()
    await shot(page, 'selection', browserName)
    await menu(page).getByRole('button', { name: 'Copy', exact: true }).click()
    const copied = await page.evaluate(() => (window as unknown as { __copied: string[] }).__copied)
    // The menu's Copy must produce its own copy event after the baseline. WebKit fires no event for a
    // scripted copy command, so its baseline is empty and only the menu copy is checked, for shape.
    expect(copied.length).toBeGreaterThan(baseline)
    const menuCopy = copied[copied.length - 1]
    if (baseline > 0) expect(menuCopy).toBe(copied[0])
    expect(menuCopy).toContain('Alpha line from Emma')
    expect(menuCopy).toContain('Bravo line from me')
    expect(menuCopy).toMatch(/^— .+ —\nEmma Wilson .+\nAlpha line from Emma\nyou .+\nBravo line from me$/) // dated sender headers from the list formatter
    await expect(a).toBeVisible()
  })

  test('a long link chooser scrolls inside a short window without closing the menu', async ({ page, browserName }) => {
    const links = Array.from({ length: 20 }, (_, i) => `https://example.com/page-${i}`)
    await page.setViewportSize({ width: 900, height: 600 })
    await setup(page, [{ id: 'links', from: 'peer', body: `Links ${links.join(' ')}` }])
    const body = row(page, 'links')
    await expect(body).toBeVisible()
    const text = body.getByText(/^Links /)
    await text.click({ button: 'right', position: { x: 10, y: 8 } })
    await menu(page).getByRole('button', { name: 'Copy link' }).click()
    const m = menu(page)
    await expect(m.getByRole('button', { name: links[19] })).toHaveCount(1)
    const dims = await m.evaluate(el => ({ client: el.clientHeight, scroll: el.scrollHeight, viewport: window.innerHeight }))
    expect(dims.scroll).toBeGreaterThan(dims.client)
    expect(dims.client).toBeLessThanOrEqual(dims.viewport)
    await m.evaluate(el => { el.scrollTop = el.scrollHeight })
    await expect(m.getByRole('button', { name: links[19] })).toBeInViewport()
    await expect(m).toBeVisible()
    await shot(page, 'long-chooser', browserName)
  })

  test('Shift + right-click leaves the Fluux menu closed', async ({ page }) => {
    await setup(page, [{ id: 'shift-a', from: 'peer', body: 'Shift click me' }])
    const body = row(page, 'shift-a')
    await expect(body).toBeVisible()
    const prevented = await body.evaluate(el => {
      const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, shiftKey: true, composed: true })
      el.dispatchEvent(e)
      return e.defaultPrevented
    })
    expect(prevented).toBe(false)
    await expect(menu(page)).toHaveCount(0)
  })

  // The emoji picker stops Tab before it bubbles, so the focus trap listens in the capture phase to keep Tab inside the menu.
  test('Tab in the emoji picker moves focus inside it and keeps the menu open', async ({ page }) => {
    await setup(page, [{ id: 'tab-a', from: 'peer', body: 'Tab target message' }])
    const body = row(page, 'tab-a')
    await expect(body).toBeVisible()
    const box = (await body.getByText('Tab target message').boundingBox())!
    await page.mouse.click(box.x + 30, box.y + box.height / 2, { button: 'right' })
    await menu(page).getByRole('button', { name: 'More reactions' }).click()
    const picker = menu(page).locator('em-emoji-picker')
    await expect(picker.locator('input[type="search"]')).toBeVisible()
    await expect(picker.locator('button[aria-label]').first()).toBeVisible()
    const composedActive = () => page.evaluate(() => {
      let a: Element | null = document.activeElement
      while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement
      const m = document.querySelector('[role="menu"]')
      return { tag: a?.tagName ?? '', label: a?.getAttribute('aria-label') ?? '', inMenu: !!m && !!a && m.contains(a.getRootNode() instanceof ShadowRoot ? (a.getRootNode() as ShadowRoot).host : a), menu: !!m }
    })
    // emoji-mart focuses its search field asynchronously after it renders; wait for that instead of reading focus at once.
    await expect.poll(async () => (await composedActive()).tag, { timeout: 10_000 }).toBe('INPUT')
    const before = await composedActive()
    await page.keyboard.press('Tab')
    const afterTab = await composedActive()
    expect(afterTab.menu).toBe(true)
    expect(afterTab.inMenu).toBe(true)
    expect(`${afterTab.tag}:${afterTab.label}`).not.toBe(`${before.tag}:${before.label}`)
  })

  test('a right-click on a link offers that link first, with a single Copy link', async ({ page }) => {
    await setup(page, [{ id: 'lnk-a', from: 'peer', body: 'Docs are at https://example.org/guide today' }])
    const link = row(page, 'lnk-a').getByRole('link', { name: /example\.org\/guide/ })
    await expect(link).toBeVisible()
    const box = (await link.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    const labels = await menu(page).getByRole('button').evaluateAll(els => els.map(e => e.getAttribute('aria-label') ?? e.textContent?.trim()))
    // The link group follows the four reaction controls immediately, and the general Copy link row is suppressed.
    expect(labels.slice(0, 6)).toEqual(['React with 👍', 'React with ❤️', 'React with 😂', 'More reactions', 'Copy link', 'Open in browser'])
    expect(labels.filter(l => l === 'Copy link')).toHaveLength(1)
    expect(labels.indexOf('Copy text')).toBeGreaterThan(5)
  })

  test('a live arrival while the pointer menu is open does not dismiss it', async ({ page }) => {
    await setup(page, [{ id: 'arr-a', from: 'peer', body: 'Hold target message' }])
    const body = row(page, 'arr-a')
    await expect(body).toBeVisible()
    const box = (await body.getByText('Hold target message').boundingBox())!
    await page.mouse.click(box.x + 30, box.y + box.height / 2, { button: 'right' })
    await expect(menu(page)).toBeVisible()
    const m = (await menu(page).boundingBox())!
    await page.mouse.move(m.x + m.width / 2, m.y + m.height / 2)
    await page.evaluate((peer) => {
      const scope = window as unknown as { __demoClient: DemoClient }
      scope.__demoClient.emitSDK('chat:message', { message: {
        type: 'chat', id: 'arr-new', conversationId: peer, from: peer, body: 'A new live message',
        stanzaId: undefined, originId: undefined, timestamp: new Date(Date.now() + 5000), isOutgoing: false,
      }, isLiveArrival: true })
    }, PEER)
    await expect(row(page, 'arr-new')).toBeAttached()
    await page.waitForTimeout(1500)
    await expect(menu(page)).toBeVisible()
    await expect(menu(page).getByRole('button', { name: 'Reply' })).toBeVisible()
  })

  test('the link chooser takes focus on its first link, and Tab moves between links', async ({ page }) => {
    await setup(page, [
      { id: 'two-a', from: 'peer', body: 'Two links https://example.org/one and https://example.org/two here' },
    ])
    const body = row(page, 'two-a')
    await expect(body).toBeVisible()
    const box = (await body.getByText('Two links').boundingBox())!
    await page.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' })
    await menu(page).getByRole('button', { name: 'Copy link' }).click()
    const first = menu(page).getByRole('button', { name: 'https://example.org/one' })
    await expect(first).toBeVisible()
    await expect(menu(page).getByRole('button', { name: 'Reply' })).toHaveCount(0)
    await expect(first).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(menu(page).getByRole('button', { name: 'https://example.org/two' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
  })

  test('a right-click on an image attachment offers Copy image URL and Open in browser right after the reactions', async ({ page }) => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    await setup(page, [{ id: 'img-a', from: 'peer', body: '', attachment: { url: png, name: 'pixel.png', mediaType: 'image/png', width: 240, height: 160 } }])
    const img = page.locator('[data-message-id="img-a"] [data-context-image] img').first()
    await expect(img).toBeVisible()
    // A decoding image re-lays the list out and scrolls it, which rightly dismisses a menu; wait until it is decoded and still.
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
    let last = ''
    await expect.poll(async () => { const now = JSON.stringify(await img.boundingBox()); const same = now === last; last = now; await page.waitForTimeout(250); return same }).toBe(true)
    await img.click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    const labels = await menu(page).getByRole('button').evaluateAll(els => els.map(e => e.getAttribute('aria-label') ?? e.textContent?.trim()))
    expect(labels.slice(0, 4)).toEqual(['React with 👍', 'React with ❤️', 'React with 😂', 'More reactions'])
    expect(labels.slice(4, 7)).toEqual(['Save image', 'Copy image URL', 'Open in browser'])
  })

  test('a right-click on a link-preview thumbnail beside an attachment offers no image actions', async ({ page }) => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    await setup(page, [{
      id: 'thumb-a', from: 'peer', body: 'Look https://example.org/story',
      attachment: { url: png, name: 'pixel.png', mediaType: 'image/png', width: 240, height: 160 },
      linkPreview: { url: 'https://example.org/story', title: 'A story', description: 'Preview text', image: png },
    }])
    const message = page.locator('[data-message-id="thumb-a"]')
    const attachment = message.locator('[data-context-image] img').first()
    await expect(attachment).toBeVisible()
    // The preview's image is shown only after the viewer approves it.
    const show = message.getByRole('button', { name: /show/i })
    if (await show.count()) await show.first().click()
    const thumb = message.locator('a[href="https://example.org/story"] img')
    await expect(thumb).toBeVisible()
    await expect.poll(() => attachment.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth > 0)).toBe(true)
    let last = ''
    await expect.poll(async () => { const now = JSON.stringify(await thumb.boundingBox()); const same = now === last; last = now; await page.waitForTimeout(250); return same }).toBe(true)
    await thumb.click({ button: 'right' })
    await expect(menu(page)).toBeVisible()
    const labels = await menu(page).getByRole('button').evaluateAll(els => els.map(e => e.getAttribute('aria-label') ?? e.textContent?.trim()))
    // The thumbnail is a link target, so the link group shows; the attachment's image group does not.
    expect(labels.slice(4, 6)).toEqual(['Copy link', 'Open in browser'])
    expect(labels).not.toContain('Save image')
    expect(labels).not.toContain('Copy image URL')
  })

  test('a retraction closes the open menu, and a reopened menu starts on the actions with focus inside it', async ({ page }) => {
    await setup(page, [{ id: 'ret-a', from: 'peer', body: 'Soon to be retracted' }, { id: 'ret-b', from: 'peer', body: 'Stays readable' }])
    const open = async (id: string, text: string) => {
      const box = (await row(page, id).getByText(text).boundingBox())!
      await page.mouse.click(box.x + 20, box.y + box.height / 2, { button: 'right' })
      await expect(menu(page)).toBeVisible()
    }
    // Reopening after the picker: the menu starts on the actions, with focus inside it.
    await open('ret-b', 'Stays readable')
    await menu(page).getByRole('button', { name: 'More reactions' }).click()
    await expect(menu(page).locator('em-emoji-picker')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    await open('ret-b', 'Stays readable')
    await expect(menu(page).getByRole('button', { name: 'Forward message' })).toBeVisible()
    await expect(menu(page).locator('em-emoji-picker')).toHaveCount(0)
    await expect.poll(() => page.evaluate(() => document.querySelector('[role="menu"]')?.contains(document.activeElement) ?? false)).toBe(true)
    await page.keyboard.press('Escape')
    await expect(menu(page)).toHaveCount(0)
    // A retraction arriving for the message the menu belongs to takes the menu with it.
    await open('ret-a', 'Soon to be retracted')
    await page.evaluate((peer) => {
      const scope = window as unknown as { __demoClient: DemoClient }
      ;(scope.__demoClient as unknown as { emitSDK: (n: string, d: unknown) => void }).emitSDK('chat:message-updated', {
        conversationId: peer, messageId: 'ret-a', updates: { isRetracted: true, body: '' },
      })
    }, PEER)
    await expect(row(page, 'ret-a').getByText('Soon to be retracted')).toHaveCount(0)
    await expect(menu(page)).toHaveCount(0)
  })
})
