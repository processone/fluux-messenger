/**
 * The iPhone Duo hinge (FLM-279). The captain's approved answers on FLM-177: Fluux's iOS code
 * reports the hinge to the page as CSS variables, and the layout splits at the hinge. Half open
 * in landscape, the list and the chat sit on either side; half open in portrait, the messages sit
 * above the hinge and the composer and keyboard below it. Flat stays as today.
 *
 * The variables are the ones HingeReporter.swift sets on <html>, with what UIKit reported on the
 * iPhone Duo simulator: an inner screen of 951 x 669 points, and a division band around the fold
 * at 475.5 points with 20-point margins on each side, where buttons keep clear.
 *
 * Run:
 *   npx playwright test --config e2e/playwright.e2e.config.ts --project=hinge-layout-webkit
 */
import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'

const DEMO_URL = '/demo.html?tutorial=false'
const HINGE = 475.5
const MARGIN = 20
const LANDSCAPE = { width: 951, height: 669 }
const PORTRAIT = { width: 669, height: 951 }
/** The list's resize handle (Sidebar.tsx). */
const RESIZE_HANDLE = '[role="separator"][aria-orientation="vertical"]'
/** Sub-pixel slack: engines round fractional lengths differently. */
const EPSILON = 0.5

type Line = { x: number } | { y: number } | null

/** What HingeLayout.script(for:) runs: folded with a line and its margin, flat (fully open), or no hinge at all. */
async function setHinge(page: Page, posture: 'folded' | 'flat' | null, line: Line = null) {
  await page.evaluate(({ posture, line, margin }) => {
    const style = document.documentElement.style
    const set = (name: string, value: string | undefined) =>
      value === undefined ? style.removeProperty(name) : style.setProperty(name, value)
    set('--fluux-device-posture', posture ?? undefined)
    set('--fluux-hinge-x', line && 'x' in line ? `${line.x}px` : undefined)
    set('--fluux-hinge-y', line && 'y' in line ? `${line.y}px` : undefined)
    set('--fluux-hinge-margin', line ? `${margin}px` : undefined)
  }, { posture, line, margin: MARGIN })
}

async function openConversation(page: Page, name: string, nav: 'messages' | 'rooms' = 'messages') {
  if (nav === 'rooms') await page.locator('[data-nav="rooms"]').click()
  await page.locator('.sidebar-row').filter({ hasText: name }).first().click()
  await expect(page.locator('[data-conversation-column]')).toBeVisible()
}

/** Every visible control whose box comes within the hinge margin of the line along `axis`. */
async function controlsNearHinge(page: Page, axis: 'x' | 'y') {
  return page.evaluate(({ axis, hinge, margin }) => {
    const selector = 'button, a[href], input, select, textarea, [contenteditable="true"], [role="button"], [role="separator"]'
    return [...document.querySelectorAll<HTMLElement>(selector)].flatMap((el) => {
      const r = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || el.closest('[inert]')) return []
      if (r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) return []
      const [start, end] = axis === 'x' ? [r.left, r.right] : [r.top, r.bottom]
      if (end <= hinge - margin || start >= hinge + margin) return []
      return [`${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${start.toFixed(1)}-${end.toFixed(1)}`]
    })
  }, { axis, hinge: HINGE, margin: MARGIN })
}

test.describe('half open in landscape', () => {
  test.use({ viewport: LANDSCAPE })

  for (const dir of ['ltr', 'rtl'] as const) {
    test(`the list and the chat meet at the hinge, ${dir}`, async ({ page }) => {
      await bootDemo(page, DEMO_URL)
      await page.evaluate((dir) => { document.documentElement.dir = dir }, dir)
      await openConversation(page, 'Emma Wilson')
      const sidebar = page.getByTestId('sidebar-pane')
      const chat = page.locator('main')
      const flat = (await sidebar.boundingBox())!
      await expect(sidebar.locator(RESIZE_HANDLE)).toHaveCount(1)

      await setHinge(page, 'folded', { x: HINGE })
      const [list, main] = [(await sidebar.boundingBox())!, (await chat.boundingBox())!]
      if (dir === 'ltr') {
        expect(list.x).toBeCloseTo(0, 0)
        expect(Math.abs(list.x + list.width - HINGE)).toBeLessThanOrEqual(EPSILON)
        expect(Math.abs(main.x - HINGE)).toBeLessThanOrEqual(EPSILON)
      } else {
        expect(Math.abs(list.x - HINGE)).toBeLessThanOrEqual(EPSILON)
        expect(Math.abs(main.x + main.width - HINGE)).toBeLessThanOrEqual(EPSILON)
      }
      await expect(sidebar.locator(RESIZE_HANDLE)).toHaveCount(0)
      expect(await controlsNearHinge(page, 'x')).toEqual([])
      await page.screenshot({ path: test.info().outputPath(`landscape-folded-${dir}.png`) })

      // Fully open returns to the list width it had, which stays saved.
      await setHinge(page, 'flat')
      expect((await sidebar.boundingBox())!.width).toBeCloseTo(flat.width, 0)
      await expect(sidebar.locator(RESIZE_HANDLE)).toHaveCount(1)
    })
  }
})

test.describe('half open in portrait', () => {
  test.use({ viewport: PORTRAIT, hasTouch: true, isMobile: true })

  for (const [name, nav] of [['Emma Wilson', 'messages'], ['Team Chat', 'rooms']] as const) {
    test(`messages above the hinge and the composer below it, ${nav}`, async ({ page }) => {
      await bootDemo(page, DEMO_URL)
      await openConversation(page, name, nav)
      const messages = page.locator('[data-conversation-column] > .focus-zone')
      const composer = page.locator('[data-conversation-column] .composer-form')
      const column = page.locator('[data-conversation-column]')
      const flatComposer = (await composer.boundingBox())!
      const flatColumn = (await column.boundingBox())!
      expect(flatComposer.y + flatComposer.height).toBeCloseTo(flatColumn.y + flatColumn.height, 0)

      await setHinge(page, 'folded', { y: HINGE })
      await expect.poll(async () => { const box = (await messages.boundingBox())!; return box.y + box.height })
        .toBeCloseTo(HINGE - MARGIN, 0)
      const below = (await composer.boundingBox())!
      expect(Math.abs(below.y - (HINGE + MARGIN))).toBeLessThanOrEqual(EPSILON)
      expect(await controlsNearHinge(page, 'y')).toEqual([])
      await page.screenshot({ path: test.info().outputPath(`portrait-folded-${nav}.png`) })

      // The keyboard fills the band and the half below it, so iOS ends the page above the band
      // and the composer sits on the keyboard.
      await page.setViewportSize({ width: PORTRAIT.width, height: 455 })
      await expect.poll(async () => { const box = (await composer.boundingBox())!; return box.y + box.height }).toBeCloseTo(455, 0)

      // Fully open returns to today's layout.
      await page.setViewportSize(PORTRAIT)
      await setHinge(page, 'flat')
      await expect.poll(async () => { const box = (await composer.boundingBox())!; return box.y + box.height })
        .toBeCloseTo(flatColumn.y + flatColumn.height, 0)
    })
  }
})
