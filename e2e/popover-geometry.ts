/**
 * Playwright popover-geometry harness.
 *
 * These real-box-model invariants cannot be expressed in jsdom. The suggestion
 * list must remain outside the dialog's scroll tree, stay fully painted within
 * the viewport, and follow its input while the dialog moves. The dialog must
 * remain content-sized whether the list is open or closed (#1281).
 *
 * The last two invariants are counterweights, not restatements: the report asked
 * for a taller dialog, and a dialog sized to hold the list at all times would
 * satisfy every invariant above while standing mostly empty whenever the list is
 * closed. Do not drop them as redundant.
 *
 * Run:
 *   npm run test:popover
 *   npx playwright test --config=e2e/playwright.e2e.config.ts --project=popover-webkit
 */

import { test, expect, type Page, type Locator } from '@playwright/test'
import type { roomStore } from '@fluux/sdk/stores'
import type { DemoClient } from '@fluux/sdk/demo'
import type { useSettingsStore } from '../apps/fluux/src/stores/settingsStore'
import { bootDemo } from './harness/demoBoot'

// ── Constants ─────────────────────────────────────────────────────────────────

const DEMO_URL = '/demo.html?tutorial=false'

test.describe('touch message actions', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  for (const { outgoing, header } of [
    { outgoing: false, header: true },
    { outgoing: false, header: false },
    { outgoing: true, header: true },
    { outgoing: true, header: false },
  ]) {
    test(`opens and dismisses actions for an ${outgoing ? 'outgoing' : 'incoming'} ${header ? 'group header' : 'continuation'} by long press`, async ({ page }) => {
      await bootDemo(page, DEMO_URL)
      await page.evaluate(() => {
        const demo = window as Window & { __demoClient?: { stopAnimation(): void } }
        demo.__demoClient?.stopAnimation()
      })
      await page.getByText('Emma Wilson', { exact: true }).first().click()
      if (outgoing) {
        // The seeded conversation has no consecutive outgoing messages.
        const composer = page.locator('textarea.message-input')
        for (const body of ['Mobile action group start', 'Mobile action continuation']) {
          await composer.fill(body)
          await composer.press('Enter')
          await expect(composer).toHaveValue(`${body}\n`)
          await page.getByRole('button', { name: 'Send', exact: true }).click()
          await expect(composer).toHaveValue('')
        }
        await composer.blur()
      }
      const rows = page.locator('[data-message-id]').filter({
        has: page.locator(`[data-msg-chrome="${header ? 'header' : 'cont'}"]`),
      })
      const own = page.locator('[data-msg-own]')
      const row = (outgoing ? rows.filter({ has: own }) : rows.filter({ hasNot: own })).last()
      const content = row.locator('[data-msg-chrome]')
      await content.scrollIntoViewIfNeeded()
      await expect(content).toBeVisible()
      await expect(row.locator('button[aria-haspopup="dialog"]')).toHaveCount(0)
      const box = (await content.boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width).toBeLessThanOrEqual(390)
      if (!outgoing) {
        const rowBox = (await row.boundingBox())!
        // Only the row's normal 16px edge padding may separate the text column
        // from the viewport edge; the menu must not reserve a second column.
        expect(rowBox.x + rowBox.width - (box.x + box.width)).toBeCloseTo(16, 0)
      }
      await expect(row.locator('[data-message-toolbar]')).toBeHidden()
      const sheet = page.getByRole('dialog', { name: 'More options', exact: true })
      await content.dispatchEvent('touchstart')
      await expect(sheet).toBeVisible()
      await content.dispatchEvent('touchend')
      await expect(sheet.getByRole('button', { name: 'Copy text', exact: true })).toBeVisible()
      await expect(row.locator('[data-msg-chrome]')).toHaveCSS('opacity', '0')
      await expect(sheet.locator('[data-message-preview] [data-msg-chrome]')).toHaveCSS('opacity', '1')
      await page.keyboard.press('Escape')
      await expect(sheet).toBeHidden()
      await content.dispatchEvent('touchstart')
      await expect(sheet).toBeVisible()
      await content.dispatchEvent('touchend')
      await sheet.getByRole('button', { name: 'React with ❤️', exact: true }).tap()
      await expect(sheet).toBeHidden()
      await expect(row).toContainText('❤️')
    })
  }
})

/** Accessible name of the sidebar button that opens the dialog under test. */
const NEW_MESSAGE = 'New message'

