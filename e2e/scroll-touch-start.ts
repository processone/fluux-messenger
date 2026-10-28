import { test, expect, devices } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { activateChat } from './harness/scrollHarness'

// On iPhone the message list stood still at the start of a swipe, then jumped. iOS holds a
// scroll that starts over a non-passive touchstart, touchmove or gesture listener until the
// page has handled the touch, so a busy page turns every such listener over the list into
// that freeze. Desktop engines never hold scrolling this way, so these tests read what iOS
// reads: the listeners over the list, and the touch-action that keeps pinch zoom out instead.

test.use({
  viewport: devices['iPhone 13'].viewport,
  userAgent: devices['iPhone 13'].userAgent,
  isMobile: true,
  hasTouch: true,
})

/** Records every touch and gesture listener the app keeps, with the passive flag the engine uses. */
function recordTouchListeners() {
  type Entry = { target: EventTarget; type: string; listener: unknown; capture: boolean; passive: boolean }
  const holdingTypes = new Set(['touchstart', 'touchmove', 'gesturestart', 'gesturechange'])
  const entries: Entry[] = []
  const add = EventTarget.prototype.addEventListener
  const remove = EventTarget.prototype.removeEventListener
  const captureOf = (options: unknown) => typeof options === 'boolean' ? options : !!(options as AddEventListenerOptions | undefined)?.capture
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
    // Only the page's own scripts count: Playwright's injected script keeps a non-passive window
    // touchstart listener of its own, and its code has no address on the page's origin.
    const byPage = (new Error().stack ?? '').includes(location.origin)
    if (holdingTypes.has(type) && listener && byPage) {
      const explicit = typeof options === 'object' && options !== null ? (options as AddEventListenerOptions).passive : undefined
      // DOM default: touchstart and touchmove listeners on the window, document, html and body are passive.
      const rootTarget = this === window || this === document || this === document.documentElement || this === document.body
      const passive = explicit ?? ((type === 'touchstart' || type === 'touchmove') && rootTarget)
      entries.push({ target: this, type, listener, capture: captureOf(options), passive })
    }
    return add.call(this, type, listener as EventListenerOrEventListenerObject, options as AddEventListenerOptions)
  }
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: unknown, options?: unknown) {
    const capture = captureOf(options)
    const index = entries.findIndex(entry => entry.target === this && entry.type === type && entry.listener === listener && entry.capture === capture)
    if (index >= 0) entries.splice(index, 1)
    return remove.call(this, type, listener as EventListenerOrEventListenerObject, options as EventListenerOptions)
  }
  ;(window as unknown as { __touchListeners: Entry[] }).__touchListeners = entries
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(recordTouchListeners)
  await bootDemo(page, '/demo.html?tutorial=false&virt=1')
  await page.evaluate(() => (window as unknown as { __demoClient: { stopAnimation(): void } }).__demoClient.stopAnimation())
  await activateChat(page, 'ava@fluux.chat')
  await expect(page.locator('[data-message-list] .message-row').first()).toBeVisible()
})

test('a swipe on the message list never waits for the page to handle the touch', async ({ page }) => {
  const holding = await page.evaluate(() => {
    const list = document.querySelector('[data-message-list]')!
    const name = (target: EventTarget) => target === window ? 'window' : target === document ? 'document'
      : target instanceof Element ? target.tagName.toLowerCase() + (target.id ? '#' + target.id : '') : String(target)
    const entries = (window as unknown as { __touchListeners: { target: EventTarget; type: string; passive: boolean }[] }).__touchListeners
    return entries
      .filter(entry => !entry.passive)
      .filter(({ target }) => target === window || (target instanceof Node && (target.contains(list) || list.contains(target))))
      .map(({ target, type }) => `${type} on ${name(target)}`)
  })
  expect(holding).toEqual([])
})

test('pinch zoom stays out of the message list on a touch screen', async ({ page }) => {
  // WebKit starts touch-action afresh at every scroll container, so the list and what it holds
  // need their own value; a rule on body alone leaves pinch zoom on inside the list.
  const touchActions = await page.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-message-list]')!
    const row = list.querySelector<HTMLElement>('.message-row')!
    let innermost: Element = row
    while (innermost.firstElementChild) innermost = innermost.firstElementChild
    return {
      coarsePointer: matchMedia('(any-pointer: coarse)').matches,
      list: getComputedStyle(list).touchAction,
      row: getComputedStyle(row).touchAction,
      innermost: getComputedStyle(innermost).touchAction,
    }
  })
  expect(touchActions).toEqual({ coarsePointer: true, list: 'pan-x pan-y', row: 'pan-x pan-y', innermost: 'pan-x pan-y' })
})
