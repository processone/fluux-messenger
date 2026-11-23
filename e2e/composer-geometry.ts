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
 *     The room composer used to paint mention highlights with a mirror div stacked
 *     behind a transparent textarea. Two layers wrap independently, so a scrollbar
 *     taking width in one of them, a missing trailing line box, or text the engine
 *     adds to only one layer (macOS inline predictions) moved the caret away from
 *     the text it belonged to. The room composer is now ONE contenteditable that
 *     holds the text, the mention colour and the caret, so there is no second
 *     layout to disagree with.
 *     → `room composer is one layer`, `caret sits on the glyph it follows`.
 *
 * Run:
 *   npm run test:composer
 *   npx playwright test --config=e2e/playwright.e2e.config.ts --project=composer-webkit
 */

import { test, expect, type Page, type Locator } from '@playwright/test'
import { bootDemo } from './harness/demoBoot'
import { syncEngineGeometry } from './harness/compositorSync'
import { wheelAwayFromBottom } from './harness/scrollHarness'

// ── Constants ─────────────────────────────────────────────────────────────────

const DEMO_URL = '/demo.html?tutorial=false'

/**
 * A room, whose composer is the single-layer mention editor — the 1:1 composer is a
 * plain textarea. Reached through the UI rather than a hash route:
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
  /** Width the text wraps inside; excludes any scrollbar the engine put in flow. */
  contentWidth: number
  paddingTop: number
}

/** The room composer's editor: a contenteditable carrying the shared .message-input styling. */
const ROOM_EDITOR = '.message-input[contenteditable="true"]'

/** Load the demo straight into a room and wait for the composer to mount. */
async function openRoomComposer(page: Page): Promise<Locator> {
  await bootDemo(page, DEMO_URL)

  await page.locator('[data-nav="rooms"]').click()
  await page.getByText(ROOM_NAME, { exact: true }).first().click()

  // Wait for the ROOM composer specifically, rather than "the first input on the page":
  // the demo runs its own default-route navigation on startup, so an early click can leave
  // the app in a 1:1 view whose composer is a textarea.
  const editor = page.locator(ROOM_EDITOR).first()
  await editor.waitFor({ state: 'visible', timeout: 30_000 })
  return editor
}

/**
 * Replace the draft with real input, then settle layout. Select-all + delete,
 * then each line typed and joined by Shift+Enter (plain Enter sends). Works on a
 * textarea and on the contenteditable, and goes through the same events a user's
 * keyboard does — a direct write to the DOM would bypass the editor's own state.
 */
async function setDraft(input: Locator, value: string): Promise<void> {
  const page = input.page()
  await input.focus()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Backspace')
  const readValue = () => input.evaluate(el => (el as unknown as { value: string }).value)
  await expect.poll(readValue).toBe('')
  const lines = value.split('\n')
  let typed = ''
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) {
      await page.keyboard.insertText(lines[i])
      typed += lines[i]
      // Observe each input before the next key can replace a pending edit.
      await expect.poll(readValue).toBe(typed)
    }
    if (i < lines.length - 1) {
      await page.keyboard.press('Shift+Enter')
      typed += '\n'
      await expect.poll(readValue).toBe(typed)
    }
  }
  // React commits the new text asynchronously. Two frames put us past the commit
  // and the autosize that follows it, so the measurements below compare settled
  // boxes instead of racing the render.
  await input.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  )
}

async function measure(input: Locator): Promise<Geometry> {
  return input.evaluate((el) => {
    const cs = getComputedStyle(el)
    return {
      styleHeight: (el as HTMLElement).style.height,
      overflowY: cs.overflowY,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      contentWidth: el.clientWidth,
      paddingTop: parseFloat(cs.paddingTop) || 0,
    }
  })
}

const linesOf = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n')

async function openStableComposer(page: Page, view: 'chat' | 'room'): Promise<Locator> {
  let textarea: Locator
  if (view === 'room') {
    textarea = await openRoomComposer(page)
  } else {
    await bootDemo(page, DEMO_URL)
    textarea = page.locator('textarea.message-input').first()
    await textarea.waitFor({ state: 'visible' })
  }
  // Keep history fixed: the demo timeline adds messages, and its transport
  // echoes body-less room chat states as empty rows (a real MUC does not).
  await page.evaluate(() => {
    const client = (window as Window & {
      __demoClient?: { stopAnimation(): void; messages: { sendChatState: () => Promise<void> } }
    }).__demoClient
    if (!client) throw new Error('demo client missing')
    client.stopAnimation()
    client.messages.sendChatState = async () => {}
  })
  return textarea
}

async function setRemoteTyping(page: Page, view: 'chat' | 'room', isTyping: boolean): Promise<void> {
  await page.evaluate(({ view, isTyping }) => {
    const demo = window as Window & {
      __demoClient?: { emitSDK(event: string, payload: unknown): void }
      __chatStore?: { getState(): { activeConversationId: string } }
      __roomStore?: { getState(): { activeRoomJid: string } }
    }
    if (view === 'chat') {
      const jid = demo.__chatStore!.getState().activeConversationId
      demo.__demoClient!.emitSDK('chat:typing', { conversationId: jid, jid, isTyping })
    } else {
      const roomJid = demo.__roomStore!.getState().activeRoomJid
      demo.__demoClient!.emitSDK('room:typing', { roomJid, nick: 'Emma', isTyping })
    }
  }, { view, isTyping })
}