/** Sub-pixel slack: engines round fractional box metrics differently. */
const EPSILON = 1

/** The dialog body's own bottom padding (`p-4`), the only gap it may legitimately keep. */
const BODY_PADDING_PX = 16

/** Gap the popover keeps below its input. Must match MENU_TRIGGER_GAP in useAnchoredMenu. */
const TRIGGER_GAP_PX = 4

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The dialog's glass panel, and the scrolling body inside it. */
const panelOf = (page: Page): Locator => page.locator('[data-modal="true"] .fluux-glass')

/** Open the "New message" dialog and return its panel, with the list explicitly closed. */
async function openNewMessageDialog(
  page: Page,
): Promise<Locator> {
  await bootDemo(page, DEMO_URL)
  await page.getByRole('button', { name: NEW_MESSAGE, exact: true }).first().click()
  const panel = panelOf(page)
  await expect(panel).toBeVisible()
  await page.getByRole('heading', { name: NEW_MESSAGE }).click({ force: true })
  await expect(page.getByTestId('contact-suggestions')).toHaveCount(0)
  await panel.evaluate((el) => Promise.all(el.getAnimations().map(animation => animation.finished)))
  return panel
}

/**
 * Open the suggestion list from the helper's explicit blurred state.
 */
async function openSuggestions(page: Page): Promise<Locator> {
  await page.locator('[data-modal="true"] input[type="text"]').first().focus()
  const suggestions = page.getByTestId('contact-suggestions')
  await expect(suggestions).toBeVisible()
  return suggestions
}

/**
 * Every descendant of `root` that both declares a scrolling overflow and actually
 * has content to scroll, named by its class list so a failure says which box.
 */
async function scrollingDescendantsOf(root: Locator): Promise<string[]> {
  return root.evaluate((el) => {
    const scrolling: string[] = []
    for (const node of [el, ...el.querySelectorAll('*')]) {
      const overflowY = getComputedStyle(node).overflowY
      if (overflowY !== 'auto' && overflowY !== 'scroll') continue
      if (node.scrollHeight > node.clientHeight + 1) scrolling.push(node.className.toString())
    }
    return scrolling
  })
}

// ── Invariants ───────────────────────────────────────────────────────────────

