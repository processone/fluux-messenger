import { expect, test, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { settle } from './harness/scrollHarness'

const ROW = '[data-message-row-id][data-message-id^="showcase-launch-"]'
const VIRTUALIZATION_FLAG = 'fluux:flags:enableMessageVirtualization'

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

async function expectGroupBelowReply(page: Page, step: string) {
  const timeline = page.locator('[data-message-list]')
  await expect(privateHeader(page)).toBeVisible()
  await expect(timeline.locator(`${ROW}[data-message-id$="-8"] [data-msg-whisper]`)).toBeVisible()
  await timeline.evaluate(async list => {
    await document.fonts.ready
    await Promise.all(Array.from(list.querySelectorAll('img'), image => image.decode().catch(() => {})))
  })
  await settle(page)

  const reading = await timeline.evaluate((list, rowSelector) => {
    const row = (id: number) => `${rowSelector}[data-message-id$="-${id}"]`
    const rect = (selector: string) => {
      const element = list.querySelector(selector)
      if (!element) throw new Error(`Missing timeline element: ${selector}`)
      const { top, bottom, left, right } = element.getBoundingClientRect()
      return { top, bottom, left, right }
    }
    const { top, bottom } = list.getBoundingClientRect()
    return {
      viewport: { width: window.innerWidth, top, bottom },
      quote: rect(`${row(6)} .reply-quote-card`),
      reply: rect(`${row(6)} [data-msg-text]`),
      reaction: rect(`${row(6)} [data-reaction-emoji="👏"]`),
      privateStart: rect(`${row(7)} [data-msg-whisper]`),
      privateEnd: rect(`${row(8)} [data-msg-whisper]`),
    }
  }, ROW)
  await test.info().attach(step, { body: JSON.stringify(reading, null, 2), contentType: 'application/json' })

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
  expect(privateEnd.bottom).toBeLessThanOrEqual(viewport.bottom)
}

test.describe('phone room timeline', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(colorScheme, () => {
      test.use({ colorScheme })
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