/**
 * Return a repeating geometry signature: scrollport metrics and mounted virtualized row offsets
 * and heights, rounded to CSS pixels. Repetition alone does not prove compositor synchronization;
 * waitForMessageLayoutSettled owns acceptance of the signature.
 */
function sampleSettledLayout(scroller: Locator, framesRequired: number): Promise<string> {
  return scroller.evaluate((el, needed) => new Promise<string>((resolve, reject) => {
    const timeoutMs = 15_000
    const startedAt = performance.now()
    let lastSignature = ''
    let stableFrames = 0

    const readSignature = () => {
      const viewport = el.getBoundingClientRect()
      const rows = Array.from(
        el.querySelectorAll<HTMLElement>('[data-virtualizer-spacer] > [data-index]')
      ).map(row => {
        const rect = row.getBoundingClientRect()
        return [row.dataset.index, Math.round(rect.top - viewport.top), Math.round(rect.height)]
      })
      return JSON.stringify([
        Math.round(el.scrollTop),
        el.scrollHeight,
        el.clientHeight,
        rows,
      ])
    }

    const tick = () => {
      const signature = readSignature()
      if (signature === lastSignature) stableFrames += 1
      else {
        lastSignature = signature
        stableFrames = 0
      }

      if (stableFrames >= needed) {
        resolve(signature)
        return
      }
      if (performance.now() - startedAt >= timeoutMs) {
        reject(new Error('message layout did not settle before the composer measurement'))
        return
      }
      requestAnimationFrame(tick)
    }

    requestAnimationFrame(tick)
  }), framesRequired)
}

/**
 * Accept a stable layout signature only if it survives compositor synchronization unchanged.
 * See syncEngineGeometry in e2e/compositorSync.ts for the engine constraint.
 */
async function waitForMessageLayoutSettled(scroller: Locator): Promise<void> {
  const deadline = Date.now() + 20_000
  for (;;) {
    const settled = await sampleSettledLayout(scroller, 30)
    await syncEngineGeometry(scroller.page())
    if (await sampleSettledLayout(scroller, 2) === settled) return
    if (Date.now() >= deadline) {
      throw new Error('the engine kept correcting the message layout after every settle')
    }
  }
}

// ── Invariants ───────────────────────────────────────────────────────────────