test.describe('contact suggestion popover geometry', () => {
  /**
   * The suggestion list may scroll, but the dialog around it must not become a
   * second scroll area.
   */
  test('opens the contact list without nesting a second scroll area', async ({ page }) => {
    const panel = await openNewMessageDialog(page)
    await openSuggestions(page)

    expect(
      await scrollingDescendantsOf(panel),
      'no box inside the dialog may scroll while the suggestion list is open',
    ).toEqual([])
  })

  /**
   * Hit-test the box rather than trusting its rect: a clipped element still
   * reports its full rect, while `elementFromPoint` reports what is painted.
   */
  test('paints the whole contact list, clipped by nothing', async ({ page }) => {
    await openNewMessageDialog(page)
    const suggestions = await openSuggestions(page)

    const painted = await suggestions.evaluate((el) => {
      const box = el.getBoundingClientRect()
      const withinViewport =
        box.top >= 0 && box.left >= 0 &&
        box.bottom <= window.innerHeight && box.right <= window.innerWidth
      // A pixel just inside each vertical edge: the top one is normally safe, the
      // bottom one is where a dialog-clipped list stops being painted.
      const hits = [box.top + 2, box.bottom - 2].map((y) =>
        el.contains(document.elementFromPoint(box.left + box.width / 2, y)),
      )
      return { withinViewport, topEdgePainted: hits[0], bottomEdgePainted: hits[1] }
    })

    expect(painted, 'the suggestion list must be on screen and painted edge to edge').toEqual({
      withinViewport: true,
      topEdgePainted: true,
      bottomEdgePainted: true,
    })
  })

  /**
   * The dialog opens with a 200ms `scale(0.97)` enter animation, and a focused
   * field opens the list immediately — so the popover is placed against an anchor
   * whose box is still moving. Placing it once leaves it misaligned for the rest
   * of the dialog's life. The animation is slowed to 2s so the mid-flight state
   * can be observed rather than raced.
   */
  test('stays anchored while the dialog finishes opening', async ({ page }) => {
    await bootDemo(page, DEMO_URL)
    await page.addStyleTag({
      content: '.modal-panel-in { animation-duration: 2000ms !important; }',
    })
    await page.getByRole('button', { name: NEW_MESSAGE, exact: true }).first().click()
    const panel = panelOf(page)
    await expect(panel).toBeVisible()
    await page.getByRole('heading', { name: NEW_MESSAGE }).click({ force: true })
    await expect(page.getByTestId('contact-suggestions')).toHaveCount(0)
    await openSuggestions(page)

    expect(await panel.evaluate((el) =>
      el.getAnimations().some(animation => animation.playState === 'running'),
    )).toBe(true)
    await page.waitForFunction(() => document.querySelector('.fluux-glass')?.getAnimations().some(
      animation => animation.playState === 'running' && Number(animation.currentTime) >= 1000,
    ))

    // The gap is passed in, not closed over: this body is serialized and evaluated
    // in the page, where module-scope constants do not exist.
    await expect.poll(async () => page.evaluate((gap) => {
      const menu = document.querySelector('[data-testid="contact-suggestions"]')
      const input = document.querySelector('[data-modal="true"] input[type="text"]')
      if (!menu || !input) return null
      const menuBox = menu.getBoundingClientRect()
      const inputBox = input.getBoundingClientRect()
      return Math.max(
        Math.abs(menuBox.left - inputBox.left),
        Math.abs(menuBox.width - inputBox.width),
        Math.abs(menuBox.top - inputBox.bottom - gap),
      )
    }, TRIGGER_GAP_PX)).toBeLessThanOrEqual(EPSILON)
  })

  /**
   * The dialog stays content-sized while the list is closed. Any gap beyond the
   * body padding would reserve layout space for a popover that is not rendered.
   */
  test('reserves no empty space while the list is closed', async ({ page }) => {
    const panel = await openNewMessageDialog(page)

    const slack = await panel.evaluate((el) => {
      const body = [...el.children].find((child) => {
        const overflowY = getComputedStyle(child).overflowY
        return overflowY === 'auto' || overflowY === 'scroll'
      })
      const last = body?.lastElementChild
      // Negative reports a dialog that no longer has the shape this measures,
      // which must fail rather than silently pass.
      if (!body || !last) return -1
      return body.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom
    })

    expect(slack, 'the dialog body must end where its content ends').toBeGreaterThanOrEqual(0)
    expect(
      slack,
      'with the list closed the dialog must be sized on its content, not on the list it may show',
    ).toBeLessThanOrEqual(BODY_PADDING_PX + EPSILON)
  })

  /**
   * The dialog must also come back to that compact size once the list closes, so
   * the first invariant cannot be met by a dialog that grows and stays grown.
   */
  test('returns to its closed height after the list is dismissed', async ({ page }) => {
    const panel = await openNewMessageDialog(page)
    const heightOf = async () => (await panel.boundingBox())!.height

    const closed = await heightOf()
    await openSuggestions(page)
    // Click off the field rather than pressing Escape: Escape reaches the dialog's
    // own handler and would close the whole thing, not just the list.
    await page.getByRole('heading', { name: NEW_MESSAGE }).click()
    await expect(page.getByTestId('contact-suggestions')).toHaveCount(0)

    expect(await heightOf(), 'the dialog height must not depend on the list having been open')
      .toBeCloseTo(closed, 0)
  })
})

