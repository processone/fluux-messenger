import { expect, test, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { settle } from './harness/scrollHarness'

const ROW = '[data-message-row-id][data-message-id^="showcase-launch-"]'
const VIRTUALIZATION_FLAG = 'fluux:flags:enableMessageVirtualization'

type StartupResizeSample = { replyBottom: number; reactionBottom: number; privateTop: number }
type StartupWindow = Window & { roomStartupResizes?: StartupResizeSample[] }

async function trackStartupReplyResize(page: Page) {
  await page.addInitScript(rowSelector => {
    const samples: StartupResizeSample[] = []
    ;(window as StartupWindow).roomStartupResizes = samples
    const NativeObserver = window.ResizeObserver
    // Read after the real observer's delivery, before a later React task can hide a stale offset.
    window.ResizeObserver = class extends NativeObserver {
      constructor(deliver: ResizeObserverCallback) {
        super((entries, observer) => {
          deliver(entries, observer)
          const reply = document.querySelector(`${rowSelector}[data-message-id$="-6"]`)
          if (!reply?.querySelector('.reply-quote-card') || !entries.some(entry => entry.target === reply.parentElement)) return
          const body = reply.querySelector('[data-msg-text]')
          const reaction = reply.querySelector('[data-reaction-emoji="👏"]')
          const panel = reply.parentElement?.parentElement?.querySelector(`${rowSelector}[data-message-id$="-7"] [data-msg-whisper]`)
          if (body && reaction && panel) samples.push({
            replyBottom: body.getBoundingClientRect().bottom,
            reactionBottom: reaction.getBoundingClientRect().bottom,
            privateTop: panel.getBoundingClientRect().top,
          })
        })
      }
    }
  }, ROW)
}

async function openLaunchCrew(page: Page, virtualized = true) {
  await page.addInitScript(() => localStorage.setItem('i18nextLng', 'en'))
  await bootDemo(page, '/demo.html?scene=showcase&virt=1')
  // The demo clears persisted flags during boot; opt out before mounting the room.
  if (!virtualized) await page.evaluate(key => localStorage.setItem(key, 'false'), VIRTUALIZATION_FLAG)
  await page.locator('[data-nav="rooms"]').click()
  await page.getByTestId('sidebar-pane').getByText('Launch Crew', { exact: true }).click()
  await expect(privateHeader(page)).toBeVisible()
  await expect(page.locator('[data-virtualizer-spacer]')).toHaveCount(virtualized ? 1 : 0)
}

function privateHeader(page: Page) {
  return page.getByRole('button', { name: 'Private with Emma', exact: true })
}

async function expectGroupBelowReply(page: Page, step: string, startup = false) {
  const timeline = page.locator('[data-message-list]')
  await expect(privateHeader(page)).toBeVisible()
  await expect(timeline.locator(`${ROW}[data-message-id$="-8"] [data-msg-whisper]`)).toBeVisible()
  let notificationWasVisible: boolean | undefined
  if (startup) {
    await page.evaluate(async () => {
      await document.fonts.ready
      await Promise.allSettled(Array.from(document.images, image => image.decode()))
    })
    const startupNotification = page.getByText(/^Sophia Lin:/).filter({ visible: true }).first()
    notificationWasVisible = await startupNotification.isVisible()
    await startupNotification.waitFor({ state: 'hidden', timeout: 12_000 })
  } else {
    await timeline.evaluate(async list => {
      await document.fonts.ready
      await Promise.allSettled(Array.from(list.querySelectorAll('img'), image => image.decode()))
    })
    await settle(page)
  }

  const reading = await timeline.evaluate(async (list, { rowSelector, startup }) => {
    const row = (id: number) => `${rowSelector}[data-message-id$="-${id}"]`
    const quote = `${row(6)} .reply-quote-card`
    if (startup) {
      const element = list.querySelector(quote)
      if (!element) throw new Error('Missing startup reply quote')
      // The intersection sample follows the frame's resize observations and layout.
      // A settle loop would miss the stale row positions during the quote's first paint.
      await new Promise<void>(resolve => {
        const observer = new IntersectionObserver(() => { observer.disconnect(); resolve() }, { root: list })
        observer.observe(element)
      })
    }
    const rect = (selector: string) => {
      const element = list.querySelector(selector)
      if (!element) throw new Error(`Missing timeline element: ${selector}`)
      const { top, bottom, left, right } = element.getBoundingClientRect()
      return { top, bottom, left, right }
    }
    const { top, bottom } = list.getBoundingClientRect()
    return {
      viewport: { width: window.innerWidth, top, bottom },
      quote: rect(quote),
      reply: rect(`${row(6)} [data-msg-text]`),
      reaction: rect(`${row(6)} [data-reaction-emoji="👏"]`),
      privateStart: rect(`${row(7)} [data-msg-whisper]`),
      privateEnd: rect(`${row(8)} [data-msg-whisper]`),
    }
  }, { rowSelector: ROW, startup })
  await test.info().attach(step, { body: JSON.stringify({ ...reading, notificationWasVisible }, null, 2), contentType: 'application/json' })

  // The tinted border starts above the label and can cover a reaction that the label clears.
  const { quote, reply, reaction, privateStart, privateEnd, viewport } = reading
  expect(viewport.width).toBe(page.viewportSize()?.width)
  for (const [name, part] of Object.entries({ quote, reply, reaction })) {
    expect(part.bottom).toBeGreaterThan(part.top)
    expect(part.top).toBeGreaterThanOrEqual(viewport.top)
    expect(privateStart.top, `private panel must clear the public ${name}`).toBeGreaterThanOrEqual(part.bottom)
  }
  expect(privateEnd.top).toBeCloseTo(privateStart.bottom, 0)
  expect(privateEnd.left).toBeCloseTo(privateStart.left, 0)
  expect(privateEnd.right).toBeCloseTo(privateStart.right, 0)
  expect(privateEnd.bottom).toBeGreaterThan(privateEnd.top)
  // Entry scrolling can still be finishing at the first paint; the settled cases own visibility.
  if (!startup) expect(privateEnd.bottom).toBeLessThanOrEqual(viewport.bottom)
}

test.describe('phone room timeline', () => {
  test.use({ hasTouch: true, isMobile: true, locale: 'en-US', viewport: { width: 390, height: 844 } })

  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme, () => {
      test.use({ colorScheme })
      test('keeps the first-click room reply clear after the startup notification wait', async ({ page, baseURL }) => {
        const demoOrigin = new URL(baseURL!).origin
        await page.route('**/*', route => new URL(route.request().url()).origin === demoOrigin ? route.continue() : route.abort())
        await trackStartupReplyResize(page)
        await page.goto('/demo.html?scene=showcase&virt=1')
        await page.locator('.icon-rail [data-nav="rooms"]').click()
        await page.getByTestId('sidebar-pane').getByText('Launch Crew', { exact: true }).click()
        await expect(page.locator('[data-virtualizer-spacer]')).toHaveCount(1)
        await expectGroupBelowReply(page, 'startup-phone-390', true)
        const trace = await page.waitForFunction(() => {
          const samples = (window as StartupWindow).roomStartupResizes
          return samples?.length ? samples : null
        })
        const samples = await trace.jsonValue()
        await test.info().attach('startup-resize-batches', { body: JSON.stringify(samples), contentType: 'application/json' })
        for (const sample of samples!) {
          expect(sample.privateTop, 'private panel must clear the public reply and reaction at resize delivery')
            .toBeGreaterThanOrEqual(Math.max(sample.replyBottom, sample.reactionBottom))
        }
        await expect(page.locator('html.light')).toHaveCount(colorScheme === 'light' ? 1 : 0)
      })

      test('keeps the private group below the public reply and its reaction on open and resize', async ({ page }) => {
        await openLaunchCrew(page)
        const light = page.locator('html.light')
        await expect(light).toHaveCount(colorScheme === 'light' ? 1 : 0)
        await expectGroupBelowReply(page, 'phone-390')
        await page.setViewportSize({ width: 320, height: 844 })
        await expectGroupBelowReply(page, 'phone-320')
        await page.setViewportSize({ width: 390, height: 844 })
        await expectGroupBelowReply(page, 'phone-390-restored')
      })
    })
  }

  test('keeps the plain phone timeline separated and the private header actionable', async ({ page }) => {
    await openLaunchCrew(page, false)
    await page.locator(`${ROW}[data-message-id$="-8"] [data-msg-whisper]`).scrollIntoViewIfNeeded()
    await expectGroupBelowReply(page, 'plain-phone-390')
    await privateHeader(page).tap()
    await expect(page.getByText('Whispering privately to Emma', { exact: true })).toBeVisible()
  })
})

test('keeps the virtual desktop timeline separated and the private header actionable', async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 780 })
  await openLaunchCrew(page)
  await expectGroupBelowReply(page, 'desktop-1200')
  await privateHeader(page).click()
  await expect(page.getByText('Whispering privately to Emma', { exact: true })).toBeVisible()
})