test.describe('composer geometry', () => {
  test('accepts the first room insertion after select-all and Backspace', async ({ page, browserName }) => {
    // Exercise Lexical's macOS Chromium text-replacement path on Linux CI too.
    if (browserName === 'chromium' && process.platform !== 'darwin') {
      await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }))
    }
    const editor = await openStableComposer(page, 'room')
    await editor.click()
    await expect(editor).toBeFocused()
    await expect(editor).toHaveJSProperty('value', '')

    // Keep the zero-delay fallback from running between keyup and insertion. Real
    // key events and beforeinput still run; only the page's timer is controlled.
    const now = Date.now()
    await page.clock.install({ time: now })
    await page.clock.pauseAt(now + 5_000)
    try {
      await page.keyboard.press(browserName === 'chromium' ? 'Meta+a' : 'ControlOrMeta+A')
      await page.keyboard.press('Backspace')
      expect(await editor.evaluate(el => (el as HTMLTextAreaElement).value)).toBe('')
      await page.keyboard.insertText('First line')
      await expect(editor).toHaveJSProperty('value', 'First line')
    } finally {
      await page.clock.resume()
    }
  })

  test('keeps the replacement guard within the room editing command', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Only Chromium on macOS has this guard')
    if (process.platform !== 'darwin') {
      await page.addInitScript(() => Object.defineProperty(navigator, 'platform', { value: 'MacIntel' }))
    }
    const editor = await openStableComposer(page, 'room')
    await editor.click()

    const now = Date.now()
    await page.clock.install({ time: now })
    await page.clock.pauseAt(now + 5_000)
    const readDraft = () => editor.evaluate(el => (el as HTMLTextAreaElement).value)
    try {
      // Model Chromium delivering the unwanted replacement inside a handled
      // key press. Backspace must not edit existing text here: a real edit emits
      // an input event, which clears Lexical's guard independently of keyup.
      await page.keyboard.down('Backspace')
      await page.keyboard.insertText('Unwanted replacement')
      expect(await readDraft()).toBe('')
      await page.keyboard.up('Backspace')
      await page.keyboard.insertText('Old draft')
      expect(await readDraft()).toBe('Old draft')

      await page.keyboard.down('Meta')
      await page.keyboard.down('a')
      expect(await editor.evaluate(() => window.getSelection()?.toString())).toBe('Old draft')
      await page.keyboard.insertText('Unwanted replacement')
      expect(await readDraft()).toBe('Old draft')
      await page.keyboard.up('a')
      await page.keyboard.up('Meta')

      await page.keyboard.down('Meta')
      await page.keyboard.down('a')
      // macOS may omit the letter's keyup while Command is held.
      await page.keyboard.up('Meta')
      await page.keyboard.insertText('Replace selection')
      expect(await readDraft()).toBe('Replace selection')
    } finally {
      await page.clock.resume()
    }
  })

  // Inline predictions are native text the engine lays out next to the caret. A
  // mirrored composer cannot paint it, so rooms used to opt out of it; the single
  // layer draws it like any other glyph, so neither composer may opt out any more.
  test('keeps inline predictions available in the room and 1:1 composers', async ({ page }) => {
    const chat = await openStableComposer(page, 'chat')
    await expect(chat).not.toHaveAttribute('writingsuggestions', 'false')

    const room = await openRoomComposer(page)
    await expect(room).not.toHaveAttribute('writingsuggestions', 'false')
  })

  for (const view of ['chat', 'room'] as const) {
    test(`deleting within a line preserves the ${view} viewport`, async ({ page }) => {
      await page.setViewportSize({ width: 1298, height: 950 })
      const textarea = await openStableComposer(page, view)

      const draft = 'First line\nSecond line\nThird line\nFourth line\nLast line example.'
      const scroller = page.locator('[data-message-list]').first()
      const snapshot = async () => scroller.evaluate((el) => {
        const ta = document.querySelector('.message-input')!
        return {
          composerHeight: ta.clientHeight,
          viewportHeight: el.clientHeight,
          scrollHeight: el.scrollHeight,
          scrollTop: el.scrollTop,
          bottomGap: el.scrollHeight - el.clientHeight - el.scrollTop,
        }
      })

      // Cover both a reader following the latest message and one reading just above it.
      for (const gap of [0, 40]) {
        await setDraft(textarea, draft)
        await textarea.focus()
        await textarea.evaluate((el) => {
          const ta = el as HTMLTextAreaElement
          ta.setSelectionRange(ta.value.length, ta.value.length)
        })
        await waitForMessageLayoutSettled(scroller)
        await scroller.evaluate((el, offset) => {
          el.scrollTop = el.scrollHeight - el.clientHeight - offset
        }, gap)
        await waitForMessageLayoutSettled(scroller)
        const before = await snapshot()
        expect(before.composerHeight).toBe(5 * LINE_HEIGHT)
        expect(before.scrollTop, 'fixture must have scrollable chat history').toBeGreaterThan(100)
        expect(Math.abs(before.bottomGap - gap)).toBeLessThanOrEqual(EPSILON)

        for (let i = 0; i < 5; i++) await textarea.press('Backspace')
        await waitForMessageLayoutSettled(scroller)
        const after = await snapshot()
        console.log('composer deletion geometry', { view, gap, before, after })
        expect(after.composerHeight).toBe(before.composerHeight)
        expect(after.viewportHeight).toBe(before.viewportHeight)
        expect(after.scrollHeight).toBe(before.scrollHeight)
        expect.soft(Math.abs(after.scrollTop - before.scrollTop),
          `deletion moved the chat by ${after.scrollTop - before.scrollTop}px at bottom gap ${gap}`,
        ).toBeLessThanOrEqual(EPSILON)
      }
    })

    for (const typing of ['visible', 'appearing', 'disappearing'] as const) {
      test(`deleting with typing ${typing} preserves the ${view} reading position`, async ({ page }) => {
        await page.setViewportSize({ width: 1298, height: 950 })
        const textarea = await openStableComposer(page, view)
        const scroller = page.locator('[data-message-list]').first()
        const pill = page.locator('[data-typing-pill]')

        for (const gap of [0, 400]) {
          await setDraft(textarea, `${linesOf(4)}\nLast line example.`)
          await textarea.focus()
          await textarea.evaluate((el) => {
            const ta = el as HTMLTextAreaElement
            ta.setSelectionRange(ta.value.length, ta.value.length)
          })
          await setRemoteTyping(page, view, typing !== 'appearing')
          await expect(pill).toHaveCount(typing === 'appearing' ? 0 : 1)
          await page.waitForTimeout(700)
          await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight })
          if (gap > 0) {
            await wheelAwayFromBottom(page, 300, -gap)
          }
          await waitForMessageLayoutSettled(scroller)

          const read = (anchorIndex: string | null = null) => scroller.evaluate((el, expectedAnchorIndex) => {
            const ta = document.querySelector('.message-input')!
            const badge = el.parentElement!.querySelector('[data-typing-pill]')
            const rect = el.getBoundingClientRect()
            const rows = Array.from(el.querySelectorAll('.message-row[data-message-id]'))
            const tail = rows.at(-1)!.getBoundingClientRect()
            const virtualRows = Array.from(
              el.querySelectorAll<HTMLElement>('[data-virtualizer-spacer] > [data-index]')
            ).filter(row => row.querySelector('.message-row[data-message-id]'))
            const anchorRow = expectedAnchorIndex === null
              ? virtualRows.reduce<HTMLElement | null>((closest, row) => {
                const rowRect = row.getBoundingClientRect()
                if (rowRect.bottom <= rect.top || rowRect.top >= rect.bottom) return closest
                if (!closest) return row
                const viewportMiddle = rect.top + rect.height / 2
                const closestMiddle = closest.getBoundingClientRect().top + closest.getBoundingClientRect().height / 2
                const rowMiddle = rowRect.top + rowRect.height / 2
                return Math.abs(rowMiddle - viewportMiddle) < Math.abs(closestMiddle - viewportMiddle)
                  ? row
                  : closest
              }, null)
              : virtualRows.find(row => row.dataset.index === expectedAnchorIndex) ?? null
            return {
              composerHeight: ta.clientHeight,
              viewportHeight: el.clientHeight,
              scrollHeight: el.scrollHeight,
              scrollTop: el.scrollTop,
              bottomGap: el.scrollHeight - el.clientHeight - el.scrollTop,
              tailVisible: tail.bottom <= rect.bottom + 1,
              badgeOverlapsMessages: badge ? badge.getBoundingClientRect().top < rect.bottom : false,
              anchorIndex: anchorRow?.dataset.index ?? null,
              anchorTop: anchorRow ? anchorRow.getBoundingClientRect().top - rect.top : null,
            }
          }, anchorIndex)
          const before = await read()
          expect(before.composerHeight).toBe(5 * LINE_HEIGHT)
          if (gap === 0) expect(before.bottomGap).toBeLessThanOrEqual(EPSILON)
          else expect(before.bottomGap).toBeGreaterThan(300)

          // Change the badge between real Backspace events, without a settling
          // delay: its resize and the composer's measurement can share a frame.
          await textarea.press('Backspace')
          if (typing !== 'visible') await setRemoteTyping(page, view, typing === 'appearing')
          await textarea.press('Backspace')
          await expect(pill).toHaveCount(typing === 'disappearing' ? 0 : 1)
          await waitForMessageLayoutSettled(scroller)
          const after = await read(before.anchorIndex)
          console.log('composer and typing geometry', { view, typing, gap, before, after })
          expect(after.composerHeight).toBe(before.composerHeight)
          expect(after.badgeOverlapsMessages).toBe(false)
          if (typing === 'appearing') expect(after.viewportHeight).toBeLessThan(before.viewportHeight)
          else if (typing === 'disappearing') expect(after.viewportHeight).toBeGreaterThan(before.viewportHeight)
          else expect(after.viewportHeight).toBe(before.viewportHeight)
          if (gap === 0) {
            expect(after.bottomGap).toBeLessThanOrEqual(EPSILON)
            expect(after.tailVisible).toBe(true)
          } else {
            expect(before.anchorIndex, 'the reading viewport must contain a message anchor').not.toBeNull()
            expect(after.anchorIndex, 'the same message anchor must remain mounted').toBe(before.anchorIndex)
            expect(after.anchorTop).not.toBeNull()
            expect(before.anchorTop).not.toBeNull()
            expect(Math.abs(after.anchorTop! - before.anchorTop!)).toBeLessThanOrEqual(EPSILON)
          }
        }
      })
    }
  }

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
   * The structural half of the fix: caret, text and mention colour are one
   * element. A second layer is what let wrap points, scrollbar gutters and
   * engine-generated text disagree, so its return must fail loudly here.
   */
  test('room composer is one layer: no mirror, no textarea, mentions styled in place', async ({ page }) => {
    const editor = await openRoomComposer(page)
    const card = page.locator('.composer-card')
    await expect(card.locator('.composer-mirror')).toHaveCount(0)
    await expect(card.locator('textarea')).toHaveCount(0)

    await editor.click()
    await page.keyboard.type('hello @')
    await page.keyboard.press('Enter') // picks the first suggestion
    const mention = editor.locator('[data-mention]')
    await expect(mention).toHaveCount(1)
    const mentionText = (await mention.textContent())!
    expect(mentionText.startsWith('@')).toBe(true)
    // The colour is applied to the real text node the caret sits in, not to a copy.
    const colours = await editor.evaluate((el) => {
      const mention = el.querySelector('[data-mention]')!
      const plain = el.querySelector('p')!.firstChild as HTMLElement
      return { mention: getComputedStyle(mention).color, plain: getComputedStyle(plain.parentElement!).color }
    })
    expect(colours.mention).not.toBe(colours.plain)
  })

  /**
   * The reported bug as a user sees it: the caret is where the last typed
   * character is. After typing a message that wraps onto several lines, the
   * caret must sit on the line of the last glyph, right after it — in whichever
   * engine, at whatever width.
   */
  test('caret sits on the glyph it follows on every wrapped line', async ({ page }) => {
    const editor = await openRoomComposer(page)
    await editor.click()

    const words = 'We found a registration for the jid in this room, and will check if we misinterpret the message'
    for (const width of [1298, 1000, 760]) {
      await page.setViewportSize({ width, height: 900 })
      await setDraft(editor, '')
      await page.keyboard.insertText(`${words} ${words}`)
      // Compare after every ArrowLeft too, so the caret is checked on each wrapped line, not just the last.
      for (const stepsBack of [0, 30, 60, 90]) {
        for (let i = 0; i < (stepsBack === 0 ? 0 : 30); i++) await page.keyboard.press('ArrowLeft')
        const probe = await editor.evaluate(() => {
          const sel = getSelection()!
          const range = sel.getRangeAt(0)
          const caret = range.getClientRects()[0] ?? range.startContainer.parentElement!.getBoundingClientRect()
          // The glyph before the caret.
          const text = range.startContainer
          const before = document.createRange()
          before.setStart(text, Math.max(0, range.startOffset - 1))
          before.setEnd(text, range.startOffset)
          const glyph = before.getBoundingClientRect()
          return { caretTop: caret.top, caretLeft: caret.left, glyphTop: glyph.top, glyphRight: glyph.right }
        })
        expect(
          Math.abs(probe.caretTop - probe.glyphTop),
          `${width}px, ${stepsBack} chars back: caret top ${probe.caretTop} vs glyph top ${probe.glyphTop}`
        ).toBeLessThanOrEqual(2)
        expect(
          Math.abs(probe.caretLeft - probe.glyphRight),
          `${width}px, ${stepsBack} chars back: caret x ${probe.caretLeft} vs glyph right edge ${probe.glyphRight}`
        ).toBeLessThanOrEqual(2)
      }
    }
  })

  // A completed mention must not become a fresh query when Left returns to its
  // trailing edge. Otherwise the picker consumes Up/Down instead of changing lines.
  test('vertical arrows leave a completed mention on the middle line', async ({ page }) => {
    const editor = await openRoomComposer(page)
    const picker = page.locator('[role="listbox"][id$="-mention-autocomplete"]')
    const above = 'Upper line with plenty of plain letters for the caret'
    const below = 'Lower line with plenty of plain letters for the caret'
    const caret = () => editor.evaluate(el => (el as unknown as { selectionStart: number }).selectionStart)
    for (const [prefix, suffix] of [['', 'tail text'], ['prefix ', 'tail text'], ['prefix ', '']]) {
      await editor.click()
      await setDraft(editor, `${above}\n${prefix}@Em`)
      await expect(picker).toBeVisible()
      await page.keyboard.press('Enter')
      const mention = editor.locator('[data-mention]')
      await expect(mention).toHaveText('@Emma')
      const end = above.length + 1 + prefix.length + (await mention.textContent())!.length
      await expect.poll(caret).toBe(end + 1)
      await page.keyboard.insertText(suffix)
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.insertText(below)
      const draft = await editor.evaluate(el => (el as unknown as { value: string }).value)
      for (const [key, destination] of [['ArrowUp', 1], ['ArrowDown', 3]] as const) {
        // Set up just outside the token; the move onto it and the vertical move
        // are native keys, as in the reported reproduction.
        await editor.evaluate((el, offset) => {
          (el as unknown as { setSelectionRange: (start: number, end: number) => void }).setSelectionRange(offset, offset)
        }, end + 1)
        await expect.poll(caret).toBe(end + 1)
        await page.keyboard.press('ArrowLeft')
        await expect.poll(caret).toBe(end)
        await page.keyboard.press(key)
        await expect.poll(async () => draft.slice(0, await caret()).split('\n').length,
          `${key} at ${JSON.stringify(prefix)}@Emma${suffix}`).toBe(destination)
        await expect(picker).not.toBeVisible()
        expect(await editor.evaluate(el => (el as unknown as { value: string }).value)).toBe(draft)
      }
    }
  })

  test('edited message mention text keeps vertical arrows available', async ({ page }) => {
    const editor = await openRoomComposer(page)
    await editor.click()
    const above = 'Text above the mention'
    const middle = 'prefix @Emma tail text'
    const below = 'Text below the mention'
    const body = `${above}\n${middle}\n${below}`
    const value = () => editor.evaluate(el => (el as unknown as { value: string }).value)
    await setDraft(editor, body)
    await expect.poll(value).toBe(body)
    await page.keyboard.press('Enter') // disposable local demo message
    await expect.poll(value).toBe('')
    await page.keyboard.press('ArrowUp')
    await expect(page.getByText('Editing message', { exact: true })).toBeVisible()
    await expect.poll(value).toBe(body)
    await expect(editor.locator('[data-mention]')).toHaveCount(0)
    const picker = page.locator('[role="listbox"][id$="-mention-autocomplete"]')
    const end = above.length + 1 + middle.indexOf(' tail text')
    const caret = () => editor.evaluate(el => (el as unknown as { selectionStart: number }).selectionStart)
    for (const [key, line] of [['ArrowUp', 1], ['ArrowDown', 3]] as const) {
      await editor.evaluate((el, offset) => {
        (el as unknown as { setSelectionRange: (start: number, end: number) => void }).setSelectionRange(offset, offset)
      }, end + 1)
      await expect.poll(caret).toBe(end + 1)
      await page.keyboard.press('ArrowLeft')
      await expect.poll(caret).toBe(end)
      await page.keyboard.press(key)
      await expect.poll(async () => body.slice(0, await caret()).split('\n').length).toBe(line)
      await expect(picker).not.toBeVisible()
      expect(await value()).toBe(body)
    }
  })

  test('plain mention text never reopens the picker on caret movement', async ({ page }) => {
    const editor = await openRoomComposer(page)
    await editor.click()
    const above = 'Text above the mention'
    const middle = 'prefix @Emma tail text'
    const below = 'Text below the mention'
    const draft = `${above}\n${middle}\n${below}`
    await setDraft(editor, draft)
    const value = () => editor.evaluate(el => (el as unknown as { value: string }).value)
    await expect.poll(value).toBe(draft)
    await expect(editor.locator('[data-mention]')).toHaveCount(0)
    // Re-enter through the draft owner, not a fresh typing event. This is also
    // the case where plain @names have no completed-reference metadata.
    await page.getByText('Design Review', { exact: true }).first().click()
    await expect(page).toHaveURL(/rooms\/design%40/)
    await page.getByText(ROOM_NAME, { exact: true }).first().click()
    await expect.poll(value).toBe(draft)
    await expect(editor.locator('[data-mention]')).toHaveCount(0)
    await editor.focus()
    const picker = page.locator('[role="listbox"][id$="-mention-autocomplete"]')
    await expect(picker).not.toBeVisible()
    const end = above.length + 1 + middle.indexOf(' tail text')
    const caret = () => editor.evaluate(el => (el as unknown as { selectionStart: number }).selectionStart)
    for (const [key, line] of [['ArrowUp', 1], ['ArrowDown', 3]] as const) {
      await editor.evaluate((el, offset) => {
        (el as unknown as { setSelectionRange: (start: number, end: number) => void }).setSelectionRange(offset, offset)
      }, end + 1)
      await expect.poll(caret).toBe(end + 1)
      await page.keyboard.press('ArrowLeft')
      await expect.poll(caret).toBe(end)
      await page.keyboard.press(key)
      await expect.poll(async () => draft.slice(0, await caret()).split('\n').length).toBe(line)
      await expect(picker).not.toBeVisible()
      expect(await value()).toBe(draft)
    }
  })

  test('deleting a completed mention separator never opens suggestions', async ({ page }) => {
    const editor = await openRoomComposer(page)
    const picker = page.locator('[role="listbox"][id$="-mention-autocomplete"]')
    const above = 'Text above the mention'
    const prefix = 'prefix '
    const below = 'Text below the mention'
    const value = () => editor.evaluate(el => (el as unknown as { value: string }).value)
    const caret = () => editor.evaluate(el => (el as unknown as { selectionStart: number }).selectionStart)
    for (const deletion of ['Backspace', 'Delete']) {
      await editor.click()
      await setDraft(editor, `${above}\n${prefix}@Em`)
      await expect.poll(value).toBe(`${above}\n${prefix}@Em`)
      await expect(picker).toBeVisible()
      await page.keyboard.press('Enter')
      const mention = editor.locator('[data-mention]')
      await expect(mention).toHaveText('@Emma')
      const end = above.length + 1 + prefix.length + (await mention.textContent())!.length
      await expect.poll(caret).toBe(end + 1)
      await page.keyboard.insertText('tail text')
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.insertText(below)
      const draft = `${above}\n${prefix}@Emma tail text\n${below}`
      await expect.poll(value).toBe(draft)
      await editor.evaluate((el, offset) => {
        (el as unknown as { setSelectionRange: (start: number, end: number) => void }).setSelectionRange(offset, offset)
      }, deletion === 'Backspace' ? end + 1 : end)
      await page.keyboard.press(deletion)
      const after = `${draft.slice(0, end)}${draft.slice(end + 1)}`
      await expect.poll(value).toBe(after)
      await expect.poll(caret).toBe(end)
      await expect(mention).toHaveText('@Emma')
      await expect(picker).not.toBeVisible()
      for (const [key, line] of [['ArrowUp', 1], ['ArrowDown', 3]] as const) {
        await editor.evaluate((el, offset) => {
          (el as unknown as { setSelectionRange: (start: number, end: number) => void }).setSelectionRange(offset, offset)
        }, end)
        await page.keyboard.press(key)
        await expect.poll(async () => after.slice(0, await caret()).split('\n').length).toBe(line)
        await expect(picker).not.toBeVisible()
        expect(await value()).toBe(after)
      }
    }
  })

  test('caret return stays closed until an unfinished query is typed again', async ({ page }) => {
    const editor = await openRoomComposer(page)
    await editor.click()
    await setDraft(editor, 'prefix @Em')
    const picker = page.locator('[role="listbox"][id$="-mention-autocomplete"]')
    await expect(picker).toBeVisible()
    await page.keyboard.press('ArrowLeft')
    await expect(picker).not.toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(picker).not.toBeVisible()
    await page.keyboard.insertText('m')
    await expect(picker).toBeVisible()
    await expect(picker.getByRole('option').filter({ hasText: '@Emma' })).toBeVisible()
  })

  test('unfinished mention queries keep picker arrow navigation', async ({ page }) => {
    const editor = await openRoomComposer(page)
    await setDraft(editor, '')
    await editor.click()
    await page.keyboard.insertText('@')
    await expect.poll(() => editor.evaluate(el => (el as unknown as { value: string }).value)).toBe('@')
    const picker = page.locator('[role="listbox"][id$="-mention-autocomplete"]')
    const options = picker.getByRole('option')
    await expect(picker).toBeVisible()
    expect(await options.count()).toBeGreaterThan(1)
    const selected = () => picker.locator('[aria-selected="true"]')
    const first = await options.nth(0).getAttribute('id')
    const second = await options.nth(1).getAttribute('id')
    const caret = () => editor.evaluate(el => (el as unknown as { selectionStart: number }).selectionStart)
    const start = await caret()
    await expect(selected()).toHaveAttribute('id', first!)
    await page.keyboard.press('ArrowDown')
    await expect(selected()).toHaveAttribute('id', second!)
    expect(await caret()).toBe(start)
    await page.keyboard.press('ArrowUp')
    await expect(selected()).toHaveAttribute('id', first!)
    expect(await caret()).toBe(start)
    await page.keyboard.press('ArrowDown')
    await expect(selected()).toHaveAttribute('id', second!)
    const picked = (await selected().innerText()).match(/@\S+/)![0]
    await page.keyboard.press('Enter')
    await expect(editor.locator('[data-mention]')).toHaveText(picked!)
    await expect(picker).not.toBeVisible()
  })

  /**
   * A mention is one unit: one Backspace removes all of it and the references
   * the message is sent with follow. Replaces the old manual offset arithmetic.
   */
  test('a mention deletes atomically', async ({ page }) => {
    const editor = await openRoomComposer(page)
    await editor.click()
    await page.keyboard.type('ping @')
    await page.keyboard.press('Enter')
    await expect(editor.locator('[data-mention]')).toHaveCount(1)
    const mention = (await editor.locator('[data-mention]').textContent())!
    // Typed straight after the pick, as a quick person would. The pick places
    // the caret on a timer, and a busy page runs queued keys first; that
    // placement must not pull the caret back behind what was typed (FLM-170).
    await page.keyboard.type('now')
    const typed = `ping ${mention} now`
    const state = () => editor.evaluate((el) => {
      const input = el as unknown as { value: string; selectionStart: number }
      return { value: input.value, caret: input.selectionStart }
    })
    await expect.poll(state).toEqual({ value: typed, caret: typed.length })
    // Keys outrun the browser's selectionchange, which is how the editor learns
    // where the caret is; a person types slower. Step one key at a time and wait
    // until the editor has seen each move, as a person's pace would allow.
    const caret = () => editor.evaluate((el) => (el as unknown as { selectionStart: number }).selectionStart)
    let expected = typed.length
    for (let i = 0; i < 4; i++) { // before " now"
      await page.keyboard.press('ArrowLeft')
      expected -= 1
      await expect.poll(caret).toBe(expected)
    }
    expect(expected).toBe('ping '.length + mention.length)
    await page.keyboard.press('Backspace')
    await expect(editor.locator('[data-mention]')).toHaveCount(0)
    expect(await editor.evaluate((el) => (el as unknown as { value: string }).value)).toBe('ping  now')
  })

  /**
   * A draft ending in a newline needs its own line box: pressing Enter for a new
   * line must leave the caret on that new line, inside the scrollport.
   */
  test('a trailing newline gets its own line and keeps the caret visible', async ({ page }) => {
    const editor = await openRoomComposer(page)
    await setDraft(editor, '')
    for (let n = 1; n <= MAX_LINES; n++) {
      await page.keyboard.insertText(`line ${n}`)
      await page.keyboard.press('Shift+Enter') // plain Enter sends
    }
    expect(
      await editor.evaluate((el) => (el as unknown as { value: string }).value.endsWith('\n')),
      'the draft should end on the newline just typed'
    ).toBe(true)

    await expect
      .poll(async () => {
        const g = await measure(editor)
        const caretBottom = await editor.evaluate((el) => {
          const rects = getSelection()!.getRangeAt(0).getClientRects()
          const rect = rects[0] ?? (getSelection()!.focusNode as Element).getBoundingClientRect()
          return rect.bottom - el.getBoundingClientRect().top
        })
        return g.scrollHeight > MAX_LINES * LINE_HEIGHT && caretBottom <= g.clientHeight + CARET_SLACK_PX
      }, { timeout: 5_000 })
      .toBe(true)
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
})