// The visible bar must touch the hovered row even when group spacing collapses.
// A timer-only test cannot detect the pointer dead zone between the two boxes.
test.describe('message toolbar alignment', () => {
  for (const density of ['comfortable', 'compact'] as const) {
    for (const afterDivider of [false, true]) {
      test(`${density}, ${afterDivider ? 'after unread divider' : 'regular group'}: remains reachable at a slow pointer speed`, async ({ page }) => {
        await bootDemo(page, `${DEMO_URL}&density=${density}`)
        await page.evaluate(() => {
          const demo = window as Window & { __demoClient?: { stopAnimation(): void } }
          demo.__demoClient?.stopAnimation()
        })
        await page.locator('[data-nav="rooms"]').click()
        await page.getByText('Team Chat', { exact: true }).first().click()
        await page.locator('.composer-mirror + textarea').waitFor()

        const messageId = 'demo-room-whisper-pub'
        if (afterDivider) {
          await page.evaluate((id) => {
            const store = (window as unknown as { __roomStore: typeof roomStore }).__roomStore
            const state = store.getState()
            store.setState({
              firstNewMessageMarkers: new Map(state.firstNewMessageMarkers).set(state.activeRoomJid!, { id }),
            })
          }, messageId)
        }
        const row = page.locator(`[data-message-body][data-message-id="${messageId}"]`)
        await row.scrollIntoViewIfNeeded()
        if (afterDivider) {
          await expect.poll(() => row.evaluate(el =>
            el.previousElementSibling?.hasAttribute('data-new-message-marker'),
          )).toBe(true)
        }
        await row.hover()
        const toolbar = row.locator('[data-message-toolbar]')
        await expect(toolbar).toHaveCSS('opacity', '1')
        const geometry = await row.evaluate(el => {
          const rowBox = el.getBoundingClientRect()
          const bar = el.querySelector('[data-message-toolbar] > div')!.getBoundingClientRect()
          return { overlap: bar.bottom - rowBox.top, endInset: rowBox.right - bar.right }
        })
        expect(geometry.overlap, 'visible bar must touch the row with no pointer dead zone').toBeGreaterThanOrEqual(0)
        expect(geometry.overlap, 'bar must stay at the top edge, clear of the message content').toBeLessThanOrEqual(6)
        expect(geometry.endInset, 'bar keeps its inset from the full-width row edge').toBeCloseTo(24, 0)

        const rowBox = (await row.boundingBox())!
        const replyBox = (await toolbar.getByRole('button', { name: 'Reply', exact: true }).boundingBox())!
        const x = replyBox.x + replyBox.width / 2
        const targetY = replyBox.y + replyBox.height / 2
        const startY = rowBox.y + 10
        await page.mouse.move(x, startY)
        // Pause at each step longer than the hover-leave delay (100ms). The
        // alignment must make the crossing safe without depending on speed.
        for (let step = 1; step <= 8; step++) {
          await page.mouse.move(x, startY + (targetY - startY) * step / 8)
          await page.waitForTimeout(150)
          await expect(toolbar).toHaveCSS('opacity', '1')
        }
        await page.mouse.click(x, targetY)
        await expect(page.getByText('Replying to', { exact: false })).toBeVisible()
      })
    }
  }
})

test.describe('touch submenu focus', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  test('keeps keyboard focus in link and emoji views and returns one level at a time', async ({ page }) => {
    await bootDemo(page, DEMO_URL)
    await page.evaluate(() => {
      const demo = window as Window & { __demoClient?: { stopAnimation(): void } }
      demo.__demoClient?.stopAnimation()
    })
    await page.getByText('Emma Wilson', { exact: true }).first().click()
    const composer = page.locator('textarea.message-input')
    await composer.fill('Review https://example.com/one and https://example.org/two')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await composer.blur()
    const content = page.locator('[data-message-id] [data-msg-chrome]').last()
    await content.dispatchEvent('touchstart')
    const menu = page.getByRole('dialog', { name: 'More options', exact: true })
    await expect(menu).toBeVisible()
    await content.dispatchEvent('touchend')

    const back = menu.getByRole('button', { name: 'Back', exact: true })
    await menu.getByRole('button', { name: 'Copy link', exact: true }).tap()
    await expect(back).toBeFocused()
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Tab')
      await expect.poll(() => menu.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(menu.getByRole('button', { name: 'Copy link', exact: true })).toBeFocused()

    await menu.getByRole('button', { name: 'More reactions', exact: true }).tap()
    await expect(menu.locator('em-emoji-picker')).toBeVisible()
    await expect(back).toBeFocused()
    await page.keyboard.press('Shift+Tab')
    await expect.poll(() => menu.evaluate((el) => el.contains(document.activeElement))).toBe(true)
    await page.keyboard.press('Tab')
    await expect(back).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu.getByRole('button', { name: 'More reactions', exact: true })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
  })
})

