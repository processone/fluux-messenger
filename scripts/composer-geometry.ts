/**
 * Playwright composer-geometry harness.
 *
 * These invariants cannot be expressed as unit tests: jsdom has no layout, so
 * every jsdom autosize test has to mock `scrollHeight`. That mock is exactly
 * where the two shipped bugs hid — both were disagreements between a computed
 * number and the real box model, which a mocked measurement can never contradict.
 *
 * What went wrong, and what each invariant pins down:
 *
 *  1. HALF-LINE / CLIPPED CONTENT.
 *     `scrollHeight` is padding-inclusive and the textarea is border-box, but the
 *     cap was a bare `lineHeight * 8`. Short by the 24px block padding, the height
 *     saturated at 7 lines instead of 8; the 8th line then overflowed without
 *     changing the computed height, so the autosize fast path returned before
 *     flipping `overflow-y`. Result: content clipped mid-glyph inside an
 *     overflow:hidden box with no scrollbar to explain the cut.
 *     → `never clips content without a scrollbar`, `grows to the documented cap`.
 *
 *  2. CARET / TEXT DRIFT IN ROOMS.
 *     The room composer paints mention highlights with a mirror div stacked behind
 *     a transparent textarea. `::-webkit-scrollbar` is styled with an explicit
 *     width, so the scrollbar takes layout instead of overlaying: the moment the
 *     textarea started scrolling it lost those pixels of content width while the
 *     mirror kept the full width. The layers then wrapped at different columns, so
 *     the text the user sees drifted away from the caret it is meant to sit under.
 *     → `mirror keeps the textarea's content width`, `mirror matches text metrics`.
 *
 * Run:
 *   npm run test:composer
 *   npx playwright test --config=playwright.e2e.config.ts --project=composer-webkit
 */

import { test, expect, type Page, type Locator } from '@playwright/test'
import { bootDemo } from './e2e/demoBoot'

// ── Constants ─────────────────────────────────────────────────────────────────

const DEMO_URL = '/demo.html?tutorial=false'

/**
 * A room, so the mention-highlight mirror is in play — the 1:1 composer renders a
 * plain textarea with no mirror. Reached through the UI rather than a hash route:
 * demo.tsx clears localStorage on boot, so a deep link into a room does not
 * survive a cold context.
 */
const ROOM_NAME = 'Team Chat'

/** Must match COMPOSER_LINE_HEIGHT / COMPOSER_MAX_LINES in MessageComposer.tsx. */
const LINE_HEIGHT = 24
const MAX_LINES = 8

/** Sub-pixel slack: engines round fractional text metrics differently. */
const EPSILON = 1

/**
 * Slack for the caret-visibility check. Engines scroll to reveal the caret's glyph
 * box (ascent + descent), which sits inset within the 24px line box by the leading,
 * so they legitimately stop a few px short of containing the whole line box. Half a
 * line absorbs that while still failing loudly on the regression this guards — a
 * caret left a full line or more outside the scrollport.
 */
const CARET_SLACK_PX = LINE_HEIGHT / 2

// ── Shared setup ─────────────────────────────────────────────────────────────

interface Geometry {
  styleHeight: string
  overflowY: string
  clientHeight: number
  scrollHeight: number
  scrollTop: number
  textareaContentWidth: number
  mirrorContentWidth: number
  mirrorScrollHeight: number
  paddingTop: number
}

/** Load the demo straight into a room and wait for the composer to mount. */
async function openRoomComposer(page: Page): Promise<Locator> {
  await bootDemo(page, DEMO_URL)

  await page.locator('[data-nav="rooms"]').click()
  await page.getByText(ROOM_NAME, { exact: true }).first().click()

  // Wait for the ROOM composer specifically — a textarea stacked on a .composer-mirror —
  // rather than "the first textarea on the page". The demo runs its own default-route
  // navigation on startup, so an early click can leave the app in a 1:1 view whose
  // composer carries no mirror; the old unscoped locator matched that one and failed the
  // assertion below. Waiting on the pairing makes the wait condition and the structure
  // the tests depend on the same thing.
  const textarea = page.locator('.composer-mirror + textarea').first()
  await textarea.waitFor({ state: 'visible', timeout: 30_000 })

  // The geometry invariants below compare the mirror's box against the textarea's, which
  // only holds while both carry the shared .message-input styling. Assert that contract
  // so a class rename fails loudly here instead of silently skewing every measurement.
  const mirrorSharesComposerStyling = await textarea.evaluate(
    (el) => el.previousElementSibling?.classList.contains('message-input') ?? false
  )
  expect(
    mirrorSharesComposerStyling,
    'the composer mirror should share the .message-input styling with the textarea',
  ).toBe(true)
  return textarea
}