test.describe('composer button spacing', () => {
  for (const touch of [false, true]) {
    test.describe(touch ? 'phone' : 'desktop', () => {
      test.use({ hasTouch: touch, viewport: { width: touch ? 390 : 1280, height: 700 } })

      test('keeps controls inset from the card without excessive height', async ({ page }) => {
        await bootDemo(page, DEMO_URL)
        await page.evaluate(() => {
          const client = (window as unknown as { __demoClient: { stopAnimation(): void } }).__demoClient
          client.stopAnimation()
          location.hash = '#/messages/ava%40fluux.chat'
        })
        const textarea = page.locator('textarea').first()
        await expect(textarea).toHaveAttribute('placeholder', /Ava Martinez/)
        const card = page.locator('.composer-card')
        const lock = card.locator('[data-encryption-lock]')
        await textarea.fill('A short draft')
        await textarea.focus()
        const send = card.getByRole('button', { name: 'Send', exact: true })
        const add = card.locator('[class~="[grid-area:add]"] > button')
        const emoji = card.locator('[class~="[grid-area:emoji]"] > button')
        await expect(add).toBeVisible()
        await expect(emoji).toBeVisible()
        await expect(lock).toBeVisible()

        await expect.poll(async () => {
          const border = (await card.boundingBox())!
          const buttons = await Promise.all([send, add, lock, emoji].map(button => button.boundingBox()))
          return buttons.every(box => box !== null
            && box.x - border.x >= 4
            && box.y - border.y >= 4
            && border.x + border.width - box.x - box.width >= 4
            && border.y + border.height - box.y - box.height >= 4)
        }).toBe(true)

        const border = (await card.boundingBox())!
        const sendBox = (await send.boundingBox())!
        expect(sendBox.y - border.y, 'send button top clearance').toBeGreaterThanOrEqual(8)
        expect(border.x + border.width - sendBox.x - sendBox.width, 'send button side clearance').toBeGreaterThanOrEqual(8)
        // Allow the action row's 8px block padding around the existing controls.
        expect(border.height, 'compact one-line composer').toBeLessThanOrEqual(touch ? 106 : 60)
      })
    })
  }
})