test.describe('modal popover overflow', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 1280, height: 1200 } })

  for (const customCaption of [false, true]) {
    test(`paints the poll emoji picker outside a fitting panel with custom caption: ${customCaption}`, async ({ page }) => {
      await bootDemo(page, DEMO_URL)
      await page.evaluate((customCaption) => {
        const demo = window as unknown as {
          __demoClient: DemoClient
          __settingsStore: typeof useSettingsStore
        }
        demo.__demoClient.stopAnimation()
        demo.__settingsStore.getState().setFontSize(100)
        if (customCaption) document.documentElement.dataset.windowChrome = 'custom'
        else delete document.documentElement.dataset.windowChrome
        location.hash = '#/rooms/team%40conference.fluux.chat'
      }, customCaption)
      await page.getByRole('button', { name: 'Attach file', exact: true }).click()
      await page.getByRole('button', { name: 'Create Poll', exact: true }).click()
      const panel = panelOf(page)
      await expect(panel.getByRole('heading', { name: 'Create Poll' })).toBeVisible()
      await panel.evaluate((element) => Promise.all(element.getAnimations().map(animation => animation.finished)))
      await panel.getByTitle('Click to change emoji', { exact: true }).last().click()
      const picker = panel.locator('em-emoji-picker')
      await expect(picker).toBeVisible()
      await expect.poll(() => picker.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThan(200)
      const panelBox = (await panel.boundingBox())!
      const pickerBox = (await picker.boundingBox())!
      expect(pickerBox.y + pickerBox.height).toBeGreaterThan(panelBox.y + panelBox.height)
      expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(1200)
      expect(await picker.evaluate(element => {
        const box = element.getBoundingClientRect()
        return [box.top + 48, box.bottom - 32].every(y =>
          element.contains(document.elementFromPoint(box.left + box.width / 2, y)),
        )
      })).toBe(true)
      await panel.locator('input[type="text"]').first().click()
      await expect(picker).toBeHidden()
      await expect(panel).toBeVisible()
      await panel.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(panel).toBeHidden()
    })
  }
})

test.describe('overlay content below the caption', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 360, height: 600 } })

  async function prepare(page: Page, fontSize: 100 | 150) {
    await bootDemo(page, DEMO_URL)
    await page.evaluate((fontSize) => {
      const demo = window as unknown as {
        __demoClient: DemoClient
        __settingsStore: typeof useSettingsStore
      }
      demo.__demoClient.stopAnimation()
      demo.__settingsStore.getState().setFontSize(fontSize)
      document.documentElement.dataset.windowChrome = 'custom'
    }, fontSize)
    await expect(page.locator('html')).toHaveCSS('font-size', `${16 * fontSize / 100}px`)
  }

  for (const fontSize of [100, 150] as const) {
    test(`uses below-caption offsets and result budgets at ${fontSize}%`, async ({ page }) => {
      await prepare(page, fontSize)
      await page.mouse.move(0, 0)
      await page.keyboard.press('ControlOrMeta+k')
      const panel = page.getByRole('dialog')
      const input = panel.getByRole('textbox')
      await input.fill('>')
      const rows = panel.locator('[data-selected]')
      await expect(rows.first()).toBeVisible()
      await panel.evaluate((element) => Promise.all(element.getAnimations().map(animation => animation.finished)))
      const caption = 40 * fontSize / 100
      const panelBox = (await panel.boundingBox())!
      expect(panelBox.y).toBeCloseTo(caption + (600 - caption) * 0.15, 0)
      const resultsBox = (await panel.locator(':scope > div').nth(1).boundingBox())!
      expect(resultsBox.height).toBeLessThanOrEqual((600 - caption) * 0.6 + 1)
      await input.press('Escape')
      await expect(panel).toBeHidden()
    })
  }

  for (const shape of ['portrait', 'landscape'] as const) {
    test(`keeps a ${shape} image and filename within the available height`, async ({ page }) => {
      await prepare(page, 150)
      await page.evaluate((shape) => {
        const demo = window as unknown as { __demoClient: DemoClient }
        const canvas = document.createElement('canvas')
        canvas.width = shape === 'portrait' ? 240 : 1600
        canvas.height = shape === 'portrait' ? 1600 : 240
        const context = canvas.getContext('2d')!
        context.fillStyle = '#5274a0'
        context.fillRect(0, 0, canvas.width, canvas.height)
        const jid = 'emma@fluux.chat'
        demo.__demoClient.emitSDK('chat:message', {
          message: {
            type: 'chat', id: 'caption-image', conversationId: jid,
            stanzaId: undefined, originId: undefined, from: 'you@fluux.chat',
            body: '', isOutgoing: true, timestamp: new Date(),
            attachment: {
              url: canvas.toDataURL(), name: 'caption-image.png', mediaType: 'image/png',
              width: canvas.width, height: canvas.height,
            },
          },
          isLiveArrival: true,
        })
        location.hash = `#/messages/${encodeURIComponent(jid)}`
      }, shape)
      await page.getByRole('img', { name: 'caption-image.png', exact: true }).click()
      const viewer = page.locator('[data-lightbox="image"]')
      const image = viewer.getByRole('img')
      await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalHeight)).toBe(shape === 'portrait' ? 1600 : 240)
      for (const caption of [60, 0, 60]) {
        await page.evaluate((caption) => {
          if (caption) document.documentElement.dataset.windowChrome = 'custom'
          else delete document.documentElement.dataset.windowChrome
        }, caption)
        const imageBox = (await image.boundingBox())!
        const labelBox = (await viewer.getByText('caption-image.png', { exact: true }).boundingBox())!
        expect(imageBox.y).toBeGreaterThanOrEqual(caption)
        expect(labelBox.y + labelBox.height).toBeLessThanOrEqual(601)
        if (shape === 'portrait') expect(imageBox.height).toBeCloseTo((600 - caption) * 0.85, 0)
        expect(imageBox.width / imageBox.height).toBeCloseTo(shape === 'portrait' ? 240 / 1600 : 1600 / 240, 2)
      }
      await viewer.getByTitle('Close', { exact: true }).click()
      await expect(viewer).toBeHidden()
    })
  }
})

