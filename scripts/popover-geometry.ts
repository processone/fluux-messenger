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
 *   npx playwright test --config=playwright.e2e.config.ts --project=popover-webkit
 */

import { test, expect, type Page, type Locator } from '@playwright/test'
import { bootDemo } from './e2e/demoBoot'

// ── Constants ─────────────────────────────────────────────────────────────────

const DEMO_URL = '/demo.html?tutorial=false'

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