test.describe('narrow composer drawer', () => {
  test.use({ hasTouch: false, isMobile: false, viewport: { width: 360, height: 600 } })

  /**
   * Below the container breakpoint the emoji button sits in a drawer that is open only while
   * the card has focus. WebKit does not focus a button on mouse down, so the press moves
   * focus to the body and collapses the drawer before the click can land.
   */
  const DRAWER_CONTROLS = [
    { name: 'emoji button', button: '[class~="[grid-area:emoji]"] > button', opens: 'em-emoji-picker' },
    { name: 'attach button', button: '[class~="[grid-area:add]"] > button', opens: '.fluux-popover' },
  ] as const

  for (const control of DRAWER_CONTROLS) {
    test(`a mouse click on the ${control.name} opens its popover`, async ({ page }) => {
      await bootDemo(page, DEMO_URL)
      await page.evaluate(() => {
        const demo = window as unknown as { __demoClient: { stopAnimation(): void } }
        demo.__demoClient.stopAnimation()
        location.hash = '#/messages/emma%40fluux.chat'
      })
      await page.locator('textarea.message-input').click()
      const drawerButton = page.locator(control.button)
      await expect(drawerButton).toBeVisible()
      await drawerButton.click()
      await expect(page.locator(control.opens).first()).toBeVisible()
    })
  }

  for (const direction of ['ltr', 'rtl'] as const) {
    test(`emoji mouse press transfers attachment-menu focus to the textarea (${direction})`, async ({ page }) => {
      const textarea = await openRoomComposer(page)
      await page.evaluate((dir) => { document.documentElement.dir = dir }, direction)
      await textarea.click()
      await page.locator('[class~="[grid-area:add]"] > button').press('Enter')
      const menu = page.locator('.composer-card .fluux-popover')
      await expect(menu).toBeVisible()
      // Tab cycles app focus zones; seed item focus to exercise popup cleanup.
      await menu.locator('button:enabled').first().focus()
      await expect(menu.locator('button:enabled').first()).toBeFocused()

      const emojiButton = page.locator('[class~="[grid-area:emoji]"] > button')
      await emojiButton.hover()
      await page.mouse.down()
      await expect(menu).toHaveCount(0)
      await expect(textarea).toBeFocused()
      await expect(emojiButton.locator('..')).toHaveCSS('pointer-events', 'auto')
      await page.mouse.up()
      await expect(page.locator('em-emoji-picker')).toBeVisible()
    })
  }
})