test.describe('desktop floating caption bounds', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 360, height: 600 } })

  for (const direction of ['ltr', 'rtl'] as const) {
    test(`keeps the room-owner actions below the caption in ${direction}`, async ({ page }) => {
      await bootDemo(page, DEMO_URL)
      await page.evaluate((direction) => {
        const demo = window as unknown as {
          __demoClient: DemoClient
          __settingsStore: typeof useSettingsStore
        }
        demo.__demoClient.stopAnimation()
        demo.__settingsStore.getState().setFontSize(150)
        document.documentElement.dir = direction
        location.hash = '#/rooms/team%40conference.fluux.chat'
      }, direction)
      await expect(page.locator('html')).toHaveCSS('font-size', '24px')
      const trigger = page.getByRole('button', { name: 'Room actions', exact: true })
      const menu = page.getByRole('menu')
      await trigger.click()
      await expect(menu).toBeVisible()
      const nativeBox = (await menu.boundingBox())!
      expect(nativeBox.y).toBe(8)
      await page.keyboard.press('Escape')
      await page.evaluate(() => { document.documentElement.dataset.windowChrome = 'custom' })
      await trigger.click()
      await expect(menu).toHaveCSS('max-height', '524px')
      const box = (await menu.boundingBox())!
      expect(box.y).toBeGreaterThanOrEqual(68)
      expect(box.y + box.height).toBeLessThanOrEqual(593)
      const firstItem = menu.getByRole('menuitem').first()
      await expect(firstItem).toBeVisible()
      expect(await firstItem.evaluate((item) => {
        const rect = item.getBoundingClientRect()
        return item.contains(document.elementFromPoint(rect.right - 12, rect.top + rect.height / 2))
      })).toBe(true)
      await menu.evaluate((element) => { element.scrollTop = element.scrollHeight })
      await expect(menu).toBeVisible()
      const lastBox = (await menu.getByRole('menuitem').last().boundingBox())!
      expect(lastBox.y).toBeGreaterThanOrEqual(68)
      expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(593)
      await page.keyboard.press('Escape')
      await page.evaluate(() => { delete document.documentElement.dataset.windowChrome })
      await trigger.click()
      const restoredBox = (await menu.boundingBox())!
      expect(restoredBox.y).toBe(nativeBox.y)
      expect(restoredBox.height).toBe(nativeBox.height)
    })
  }

  for (const captionHeight of [60, 0]) {
    test(`keeps the emoji picker below the caption above a tall composer (${captionHeight}px caption)`, async ({ page }) => {
      await bootDemo(page, DEMO_URL)
      await page.evaluate((captionHeight) => {
        const demo = window as unknown as {
          __demoClient: DemoClient
          __settingsStore: typeof useSettingsStore
        }
        demo.__demoClient.stopAnimation()
        demo.__settingsStore.getState().setFontSize(150)
        if (captionHeight) document.documentElement.dataset.windowChrome = 'custom'
        location.hash = '#/messages/emma%40fluux.chat'
      }, captionHeight)
      const composer = page.locator('textarea.message-input')
      await composer.fill('A line in a tall composer\n'.repeat(20))
      await page.locator('[class~="[grid-area:emoji]"] > button').press('Enter')
      const picker = page.locator('em-emoji-picker')
      await expect(picker).toBeVisible()
      const panel = picker.locator('..')
      await expect.poll(async () => (await panel.boundingBox())!.y).toBeGreaterThanOrEqual(captionHeight + 8)
      const box = (await panel.boundingBox())!
      expect(box.y + box.height).toBeLessThanOrEqual(593)
      await page.keyboard.press('Escape')
      await expect(picker).toBeHidden()
    })
  }
})