/** Replace the draft the way React's controlled input expects, then settle layout. */
async function setDraft(textarea: Locator, value: string): Promise<void> {
  await textarea.evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )!.set!
    setter.call(el, v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, value)
  // React commits the mirror's new content asynchronously. Two frames put us
  // past the commit and the layout effect that re-syncs the mirror, so the
  // measurements below compare settled boxes instead of racing the render.
  await textarea.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
}

async function measure(textarea: Locator): Promise<Geometry> {
  return textarea.evaluate((el) => {
    const ta = el as HTMLTextAreaElement
    const mirror = ta.previousElementSibling as HTMLElement | null
    return {
      styleHeight: ta.style.height,
      overflowY: ta.style.overflowY,
      clientHeight: ta.clientHeight,
      scrollHeight: ta.scrollHeight,
      scrollTop: ta.scrollTop,
      // clientWidth excludes any scrollbar the engine put in flow — which is the
      // whole point: this is the width the text actually wraps inside.
      textareaContentWidth: ta.clientWidth,
      mirrorContentWidth: mirror ? mirror.clientWidth : -1,
      mirrorScrollHeight: mirror ? mirror.scrollHeight : -1,
      paddingTop: parseFloat(getComputedStyle(ta).paddingTop) || 0,
    }
  })
}

const linesOf = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

// ── Invariants ───────────────────────────────────────────────────────────────