test.describe('composer emoji focus', () => {
  test.use({ hasTouch: false, isMobile: false })

  for (const width of [360, 960]) {
    for (const direction of ['ltr', 'rtl'] as const) {
      test(`mouse focus follows the drawer layout at ${width}px (${direction})`, async ({ page, browserName }) => {
        await page.setViewportSize({ width, height: 600 })
        await bootDemo(page, DEMO_URL)
        await page.evaluate((dir) => {
          const demo = window as unknown as { __demoClient: { stopAnimation(): void } }
          demo.__demoClient.stopAnimation()
          document.documentElement.dir = dir
          location.hash = '#/messages/emma%40fluux.chat'
        }, direction)
        const textarea = page.locator('textarea.message-input')
        await textarea.click()
        const emojiButton = page.locator('[class~="[grid-area:emoji]"] > button')
        await emojiButton.hover()
        await page.mouse.down()
        if (width === 360) {
          await expect(textarea).toBeFocused()
        } else {
          await expect(textarea).not.toBeFocused()
          if (browserName === 'chromium') await expect(emojiButton).toBeFocused()
        }
        await page.mouse.up()
        const picker = page.locator('em-emoji-picker')
        await expect(picker).toBeVisible()

        if (browserName === 'chromium') {
          const search = picker.locator('input').first()
          await search.focus()
          await expect(search).toBeFocused()
          await emojiButton.click()
          await expect(picker).toHaveCount(0)
          await expect(emojiButton).toBeFocused()
        }
      })
    }
  }
})