test.describe('touch menu title-bar bounds', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 360, height: 600 } })

  for (const direction of ['ltr', 'rtl'] as const) {
    for (const kind of ['preview', 'header'] as const) {
      test(`${kind} menu stays below the caption in ${direction}`, async ({ page }) => {
        await bootDemo(page, DEMO_URL)
        await page.evaluate((direction) => {
          const demo = window as unknown as {
            __demoClient: DemoClient
            __settingsStore: typeof useSettingsStore
          }
          demo.__demoClient.stopAnimation()
          demo.__settingsStore.getState().setFontSize(150)
          document.documentElement.dir = direction
          const jid = 'emma@fluux.chat'
          demo.__demoClient.emitSDK('chat:message', {
            message: {
              type: 'chat', id: 'caption-bounds', conversationId: jid,
              stanzaId: undefined, originId: undefined, from: jid,
              body: 'A tall message for the touch menu.\n'.repeat(40),
              isOutgoing: false, timestamp: new Date(),
            },
            isLiveArrival: true,
          })
          location.hash = `#/messages/${encodeURIComponent(jid)}`
        }, direction)
        await expect(page.locator('html')).toHaveCSS('font-size', '24px')
        const menu = page.getByRole('dialog', {
          name: kind === 'preview' ? 'More options' : 'More actions', exact: true,
        })
        if (kind === 'preview') {
          const content = page.locator('[data-message-id="caption-bounds"] [data-msg-chrome]')
          await content.scrollIntoViewIfNeeded()
          await content.dispatchEvent('touchstart')
          await expect(menu).toBeVisible()
          await content.dispatchEvent('touchend')
        } else {
          await page.getByRole('button', { name: 'More actions', exact: true }).tap()
          await expect(menu).toBeVisible()
        }

        const geometry = () => menu.evaluate((panel) => {
          const root = panel.closest('[data-modal="true"]')!
          const backdrop = root.querySelector('[aria-hidden="true"]')!
          const box = panel.getBoundingClientRect()
          const rootBox = root.getBoundingClientRect()
          const backdropBox = backdrop.getBoundingClientRect()
          const reactions = panel.querySelector('[data-touch-menu-reactions]')?.getBoundingClientRect()
          return {
            top: box.top, bottom: box.bottom, left: box.left, right: box.right,
            maxHeight: parseFloat(getComputedStyle(panel).maxHeight),
            backdropTop: backdropBox.top, backdropBottom: backdropBox.bottom,
            rootTop: rootBox.top, reactionsTop: reactions?.top,
          }
        })

        for (const captionHeight of [0, 60, 0]) {
          await page.evaluate((height) => {
            if (height) document.documentElement.dataset.windowChrome = 'custom'
            else delete document.documentElement.dataset.windowChrome
          }, captionHeight)
          await expect.poll(async () => (await geometry()).maxHeight).toBe(600 - captionHeight - 24)
          const boxes = await geometry()
          expect(boxes.rootTop).toBe(captionHeight)
          expect(boxes.backdropTop).toBe(captionHeight)
          expect(boxes.backdropBottom).toBe(600)
          expect(boxes.top).toBeGreaterThanOrEqual(captionHeight + 12)
          expect(boxes.bottom).toBeLessThanOrEqual(589)
          expect(boxes.left).toBeGreaterThanOrEqual(12)
          expect(boxes.right).toBeLessThanOrEqual(349)
          if (kind === 'preview') {
            expect(boxes.reactionsTop).toBeGreaterThanOrEqual(captionHeight + 12)
            expect(boxes.top).toBe(captionHeight + 12)
          }
        }
        if (kind === 'preview') {
          await menu.getByRole('button', { name: 'React with ❤️', exact: true }).tap()
          await expect(page.locator('[data-message-row-id="caption-bounds"]')).toContainText('❤️')
        } else {
          await page.keyboard.press('Escape')
        }
        await expect(menu).toBeHidden()
      })
    }
  }
})