test.describe('composer geometry', () => {
  /**
   * The reported bug, stated as an invariant: content may be cut off only when a
   * scrollbar exists to explain the cut. A clipped line inside an overflow:hidden
   * box reads as a rendering fault, which is exactly what users reported.
   */
  test('never clips content without a scrollbar', async ({ page }) => {
    const textarea = await openRoomComposer(page)

    for (let n = 1; n <= MAX_LINES + 4; n++) {
      await setDraft(textarea, linesOf(n))
      const g = await measure(textarea)
      const overflowing = g.scrollHeight > g.clientHeight + EPSILON
      expect(
        overflowing && g.overflowY !== 'auto',
        `${n} lines: ${g.scrollHeight}px of content in a ${g.clientHeight}px box with overflow-y:${g.overflowY} — content is clipped with no scrollbar`
      ).toBe(false)
    }
  })

  /**
   * The cap has to mean what it says. A padding-blind cap silently costs a line:
   * the composer stops growing at 7 and clips the 8th.
   */
  test('grows to the documented cap before it starts scrolling', async ({ page }) => {
    const textarea = await openRoomComposer(page)

    await setDraft(textarea, linesOf(MAX_LINES))
    const atCap = await measure(textarea)
    expect(
      atCap.scrollHeight,
      `${MAX_LINES} lines must fit without scrolling`
    ).toBeLessThanOrEqual(atCap.clientHeight + EPSILON)
    expect(atCap.clientHeight).toBeGreaterThanOrEqual(MAX_LINES * LINE_HEIGHT)

    await setDraft(textarea, linesOf(MAX_LINES + 1))
    const past = await measure(textarea)
    expect(past.overflowY, 'past the cap the composer must scroll').toBe('auto')
    expect(past.clientHeight, 'the composer must not grow past the cap').toBe(atCap.clientHeight)
  })

  /**
   * No half-lines, at any scroll offset. Block padding on a scroll container
   * offsets the line grid inside the scrollport by a fraction of a line, so one
   * edge always cuts a line in half. Keeping the padding on the frame instead
   * makes the scrollport a whole number of lines, and the offsets the browser
   * scrolls to (reveal-the-caret, top, bottom) exact multiples of the line box.
   *
   * The frame assertion is what stops this being "fixed" by deleting the padding:
   * the spacing must still be there, just not on the scrolling element.
   */
  test('keeps block padding off the scrolling element so lines are never half-shown', async ({ page }) => {
    const textarea = await openRoomComposer(page)
    await setDraft(textarea, linesOf(MAX_LINES + 6))

    const box = await textarea.evaluate((el) => {
      const ta = el as HTMLTextAreaElement
      const s = getComputedStyle(ta)
      const frame = ta.closest('[class*="grid-area:input"]') as HTMLElement | null
      return {
        paddingTop: parseFloat(s.paddingTop) || 0,
        paddingBottom: parseFloat(s.paddingBottom) || 0,
        clientHeight: ta.clientHeight,
        frameHeight: frame ? frame.getBoundingClientRect().height : -1,
      }
    })

    expect(box.paddingTop, 'block padding belongs on the frame, not the scrollport').toBe(0)
    expect(box.paddingBottom, 'block padding belongs on the frame, not the scrollport').toBe(0)
    expect(
      box.clientHeight % LINE_HEIGHT,
      `scrollport is ${box.clientHeight}px — not a whole number of ${LINE_HEIGHT}px lines`
    ).toBe(0)
    // The spacing must survive the move: the frame is taller than the scrollport.
    expect(
      box.frameHeight,
      'the frame must still supply the block padding the textarea gave up'
    ).toBeGreaterThan(box.clientHeight)

    // Every offset the browser actually scrolls to must land on a line boundary.
    for (const target of [0, 9999]) {
      const scrollTop = await textarea.evaluate((el, t) => {
        const ta = el as HTMLTextAreaElement
        ta.scrollTop = t
        return ta.scrollTop
      }, target)
      expect(
        scrollTop % LINE_HEIGHT,
        `scrollTop ${scrollTop} cuts a line in half`
      ).toBe(0)
    }
  })

  /**
   * The caret lives in the textarea; the glyphs the user sees live in the mirror.
   * They only agree if both wrap inside the same content width — in EVERY overflow
   * state, since the scrollbar appearing is what used to change it. This is the
   * guard that keeps mention highlighting viable: without it the only fix would be
   * dropping the mirror (and nick rendering with it).
   */
  test('mention mirror keeps the textarea content width in every overflow state', async ({ page }) => {
    const textarea = await openRoomComposer(page)

    for (const n of [1, MAX_LINES, MAX_LINES + 4]) {
      await setDraft(textarea, linesOf(n))
      const g = await measure(textarea)
      expect(
        g.mirrorContentWidth,
        `${n} lines (overflow-y:${g.overflowY}): mirror wraps at ${g.mirrorContentWidth}px but the caret wraps at ${g.textareaContentWidth}px — the visible text drifts away from the caret`
      ).toBe(g.textareaContentWidth)
    }
  })

  /**
   * A draft ending in a newline is the case a `pre-wrap` mirror gets wrong: it
   * lays out no line box for the terminal break, where the textarea does. The
   * mirror is then a line shorter, which at the overflow boundary means it does
   * not become a scroll container at all — so it reserves no scrollbar gutter
   * (a 6px wrap mismatch in WebKit) and cannot follow the textarea's scrollTop.
   * Pressing Enter for a new line is the single most ordinary way to reach this.
   */
  test('mention mirror tracks the textarea when the draft ends with a newline', async ({ page }) => {
    const textarea = await openRoomComposer(page)

    // Just under the cap, at it, and past it — the boundary is where a missing
    // final line box flips the mirror out of being scrollable.
    for (const n of [2, MAX_LINES, MAX_LINES + 4]) {
      const draft = `${linesOf(n)}\n`
      await setDraft(textarea, draft)

      const g = await measure(textarea)
      expect(
        g.mirrorContentWidth,
        `${n} lines + trailing newline (overflow-y:${g.overflowY}): mirror wraps at ${g.mirrorContentWidth}px but the caret wraps at ${g.textareaContentWidth}px`
      ).toBe(g.textareaContentWidth)
      expect(
        g.mirrorScrollHeight,
        `${n} lines + trailing newline: mirror lays out ${g.mirrorScrollHeight}px of content but the textarea lays out ${g.scrollHeight}px — the mirror is missing the final line box`
      ).toBe(g.scrollHeight)

      // The mirror must be able to follow the textarea's scroll offset. It can
      // only do that if it has the same scrollable height.
      const offsets = await textarea.evaluate((el) => {
        const ta = el as HTMLTextAreaElement
        const mirror = ta.previousElementSibling as HTMLElement
        ta.scrollTop = ta.scrollHeight
        ta.dispatchEvent(new Event('scroll', { bubbles: true }))
        return { textarea: ta.scrollTop, mirror: mirror.scrollTop }
      })
      expect(
        offsets.mirror,
        `${n} lines + trailing newline: textarea scrolled to ${offsets.textarea} but the mirror stayed at ${offsets.mirror} — highlighted text drifts vertically from the caret`
      ).toBe(offsets.textarea)
    }

    // The same thing the way a user reaches it: fill the composer, then press
    // Enter for one more line. Real keystrokes, so the browser's own
    // caret-into-view scroll runs and the mirror has to follow it.
    await setDraft(textarea, '')
    await textarea.click()
    for (let n = 1; n <= MAX_LINES; n++) {
      await textarea.type(`line ${n}`)
      await page.keyboard.press('Shift+Enter') // plain Enter sends
    }

    expect(
      await textarea.evaluate((el) => (el as HTMLTextAreaElement).value.endsWith('\n')),
      'the draft should end on the newline just typed'
    ).toBe(true)

    // Polled rather than sampled once: the browser's caret scroll and React's
    // re-sync land on separate frames, so a single read can catch the gap
    // between them. It still fails loudly — with the real numbers — if the
    // mirror never catches up.
    await expect
      .poll(
        async () =>
          textarea.evaluate((el) => {
            const ta = el as HTMLTextAreaElement
            const mirror = ta.previousElementSibling as HTMLElement
            const synced = mirror.scrollTop === ta.scrollTop && mirror.clientWidth === ta.clientWidth
            return synced
              ? 'synced'
              : `mirror scrollTop ${mirror.scrollTop} vs textarea ${ta.scrollTop}, width ${mirror.clientWidth} vs ${ta.clientWidth}`
          }),
        { timeout: 5_000 }
      )
      .toBe('synced')
  })

  /**
   * The rest of the mirror contract. Identical width only guarantees identical
   * wrapping if the text metrics match too, so pin them: a future font or padding
   * tweak applied to one layer is a caret-drift regression.
   */
  test('mention mirror matches the textarea text metrics', async ({ page }) => {
    const textarea = await openRoomComposer(page)
    await setDraft(textarea, linesOf(3))

    const metrics = await textarea.evaluate((el) => {
      const pick = (n: Element) => {
        const s = getComputedStyle(n)
        return {
          fontSize: s.fontSize,
          fontFamily: s.fontFamily,
          fontWeight: s.fontWeight,
          letterSpacing: s.letterSpacing,
          lineHeight: s.lineHeight,
          whiteSpace: s.whiteSpace,
          wordBreak: s.wordBreak,
          overflowWrap: s.overflowWrap,
          paddingLeft: s.paddingLeft,
          paddingRight: s.paddingRight,
          paddingTop: s.paddingTop,
          borderLeftWidth: s.borderLeftWidth,
        }
      }
      return { textarea: pick(el), mirror: pick(el.previousElementSibling!) }
    })

    expect(metrics.mirror).toEqual(metrics.textarea)
  })

  /**
   * The user-visible half of the caret complaint: after typing past the cap the
   * caret's line must be inside the scrollport. Typed with real keystrokes so the
   * browser's own caret-into-view scrolling runs — restoring a stale pre-overflow
   * scroll offset used to undo it and park the caret off-screen.
   */
  test('keeps the caret line visible while typing past the cap', async ({ page }) => {
    const textarea = await openRoomComposer(page)
    await textarea.click()

    const typed = MAX_LINES + 4
    for (let n = 1; n <= typed; n++) {
      await textarea.type(`line ${n}`)
      if (n < typed) await page.keyboard.press('Shift+Enter') // plain Enter sends
    }

    const g = await measure(textarea)
    // The caret sits at the end, so it is on the last line.
    const caretTop = g.paddingTop + (typed - 1) * LINE_HEIGHT
    const caretBottom = caretTop + LINE_HEIGHT
    expect(
      caretTop,
      `caret line [${caretTop}, ${caretBottom}] is above the visible band [${g.scrollTop}, ${g.scrollTop + g.clientHeight}]`
    ).toBeGreaterThanOrEqual(g.scrollTop - CARET_SLACK_PX)
    expect(
      caretBottom,
      `caret line [${caretTop}, ${caretBottom}] is below the visible band [${g.scrollTop}, ${g.scrollTop + g.clientHeight}]`
    ).toBeLessThanOrEqual(g.scrollTop + g.clientHeight + CARET_SLACK_PX)
  })

  /**
   * The mirror is a separate scroll box, so it has to track the textarea's offset:
   * a desync shifts every glyph by whole lines relative to the caret.
   */
  test('mention mirror stays scroll-synced with the textarea', async ({ page }) => {
    const textarea = await openRoomComposer(page)
    await setDraft(textarea, linesOf(MAX_LINES + 6))

    await textarea.evaluate((el) => {
      const ta = el as HTMLTextAreaElement
      ta.scrollTop = ta.scrollHeight // jump to the bottom, as typing would
      ta.dispatchEvent(new Event('scroll', { bubbles: true }))
    })

    const offsets = await textarea.evaluate((el) => {
      const ta = el as HTMLTextAreaElement
      return { textarea: ta.scrollTop, mirror: (ta.previousElementSibling as HTMLElement).scrollTop }
    })
    expect(offsets.mirror).toBeCloseTo(offsets.textarea, 0)
  })
})