test.describe('narrow composer drawer on touch', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 700 } })

  /**
   * On a phone the tap reaches the attach controls as a synthesized mouse
   * down, which moves focus out of the card and collapses the drawer
   * (`pointer-events: none`) before the click lands.
   */
  test('a tap on the attach button and its file entry opens the file chooser', async ({ page }) => {
    await bootDemo(page, DEMO_URL)
    await page.evaluate(() => {
      const demo = window as unknown as {
        __demoClient: { stopAnimation(): void }
        __connectionStore: { getState(): { setHttpUploadService(service: { jid: string }): void } }
      }
      demo.__demoClient.stopAnimation()
      // The demo server announces no upload service, which disables the entry.
      demo.__connectionStore.getState().setHttpUploadService({ jid: 'upload.fluux.chat' })
      location.hash = '#/messages/emma%40fluux.chat'
    })
    const textarea = page.locator('textarea.message-input')
    await textarea.tap()
    await expect(textarea).toBeFocused()

    await page.locator('[class~="[grid-area:add]"] > button').tap()
    const menu = page.locator('.composer-card .fluux-popover')
    await expect(menu).toBeVisible()

    const chooser = page.waitForEvent('filechooser', { timeout: 5_000 })
    await menu.getByRole('button', { name: 'Attach file' }).tap()
    await chooser
  })
})

test.describe('room placeholder at phone width', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })

  /**
   * The placeholder span is absolutely positioned inside the field. With only a start
   * edge it sizes to its text, so `truncate` never cuts it: a long room name ran under
   * the send button with no ellipsis.
   */
  test('a long placeholder is cut with an ellipsis inside the field', async ({ page }) => {
    const editor = await openRoomComposer(page)
    await page.evaluate(() => {
      const demo = window as unknown as {
        __demoClient: { stopAnimation(): void }
        __roomStore: { getState(): { activeRoomJid: string; updateRoom(jid: string, u: { name: string }): void } }
      }
      demo.__demoClient.stopAnimation()
      const rooms = demo.__roomStore.getState()
      rooms.updateRoom(rooms.activeRoomJid, { name: 'ProcessOne technical discussions with a very long name' })
    })
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.waitForTimeout(250) // the drawer's 160ms collapse transition

    const g = await editor.evaluate((ed) => {
      const ph = ed.parentElement!.querySelector<HTMLElement>('.message-input-placeholder')!
      const send = ed.closest('form')!.querySelector<HTMLElement>('button[type="submit"]')!
      const range = document.createRange()
      range.selectNodeContents(ph)
      return {
        textWidth: range.getBoundingClientRect().width,
        editorRight: ed.getBoundingClientRect().right,
        editorWidth: ed.getBoundingClientRect().width,
        phRight: ph.getBoundingClientRect().right,
        sendLeft: send.getBoundingClientRect().left,
        clientWidth: ph.clientWidth,
        scrollWidth: ph.scrollWidth,
      }
    })
    expect(g.textWidth).toBeGreaterThan(g.editorWidth)
    expect(g.phRight).toBeLessThanOrEqual(g.editorRight + EPSILON)
    expect(g.phRight).toBeLessThanOrEqual(g.sendLeft + EPSILON)
    expect(g.scrollWidth).toBeGreaterThan(g.clientWidth)
  })
})
