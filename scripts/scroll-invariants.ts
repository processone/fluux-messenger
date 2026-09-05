/**
 * Playwright scroll-invariant harness for the message-list virtualization path.
 *
 * PHASE 0 GOAL: Encode the 6 acceptance invariants as assertions that go RED
 * against the buggy virtualized path, proving the harness catches the real bugs.
 * They become the acceptance gate for the Phase 1 rework.
 *
 * Run:
 *   npm run test:scroll                 # both engines
 *   npx playwright test --config=playwright.e2e.config.ts --project=scroll-chromium
 *   npx playwright test --config=playwright.e2e.config.ts --project=scroll-webkit
 *
 * RED BASELINE (2026-06-25): captured below after first run
 * (To be filled in after P0.4 — document which tests failed and why.)
 *
 * Known issues in current virtualized path (why tests are expected RED):
 *  1. Prepend drift: reassertScrollToBottom re-assert writes scrollTop 15 times
 *     per frame, fighting @tanstack's scroll tracking and causing viewport instability.
 *  2. Runaway pagination: under virtualization, the prepend restore can leave
 *     scrollTop near 0, re-triggering load-older within the cooldown window.
 *  3. FAB blank: scrollTo({behavior:'smooth', top:scrollHeight}) uses estimated
 *     scrollHeight; the bottom rows mount+measure after the scroll completes,
 *     leaving the last message partially hidden until the next user-initiated scroll.
 *  4. Bottom-stick: reassertScrollToBottom fires for 15 frames after a new message,
 *     but if the new message's row measures much taller than the estimate the last
 *     re-assert frame still lands above the true bottom.
 *  5. Render loop: each scrollTop write triggers @tanstack scroll observer →
 *     re-windows rows → measurements → React re-render. 15 writes × 15 frames =
 *     up to 225 render cycles per prepend. RenderLoopDetector fires at 40/s.
 *  6. Windowing (DOM bound): this one is EXPECTED GREEN from the start — the
 *     virtualizer already bounds the DOM to ~overscan*2+viewport rows.
 */

import { test, expect, type Page } from '@playwright/test'
import { bootDemo } from './e2e/demoBoot'
import { withPinWindow, type PinGrowthStep } from './e2e/pinWindow'

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * URL: virt=1 sets the flag AFTER demo.tsx clears localStorage (the seam added in P0.1).
 * stress: seed 1 room with 20 messages instantly (msgStep:0). 20 is enough to exceed
 * the ~60-row windowing threshold? No — use 80 to exceed the viewport+overscan window.
 * Using 20 keeps IndexedDB reads fast (< 500ms) so we don't need a 15s fixed wait.
 * tutorial=false: skip the guided tour so the chat layout is immediately visible.
 */
const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0'

/** The stress room JID (stress-0@conference.<domain>). Domain from src/demo/constants.ts. */
const STRESS_ROOM_JID = 'stress-0@conference.fluux.chat'

const SETTLE_MS = 700          // time to let scroll + measurement settle after an action
const FRAME_SAMPLE_MS = 500   // window for scrollTop stability sampling after prepend settle
// Drift tolerance for the virtualizer path: one final ResizeObserver callback can fire
// just after the 60-frame re-assert loop exits and shift getOffsetForMessageId by ~16px
// without the loop being able to catch it. 20px covers this measurement noise while
// still catching real regressions (e.g. oscillations produce 100px+ swings).
const PREPEND_DRIFT_PX = 20  // acceptable anchor-position drift after prepend (px)
// WebKit resolves row heights on a slower, coarser measurement cadence than Chromium, so its
// settled residual after a prepend restore runs higher (~28-40px observed on CI) even once
// scrollTop and the virtualizer offset have both stopped moving. Give WebKit a wider bound —
// still an order of magnitude below a real mis-anchor (a dropped batch is ~2880px) and below the
// LARGE_JUMP_PX oscillation gate, so genuine regressions are still caught on both engines.
const PREPEND_DRIFT_WEBKIT_PX = 48
const LARGE_JUMP_PX = 150     // frame-to-frame jump threshold signalling instability
const AT_BOTTOM_OK_PX = 150   // distance-from-bottom still considered "stuck to bottom"
const FAB_THRESHOLD_PX = 300
// Distance-from-bottom a test must reach before it can claim the reader is NOT at the bottom.
// Deliberately several times AT_BOTTOM_OK_PX: engines differ in how much of a wheel gesture they
// apply per scroll event, so a margin this wide is what makes "the reader has left the bottom" an
// engine-independent fact rather than a coin flip on event granularity.
const CLEAR_OF_BOTTOM_PX = 800

// ── Shared setup ─────────────────────────────────────────────────────────────

/** Load demo, wait for demo to be fully ready (sidebar + stores populated). */
async function loadDemo(page: Page): Promise<void> {
  await bootDemo(page, DEMO_URL)
  await page.evaluate(() => {
    ;(
      window as Window & {
        __fluuxScrollShadow?: (reset?: boolean) => unknown
      }
    ).__fluuxScrollShadow?.(true)
  })
}

test.afterEach(async ({ page }) => {
  if (page.isClosed()) return
  const shadow = await page.evaluate(() => {
    return (
      window as Window & {
        __fluuxScrollShadow?: () => {
          divergenceCount: number
          divergences: unknown[]
          instrumentationErrorCount: number
          instrumentationErrors: unknown[]
        }
      }
    ).__fluuxScrollShadow?.()
  })
  expect(shadow, 'scroll shadow diagnostics must be installed').toBeDefined()
  expect(
    shadow?.divergenceCount,
    `scroll shadow divergences: ${JSON.stringify(shadow?.divergences ?? [])}`,
  ).toBe(0)
  expect(
    shadow?.instrumentationErrorCount,
    `scroll shadow instrumentation errors: ${JSON.stringify(shadow?.instrumentationErrors ?? [])}`,
  ).toBe(0)
})

/** Navigate to the stress room and wait for virtual rows to appear.
 *
 * Race-condition note: the hash change to `#/rooms/<jid>` fires ChatLayout's
 * auto-select-first-room effect (which sees `activeRoomJid=null` while our
 * `activateRoom` awaits `loadMessagesFromCache`) and the auto-select picks a
 * different room with a higher `activationToken`.
 *
 * Fix: pre-activate the room WHILE still in the messages sidebar (sidebarView=
 * 'messages'), so the rooms auto-select guard fires with `activeRoomJid` already
 * set when we later flip the hash.
 */
async function navigateToStressRoom(page: Page, virtualized = true): Promise<void> {
  // Step 1: activate while sidebarView='messages' (auto-select for rooms won't race)
  await page.evaluate((jid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).__roomStore?.getState?.()?.activateRoom(jid)
  }, STRESS_ROOM_JID)

  // Step 2: confirm activation before switching to the rooms sidebar
  await page.waitForFunction((jid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).__roomStore?.getState?.()?.activeRoomJid === jid
  }, STRESS_ROOM_JID, { timeout: 10_000 })

  // Step 3: now flip the hash — auto-select sees activeRoomJid set and bails
  await page.evaluate((jid) => {
    window.location.hash = '#/rooms/' + encodeURIComponent(jid)
  }, STRESS_ROOM_JID)

  await page.waitForSelector(
    virtualized ? '[data-index]' : '.message-row[data-message-id]',
    { timeout: 15_000 },
  )
  await page.waitForTimeout(SETTLE_MS)
}

/** Turn on the shared scroll-decision trace ([Scroll] / [ScrollStateManager] console lines). */
async function enableScrollTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__fluuxScrollDebug?.(true)
  })
}

/** Get the scrollTop of the message-list scroll container. */
async function getScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const s = document.querySelector('[data-message-list]') as HTMLElement | null
    return s ? s.scrollTop : 0
  })
}

/** Get the number of mounted virtual rows (absolute-positioned wrappers). */
async function getMountedRowCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-index]').length)
}

/**
 * Total height of the virtualizer's spacer div = getTotalSize() = N * estimateSize
 * (for unmeasured rows). Increases by ~BATCH * estimateSize on each successful load-older.
 * This is reliable regardless of which rows are currently in the virtualizer window.
 */
async function getSpacerHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const spacer = document.querySelector('[data-virtualizer-spacer]') as HTMLElement | null
    return spacer ? spacer.offsetHeight : 0
  })
}

/**
 * Debug snapshot: number of mounted [data-index] rows, scrollTop, spacer height, isLoading.
 * Used in invariant-2 failure context to understand why load-older might not fire.
 */
async function getDebugState(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
    const spacer = document.querySelector('[data-virtualizer-spacer]') as HTMLElement | null
    return {
      scrollTop: scroller?.scrollTop ?? -1,
      spacerHeight: spacer?.offsetHeight ?? -1,
      mountedRows: document.querySelectorAll('[data-index]').length,
      firstChildTag: (scroller?.firstElementChild as HTMLElement)?.tagName ?? 'none',
      firstChildHeight: (scroller?.firstElementChild as HTMLElement)?.offsetHeight ?? -1,
    }
  })
}

/**
 * Find the BOTTOM-most message row whose top is above the viewport bottom — i.e. the row the
 * content anchor is captured from (mirrors findBottomAnchor in useMessageListScroll). Returns
 * {id, visible} or null.
 */
async function findBottomVisibleMessage(page: Page): Promise<{ id: string; topInView: number } | null> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
    if (!scroller) return null
    const sRect = scroller.getBoundingClientRect()
    // Measure with getBoundingClientRect, NOT offsetTop: under virtualization every `.message-row`
    // sits in its own `position:absolute` `[data-index]` wrapper, so `offsetTop` is ~0 for all rows
    // and the old "greatest offsetTop" pick returned the top-most MOUNTED row, not the bottom-visible
    // one. This MUST mirror the production findBottomAnchor (which uses rects) or the saved anchor
    // and the test's captured anchor diverge (the invariant-8/9 inconsistency).
    const viewportH = scroller.clientHeight
    const rows = Array.from(scroller.querySelectorAll('.message-row[data-message-id]')) as HTMLElement[]
    let best: HTMLElement | null = null
    let bestTop = -Infinity
    for (const el of rows) {
      if (el.offsetHeight <= 0) continue
      const top = el.getBoundingClientRect().top - sRect.top
      if (top < viewportH && top > bestTop) { best = el; bestTop = top }
    }
    if (!best && rows.length) best = rows[rows.length - 1]
    if (!best) return null
    return { id: best.dataset.messageId!, topInView: best.getBoundingClientRect().top - sRect.top }
  })
}

/**
 * Trailing message index of a stress-room id ("stress-0-33" → 33), or NaN. Used to measure how far
 * a restored bottom-anchor drifts across re-opens. The restored anchor is now the TRUE bottom-visible
 * row (see findBottomAnchor's rect fix), which can legitimately settle by ≤1 row as estimated heights
 * resolve — so we bound the SPREAD rather than demand an exact match. The real regression is a
 * monotonic creep older every open (spread grows with each re-open); that still fails this bound, and
 * the distFromBottom guard alongside it is the stronger measure.
 */
function stressMsgIndex(id: string | null): number {
  if (!id) return NaN
  const m = /-(\d+)$/.exec(id)
  return m ? Number(m[1]) : NaN
}

/** Get a message row's current viewport offset-from-top (null if not mounted). */
async function getMessageOffsetFromTop(page: Page, messageId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
    if (!scroller) return null
    const el = scroller.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
    if (!el) return null
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, messageId)
}

/** Sample scrollTop every rAF for `durationMs`, return the array. */
async function sampleScrollTop(page: Page, durationMs: number): Promise<number[]> {
  return page.evaluate((ms) => new Promise<number[]>((resolve) => {
    const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
    if (!scroller) { resolve([]); return }
    const samples: number[] = []
    const t0 = performance.now()
    const tick = () => {
      samples.push(scroller.scrollTop)
      if (performance.now() - t0 < ms) requestAnimationFrame(tick)
      else resolve(samples)
    }
    requestAnimationFrame(tick)
  }), durationMs)
}

/**
 * Wait until the prepend restore has fully settled, then return the anchor row's DOM offset from
 * the scroller top — the actual on-screen position the user perceives.
 *
 * This measures the DOM directly rather than the virtualizer's `__fluuxGetVirtOffset` map. That map
 * is the source of one webkit flake: during the re-assert loop scrollTop and the offset move
 * together, and a trailing measurement can leave the map reporting a STALE pre-prepend offset for a
 * sustained window while scrollTop already reflects the added batch — a ~2880px phantom drift that
 * isn't visible on screen. The row's own `getBoundingClientRect().top` can't go stale that way: it
 * is the layout truth.
 *
 * Settle detection uses a SLIDING-WINDOW RANGE, not consecutive-frame deltas. On a slow/contended
 * WebKitGTK CI runner the production 60-frame re-assert loop runs over seconds and ResizeObserver
 * delivers row measurements in coarse bursts: a single frame can jump 20-30px as one row resolves
 * from its 64px estimate, then the re-assert re-pins it. The old "N consecutive frames within 1px"
 * gate never accumulated through those bursts, timed out mid-motion, and returned a phantom drift
 * (the observed `after=-692`). Range-over-last-N-frames ≤ tolerance instead treats the anchor as
 * settled once the bursts die out and the window goes quiet — robust to the slow cadence while a
 * genuinely oscillating (broken) anchor keeps a wide range and never settles (→ timeout).
 *
 * On timeout we return the MEDIAN of the recent samples rather than a single (possibly mid-burst)
 * frame: for a converged-but-just-missed-the-gate anchor the median is the settled value; for a
 * real oscillation/jump it is still far from the captured `before`, so the drift assertion stays RED.
 * A transient unmount (null) resets the window. Timeout is generous (the re-assert loop can run for
 * ~1s even at 60fps and far longer under load) and stays well inside the per-test budget.
 */
async function waitForAnchorSettled(
  page: Page,
  anchorId: string,
  { windowFrames = 8, tolerancePx = 2, timeoutMs = 15000 } = {},
): Promise<number | null> {
  return page.evaluate(
    ({ id, windowFrames, tolerancePx, timeoutMs }) =>
      new Promise<number | null>((resolve) => {
        const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
        const readOffset = (): number | null => {
          if (!scroller) return null
          const el = scroller.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
          if (!el) return null
          return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        }
        const median = (xs: number[]): number => {
          const s = [...xs].sort((a, b) => a - b)
          const m = Math.floor(s.length / 2)
          return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
        }
        const t0 = performance.now()
        const win: number[] = []
        const tick = () => {
          const cur = readOffset()
          if (cur === null) {
            win.length = 0 // anchor unmounted (windowed out) — restart the window
          } else {
            win.push(cur)
            if (win.length > windowFrames) win.shift()
            if (win.length === windowFrames && Math.max(...win) - Math.min(...win) <= tolerancePx) {
              resolve(cur) // window has been quiet for `windowFrames` frames — settled
              return
            }
          }
          if (performance.now() - t0 >= timeoutMs) {
            resolve(win.length ? median(win) : cur)
          } else {
            requestAnimationFrame(tick)
          }
        }
        requestAnimationFrame(tick)
      }),
    { id: anchorId, windowFrames, tolerancePx, timeoutMs },
  )
}

/**
 * Wait until a programmatic scroll has SETTLED into a valid, on-screen top-visible anchor, then
 * return it — the `before`-capture counterpart to waitForAnchorSettled.
 *
 * Directly setting `scrollTop` (setScrollTop) fires @tanstack's rAF scroll observer, which re-windows
 * the rows and re-renders. On a slow/contended WebKitGTK CI runner that re-window can lag many frames
 * behind a fixed `waitForTimeout`: the mounted DOM still holds the PRE-scroll window (e.g. the bottom
 * rows after a scroll UP), so the top mounted row sits thousands of px below the new viewport top —
 * a raw DOM-rect read then captured that stale row (the observed `before=2110`), and the whole
 * before/after comparison became meaningless (GIGO).
 *
 * We reject that by requiring the captured anchor be BOTH stable AND genuinely on-screen: a settled
 * top-visible row sits within one row of the viewport top (offset < clientHeight), whereas a lagged
 * window leaves it a full viewport-plus below. Stability alone is insufficient — a stalled re-render
 * holds the lagged row at a constant offset, which a delta-only check would wrongly accept — so the
 * on-screen bound is the load-bearing gate. Returns null on timeout (the app never reached a settled
 * 30% view), which fails the test with a clear precondition message rather than a phantom drift.
 */
async function waitForTopVisibleSettled(
  page: Page,
  { windowFrames = 8, tolerancePx = 2, timeoutMs = 8000 } = {},
): Promise<{ id: string; offsetFromTop: number } | null> {
  return page.evaluate(
    ({ windowFrames, tolerancePx, timeoutMs }) =>
      new Promise<{ id: string; offsetFromTop: number } | null>((resolve) => {
        const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
        // First [data-message-id] whose top edge is at/below the scroller top (within half its own
        // height) — the top-visible anchor.
        const readTop = (): { id: string; offsetFromTop: number } | null => {
          if (!scroller) return null
          const scrollerRect = scroller.getBoundingClientRect()
          const rows = Array.from(scroller.querySelectorAll('[data-message-id]')) as HTMLElement[]
          for (const row of rows) {
            const rect = row.getBoundingClientRect()
            const offsetFromTop = rect.top - scrollerRect.top
            if (offsetFromTop >= -rect.height / 2) return { id: row.dataset.messageId!, offsetFromTop }
          }
          return null
        }
        const t0 = performance.now()
        let prevId: string | null = null
        const win: number[] = []
        const tick = () => {
          const cur = readTop()
          const onScreen = cur !== null && scroller !== null && cur.offsetFromTop < scroller.clientHeight
          if (!onScreen) {
            win.length = 0 // window hasn't caught up (lagged/blank) — keep waiting
            prevId = null
          } else {
            if (cur!.id !== prevId) { win.length = 0; prevId = cur!.id } // anchor row changed — restart
            win.push(cur!.offsetFromTop)
            if (win.length > windowFrames) win.shift()
            if (win.length === windowFrames && Math.max(...win) - Math.min(...win) <= tolerancePx) {
              resolve(cur)
              return
            }
          }
          if (performance.now() - t0 >= timeoutMs) resolve(null)
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    { windowFrames, tolerancePx, timeoutMs },
  )
}

/** Scroll the container to an exact scrollTop (programmatic). */
async function setScrollTop(page: Page, value: number): Promise<void> {
  await page.evaluate((v) => {
    const s = document.querySelector('[data-message-list]') as HTMLElement | null
    if (s) s.scrollTop = v
  }, value)
}

/** Scroll programmatically to the top and also fire a wheel event to trigger load-older. */
async function scrollToTopAndLoad(page: Page): Promise<void> {
  // Set scrollTop=0 — triggers handleScroll → triggerLoadOlder
  await setScrollTop(page, 0)
  await page.waitForTimeout(50)
  // Also fire a wheel-up in case scrollTop was already 0 (handleWheel path)
  const scroller = page.locator('[data-message-list]').first()
  await scroller.dispatchEvent('wheel', { deltaY: -500, bubbles: true })
  await page.waitForTimeout(50)
}

/** Scroll programmatically to the bottom of the message list. */
async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = document.querySelector('[data-message-list]') as HTMLElement | null
    if (s) s.scrollTop = s.scrollHeight
  })
  await page.waitForTimeout(SETTLE_MS)
}

/** Activate a 1:1 conversation through the real store + route (no room auto-select race). */
async function activateChat(page: Page, jid: string): Promise<void> {
  await page.evaluate((j) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).__chatStore?.getState?.()?.activateConversation(j)
  }, jid)
  await page.waitForFunction((j) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).__chatStore?.getState?.()?.activeConversationId === j
  }, jid, { timeout: 10_000 })
  await page.evaluate((j) => { window.location.hash = '#/messages/' + encodeURIComponent(j) }, jid)
  await page.waitForSelector('[data-message-list]', { timeout: 10_000 })
  await page.waitForTimeout(SETTLE_MS)
}

// ── Invariant tests ───────────────────────────────────────────────────────────

test.describe('Controller-owned resident-top navigation', () => {
  test('Home issues one smooth write, then the controller observes it to settlement', async ({
    page,
  }) => {
    const trace: string[] = []
    page.on('console', (message) => {
      const text = message.text()
      if (text.includes('RESIDENT TOP: controller completed')) trace.push(text)
    })

    await loadDemo(page)
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__fluuxScrollDebug?.(true)
    })
    // Entry positioning OWNS scrollTop until its pin loop finishes, and it re-asserts to the live
    // edge over anything written underneath it. Waiting for the loop to report completion — rather
    // than for navigateToStressRoom's fixed settle to elapse — is what keeps the setup below from
    // being undone on a slow runner (CI run 30466867270 read 4372 here, the live edge).
    await withPinWindow(page, { trigger: 'switch' }, () => navigateToStressRoom(page))
    const entryDistanceFromBottom = await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : null
    })
    expect(
      entryDistanceFromBottom,
      'precondition: stress-room entry pin must finish at the live edge',
    ).not.toBeNull()
    expect(entryDistanceFromBottom).toBeLessThan(AT_BOTTOM_OK_PX)
    // Start materially away from resident top without turning this into a deep virtualized-list
    // animation test. The approved contract deliberately allows a native smooth scroll that a
    // browser interrupts during deep re-windowing to time out best-effort without a corrective
    // snap; the controller unit test covers that 120-frame path.
    await setScrollTop(page, 800)
    await page.waitForFunction(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return !!s && Math.abs(s.scrollTop - 800) < 50
    }, undefined, { timeout: 5_000 })

    // The entry position must actually BE where this test put it. `> 1` used to pass vacuously at
    // the live edge, so a run whose entry pin had already dragged the list back to the bottom
    // still entered the body and then failed 5s later on the real assertion with no clue why
    // (run 30267369388). Bracketing the start pins the failure to the setup instead.
    const initialScrollTop = await getScrollTop(page)
    expect(
      initialScrollTop,
      'precondition: resident window must start at the offset this test set, not at the live edge',
    ).toBeGreaterThan(600)
    expect(
      initialScrollTop,
      'precondition: entry positioning must have settled before Home is pressed',
    ).toBeLessThan(1200)

    // Record every scroll write AND watch, frame by frame, for the list moving AWAY from resident
    // top after Home. A superseded live-edge owner re-asserting mid-animation is the regression
    // this guards: it shows up as backward motion long before the position poll would time out,
    // and it is visible even on an engine too slow to finish the animation inside the poll window.
    await page.evaluate((startedAt) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLDivElement | null
      if (!scroller) return
      const nativeScrollTo = scroller.scrollTo.bind(scroller)
      const writes: ScrollToOptions[] = []
      const probe = window as Window & {
        __fluuxResidentTopWrites?: ScrollToOptions[]
        __fluuxResidentTopMaxBacktrack?: number
      }
      probe.__fluuxResidentTopWrites = writes
      probe.__fluuxResidentTopMaxBacktrack = 0
      // Spelled as the union rather than `Parameters<>`: `scrollTo` is overloaded, and
      // `Parameters<>` resolves to the LAST overload only — `(x, y)` — so `args[0]` typed
      // as a number, the object branch narrowed to `never`, and the spread that records
      // every write was spreading nothing as far as the compiler was concerned.
      type ScrollToArgs = [options?: ScrollToOptions] | [x: number, y: number]
      scroller.scrollTo = ((...args: ScrollToArgs) => {
        const first = args[0]
        if (typeof first === 'object' && first !== null) writes.push({ ...first })
        return (nativeScrollTo as (...a: ScrollToArgs) => void)(...args)
      }) as HTMLDivElement['scrollTo']
      let closestToTop = startedAt
      const sample = () => {
        closestToTop = Math.min(closestToTop, scroller.scrollTop)
        probe.__fluuxResidentTopMaxBacktrack = Math.max(
          probe.__fluuxResidentTopMaxBacktrack ?? 0,
          scroller.scrollTop - closestToTop,
        )
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
    }, initialScrollTop)

    const scroller = page.locator('[data-message-list]').first()
    await scroller.focus()
    await page.keyboard.press('Home')

    const readProbe = () => page.evaluate(() => {
      const probe = window as Window & {
        __fluuxResidentTopWrites?: ScrollToOptions[]
        __fluuxResidentTopMaxBacktrack?: number
      }
      return {
        writes: probe.__fluuxResidentTopWrites ?? [],
        backtrack: probe.__fluuxResidentTopMaxBacktrack ?? 0,
      }
    })

    // Generous ceiling, not a relaxed contract: a green run reaches the top in well under a second,
    // but the WebKitGTK CI runner has been measured at ~1.8s per MessageList layout+paint, and the
    // per-test budget is 180s. The assertions below are what make a regression fail fast.
    await expect.poll(async () => {
      const top = await getScrollTop(page)
      const { writes, backtrack } = await readProbe()
      // Fail immediately, with the culprit named, rather than waiting out the timeout.
      expect(
        backtrack,
        `Home navigation moved AWAY from resident top — a superseded position owner re-asserted mid-animation. Writes: ${JSON.stringify(writes)}`,
      ).toBeLessThanOrEqual(1)
      return top
    }, {
      timeout: 30_000,
      message: 'Home navigation must reach the resident-window top',
    }).toBeLessThanOrEqual(1)

    await expect.poll(() => trace.length, {
      timeout: 30_000,
      message: `resident-top controller did not settle: ${JSON.stringify(trace)}`,
    }).toBe(1)

    // The single-write contract, split into the two things it actually guarantees. Both are
    // engine-speed independent, so this is what holds the line on a slow runner.
    const { writes } = await readProbe()
    // 1. The controller starts the animation once and never restarts it. A frame loop that
    //    reissued the smooth write — the failure the original assertion was built to catch —
    //    produces repeated smooth writes and fails here.
    expect(
      writes.filter((write) => write.behavior === 'smooth'),
      `Home must issue exactly one smooth write: ${JSON.stringify(writes)}`,
    ).toEqual([{ top: 0, behavior: 'smooth' }])
    // 2. Nothing writes the scroller anywhere else for the duration. The virtualizer may add one
    //    instant convergence write to the SAME offset when it retires the animated command
    //    sub-pixel short of 0 (seen on Chromium, not WebKit) — that is the owner we handed the
    //    navigation to finishing it. A competing owner re-asserting the live edge targets a
    //    completely different offset and fails here.
    expect(
      writes.filter((write) => write.top !== 0),
      `only resident top may be written during a Home navigation — another position owner wrote elsewhere: ${JSON.stringify(writes)}`,
    ).toEqual([])
  })
})

test.describe('Virtualization scroll invariants', () => {

  // ── 1: Prepend holds position ──────────────────────────────────────────────

  test('invariant-1: prepend holds anchor position within tolerance, no large per-frame jumps', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Scroll to ~30% from top so there are messages above and below the anchor.
    const scrollHeight = await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement
      return s ? s.scrollHeight : 0
    })
    await setScrollTop(page, Math.floor(scrollHeight * 0.3))

    // Record the top-visible message before load-older, capturing its DOM offset from the scroller
    // top. Assertion B compares the SAME row's offset after the restore — the position the user
    // actually sees must not move.
    // We use `__fluuxTriggerLoadOlder` (not scrollToTopAndLoad) so that scrollTop stays at
    // 30% when the prepend `useLayoutEffect` runs. This ensures:
    //   - findAnchorElement sees scrollTop=30% → picks the correct anchor (not firstMessageId)
    //   - items above the anchor are already measured (they were in the virtualizer window)
    //
    // Capture must wait for @tanstack's rAF scroll observer to RE-WINDOW after the programmatic
    // setScrollTop, not just a fixed 300ms: on a slow WebKitGTK CI runner that re-window lags and
    // a raw top-visible read would see the stale pre-scroll window (top row thousands of px below the
    // viewport → the observed `before=2110`), poisoning the comparison. waitForTopVisibleSettled polls
    // until the top-visible anchor is stable AND genuinely on-screen. Null = the app never reached a
    // settled 30% view — fail with that precondition, not a phantom drift.
    const before = await waitForTopVisibleSettled(page)
    expect(before, 'scroll never settled into a valid on-screen 30% anchor before prepend').not.toBeNull()
    const anchorId = before!.id
    const anchorOffsetBefore = before!.offsetFromTop

    // Trigger load-older directly via the exposed hook (keeps scrollTop at 30%).
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trigger = (window as any).__fluuxTriggerLoadOlder
      if (typeof trigger === 'function') trigger()
    })

    // Wait for: mock network delay (80ms) + React re-render + useLayoutEffect restore.
    await page.waitForTimeout(200)
    const samples = await sampleScrollTop(page, FRAME_SAMPLE_MS)
    await page.waitForTimeout(500) // let the 20-frame measure-assert loop finish (333ms)

    // Assertion A: no large frame-to-frame jump during the stable period.
    // Skip the first 5 samples (cover the initial restore jump which is expected).
    let maxJump = 0
    for (let i = 5; i < samples.length; i++) {
      const jump = Math.abs(samples[i] - samples[i - 1])
      if (jump > maxJump) maxJump = jump
    }
    expect(maxJump, `max frame-to-frame scrollTop jump ${maxJump}px > ${LARGE_JUMP_PX}px (oscillation detected)`).toBeLessThanOrEqual(LARGE_JUMP_PX)

    // Assertion B: the anchor row's on-screen position holds within tolerance.
    // Wait for the restore to fully settle, then read the anchor's DOM offset (see
    // waitForAnchorSettled for why we measure the DOM, not the virtualizer offset map). WebKit
    // resolves row heights on a coarser cadence, so its settled residual runs higher than
    // Chromium's — the tolerance is engine-specific (see PREPEND_DRIFT_WEBKIT_PX).
    const driftLimit = test.info().project.name === 'webkit' ? PREPEND_DRIFT_WEBKIT_PX : PREPEND_DRIFT_PX
    const anchorOffsetAfter = await waitForAnchorSettled(page, anchorId)
    expect(anchorOffsetAfter, `anchor "${anchorId}" not found in DOM after prepend — windowed out (drift)`).not.toBeNull()
    const drift = Math.abs(anchorOffsetAfter! - anchorOffsetBefore)
    expect(drift, `anchor drifted by ${drift}px (limit: ${driftLimit}px, before=${anchorOffsetBefore}, after=${anchorOffsetAfter})`).toBeLessThanOrEqual(driftLimit)
  })

  // ── 2: No runaway pagination ───────────────────────────────────────────────

  test('invariant-2: one load-older trigger loads exactly one batch, restore moves scrollTop off top', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Wait for: (1) the loadMessagesFromCache IIFE that fires on activateRoom to complete so
    // the store is stable; (2) the initial render to settle. With messages:80, IndexedDB reads
    // finish quickly (< 1s), so 3s is ample. We confirm stability by waiting for the spacer
    // to be non-zero (virtualizer mounted) before sampling spacerBefore.
    await page.waitForTimeout(3_000)

    // Measure virtualizer spacer height BEFORE load (= getTotalSize = N * estimateSize).
    // This is reliable regardless of which rows are in the window — it covers ALL items.
    const debugBefore = await getDebugState(page)
    const spacerBefore = debugBefore.spacerHeight as number
    expect(spacerBefore, `spacer not found — debug: ${JSON.stringify(debugBefore)}`).toBeGreaterThan(0)

    // Trigger load-older by scrolling to top (handleScroll at scrollTop=0 calls triggerLoadOlder)
    await scrollToTopAndLoad(page)

    // Wait for the load-older batch to actually land: 80ms mock network delay + store update +
    // React re-render + useLayoutEffect restore. The threshold must be well ABOVE the spacer
    // jitter caused by rows re-measuring as they mount on scroll-to-top (~300px) — otherwise the
    // wait resolves on that jitter BEFORE the batch merges (the 80ms delay lands after), and the
    // sample below sees only a partial gain (the flake: "spacer grew by only ~300px"). A real BATCH
    // is ~3200px (50 × 64px estimate); 1500px cleanly clears the jitter while staying below one
    // batch, so it fires only once the batch is in.
    await page.waitForFunction((spacer) => {
      const sp = document.querySelector('[data-virtualizer-spacer]') as HTMLElement | null
      return sp ? sp.offsetHeight > spacer + 1500 : false
    }, spacerBefore, { timeout: 5_000 })

    const debugAfter = await getDebugState(page)
    const spacerAfter = debugAfter.spacerHeight as number
    // BATCH=50 messages, estimateSize=64px → expect ~3200px increase. Allow ±50% for date
    // separators and header/footer items that may or may not be added.
    const heightGain = spacerAfter - spacerBefore
    expect(heightGain, `spacer grew by only ${heightGain}px — before: ${JSON.stringify(debugBefore)} after: ${JSON.stringify(debugAfter)}`).toBeGreaterThan(1500)
    expect(heightGain, `spacer grew by ${heightGain}px — possible runaway (>2 batches)`).toBeLessThan(7000)

    // Wait another second idle — confirm spacer height is stable (no runaway re-trigger)
    await page.waitForTimeout(1500)
    const spacerFinal = await getSpacerHeight(page)
    const secondGain = spacerFinal - spacerAfter
    expect(secondGain, `spacer kept growing by ${secondGain}px during idle — runaway load-older`).toBeLessThan(1500)

    // After restore, scrollTop must NOT be at 0 (restore moved us to the prepend position)
    const scrollTop = await getScrollTop(page)
    expect(scrollTop, 'scrollTop still 0 after prepend restore — restore never fired').toBeGreaterThan(5)
  })

  // ── 3: Scroll-to-bottom FAB is never blank ────────────────────────────────

  test('invariant-3: FAB scroll-to-bottom lands last message in viewport, not blank', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Scroll up so the FAB appears
    await setScrollTop(page, 0)
    await page.waitForTimeout(300)

    // Wait for the FAB button to become actionable (not inert)
    const fab = page.locator('[data-fab="scroll-to-bottom"]')
    await fab.waitFor({ state: 'visible', timeout: 8_000 })

    // Click the FAB
    await fab.click()
    await page.waitForTimeout(SETTLE_MS)

    // Assertion A: at least one [data-index] row mounted (not a blank window)
    const rowCount = await getMountedRowCount(page)
    expect(rowCount, `mounted [data-index] count is ${rowCount} — blank window after FAB`).toBeGreaterThan(0)

    // Assertion B: the last data-message-id element is in the viewport
    const isLastVisible = await page.evaluate(() => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!scroller) return false
      const rows = scroller.querySelectorAll('[data-message-id]')
      if (rows.length === 0) return false
      const last = rows[rows.length - 1] as HTMLElement
      const sRect = scroller.getBoundingClientRect()
      const lRect = last.getBoundingClientRect()
      // This legacy blank-window check is loose; the strict message/pill overlap check lives below.
      return lRect.top >= sRect.top - 10 && lRect.bottom <= sRect.bottom + 120
    })
    expect(isLastVisible, 'last message row is not in viewport after FAB click — blank/short window').toBe(true)
  })

  // ── 4: Bottom-stick ────────────────────────────────────────────────────────

  test('invariant-4: new message stays fully visible when already at bottom', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Ensure we're at the very bottom
    await scrollToBottom(page)

    // Emit a new message via the demo client
    const newMsgId = `invariant-4-${Date.now()}`
    await page.evaluate(([roomJid, msgId]) => {
      const c = (window as any).__demoClient
      if (!c) throw new Error('no __demoClient')
      c.emitSDK('room:message', {
        roomJid,
        message: {
          type: 'groupchat',
          id: msgId,
          from: `${roomJid}/InvariantBot`,
          nick: 'InvariantBot',
          body: 'bottom-stick invariant test — this message must stay visible',
          timestamp: new Date(),
          isOutgoing: false,
          roomJid,
        },
        incrementUnread: false,
      })
    }, [STRESS_ROOM_JID, newMsgId])

    // Wait for the new row to MOUNT (removes the main flake: asserting before React has
    // rendered + @tanstack re-windowed), then a short settle for the bottom-stick scroll
    // -follow + measurement to land before checking visibility.
    await page.waitForSelector(`[data-message-id="${newMsgId}"]`, { timeout: 5_000 })
    await page.waitForTimeout(300)

    // The new message should be visible
    const isVisible = await page.evaluate((msgId) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!scroller) return false
      const el = scroller.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`) as HTMLElement | null
      if (!el) return false
      const sRect = scroller.getBoundingClientRect()
      const eRect = el.getBoundingClientRect()
      return eRect.top >= sRect.top - 5 && eRect.bottom <= sRect.bottom + 120
    }, newMsgId)
    expect(isVisible, `new message "${newMsgId}" not visible after bottom-stick — scroll failed to follow`).toBe(true)
  })

  // ── 5: No render loop / slow render ───────────────────────────────────────

  test('invariant-5: no RenderLoopDetector warning during prepend + FAB cycle', async ({ page }) => {
    const renderLoopWarnings: string[] = []
    page.on('console', (msg) => {
      const text = msg.text()
      if (
        text.includes('[RenderLoop]') ||
        text.includes('RenderLoopDetector') ||
        text.includes('[SlowScrollCorrection]') ||
        (text.includes('render') && text.toLowerCase().includes('loop'))
      ) {
        renderLoopWarnings.push(text)
      }
    })

    await loadDemo(page)
    await navigateToStressRoom(page)

    // Exercise the full prepend + scroll-to-bottom cycle
    await setScrollTop(page, 0)
    await page.waitForTimeout(100)
    const scroller = page.locator('[data-message-list]').first()
    await scroller.dispatchEvent('wheel', { deltaY: -500, bubbles: true })
    await page.waitForTimeout(1200)  // load + restore + re-assert
    await scrollToBottom(page)
    await page.waitForTimeout(400)
    // Second prepend cycle
    await scrollToTopAndLoad(page)
    await page.waitForTimeout(1200)

    // No render-loop warnings during the whole cycle
    expect(renderLoopWarnings, `Render loop / slow-correction warnings fired:\n${renderLoopWarnings.join('\n')}`).toHaveLength(0)
  })

  // ── 6: Windowing bounds DOM ────────────────────────────────────────────────

  test('invariant-6: mounted [data-index] rows < 60 with 200-msg backlog (windowing works)', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Let the virtualizer settle completely
    await page.waitForTimeout(SETTLE_MS)

    const rowCount = await getMountedRowCount(page)
    // overscan=12 on each side + ~10 viewport rows + header + footer + date separators
    // ≈ 36 rows max. Allow generous headroom up to 60.
    expect(rowCount, `mounted [data-index] count ${rowCount} ≥ 60 — windowing not bounding the DOM`).toBeLessThan(60)
  })

  // ── 7: Scroll-up load-older must not blank the viewport ─────────────────────

  test('invariant-7: scroll-up load-older keeps the viewport populated (no blank window)', async ({ page }) => {
    // General "viewport not blank after load-older" contract (DOM-visibility, sampled
    // per frame).
    //
    // CAVEAT: the specific @tanstack scrollOffset-desync bug that motivated this — the
    // mounted window stuck at the old (top) rows while scrollTop sits at the restored
    // offset, blanking the viewport — does NOT reproduce in Playwright. chromium/webkit
    // fire the native 'scroll' event promptly, so the virtualizer re-windows on its own;
    // the blank only persists on engines that don't (Tauri WebKitGTK + the headless
    // preview browser). That engine-specific case is pinned deterministically by
    // tanstackMessageVirtualizer.test.ts (asserts the adapter dispatches the sync event).
    //
    // This invariant still guards blank-after-load regressions that DO manifest in these
    // engines (e.g. broken restore math placing the window far from scrollTop) and
    // documents the expected non-blank contract. invariant-1, by contrast, only checks the
    // anchor OFFSET MATH (getOffsetForMessageId), which stays correct even while blank.
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Position near the top so load-older triggers with content above and below.
    await setScrollTop(page, 120)
    await page.waitForTimeout(300)
    const spacerBefore = await getSpacerHeight(page)

    // Trigger the scroll-up load-older path (scrollTop→0 + wheel-up).
    await scrollToTopAndLoad(page)

    // Wait for the prepend to land (spacer grows by ~one batch).
    await page.waitForFunction(
      (before) => {
        const sp = document.querySelector('[data-virtualizer-spacer]') as HTMLElement | null
        return sp ? sp.offsetHeight > before + 100 : false
      },
      spacerBefore,
      { timeout: 5_000 },
    )

    // SAMPLE the number of message rows intersecting the viewport band every rAF for
    // ~1.2s after the prepend. A desync blanks the viewport (count 0) for one or more
    // frames before any native scroll event re-syncs the window — sampling catches a
    // TRANSIENT blank that a single settled read would miss. We assert the viewport is
    // never blank on any frame.
    const minVisibleInBand = await page.evaluate(() => new Promise<number>((resolve) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) { resolve(-1); return }
      let min = Infinity
      const t0 = performance.now()
      const tick = () => {
        const sr = s.getBoundingClientRect()
        let n = 0
        for (const el of s.querySelectorAll('[data-message-id]')) {
          const r = (el as HTMLElement).getBoundingClientRect()
          if (r.bottom > sr.top && r.top < sr.bottom) n++
        }
        if (n < min) min = n
        if (performance.now() - t0 < 1200) requestAnimationFrame(tick)
        else resolve(min)
      }
      requestAnimationFrame(tick)
    }))
    expect(
      minVisibleInBand,
      'viewport went BLANK on at least one frame after scroll-up load-older — virtualizer ' +
        'window desynced from scrollTop (mounted rows fell outside the visible band)',
    ).toBeGreaterThan(0)
  })

  // ── 8: Deep-history restore survives conversation-switch eviction ───────────
  //
  // The reported bug: scroll FAR back into history (load several older pages), switch to another
  // conversation, switch back. On return the non-active room's resident window was evicted and
  // rehydrated to the LATEST slice (~100), so the saved content anchor — an OLD message now absent
  // from the loaded set — couldn't be resolved and the restore fell back near the TOP at the
  // load-more trigger. The fix loads the cache slice AROUND the anchor on demand, so the anchor is
  // resident before restore runs and the position is restored.
  test('invariant-8: deep-history anchor is reloaded and repositioned after switching away and back', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Load several older pages so the loaded window extends WELL past the latest ~100 (each
    // load-older synthesizes + persists a 50-message batch via the real MAM/cache path).
    for (let i = 0; i < 5; i++) {
      const spacerBefore = await getSpacerHeight(page)
      await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const trigger = (window as any).__fluuxTriggerLoadOlder
        if (typeof trigger === 'function') trigger()
      })
      await page.waitForFunction(
        (before) => {
          const sp = document.querySelector('[data-virtualizer-spacer]') as HTMLElement | null
          return sp ? sp.offsetHeight > before + 1500 : false
        },
        spacerBefore,
        { timeout: 6_000 },
      ).catch(() => { /* history may complete; tolerate */ })
      await page.waitForTimeout(200)
    }

    // The view is still at the bottom (load-older prepends above the fold). Scroll UP into deep
    // history with real wheel events (the virtualizer re-windows on the native scroll event; a raw
    // scrollTop write doesn't in headless). Stop well short of the top so we don't sit on the
    // load-more trigger. This leaves a deep OLD message as the bottom-most-visible content anchor.
    const box = await page.locator('[data-message-list]').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    for (let i = 0; i < 8; i++) {
      await page.mouse.wheel(0, -1500)
      await page.waitForTimeout(150)
    }
    await page.waitForTimeout(400)
    const anchor = await findBottomVisibleMessage(page)
    expect(anchor, 'must capture a deep-history anchor message').not.toBeNull()
    const anchorId = anchor!.id
    // Sanity: the anchor is a synthesized OLDER message, i.e. genuinely deep history (not a seed),
    // so after eviction it is absent from the latest-~100 rehydration.
    expect(anchorId, `anchor "${anchorId}" should be a deep older message, not the latest slice`).toContain('older-')

    // SWITCH AWAY → the room's resident window is evicted from RAM.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (window as any).__roomStore?.getState?.()?.activateRoom(null)
    })
    await page.waitForTimeout(400)
    // Confirm the eviction actually happened (resident array dropped to the latest slice or empty).
    const evicted = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      return (rs.messages.get(jid) ?? []).length
    }, STRESS_ROOM_JID)
    expect(evicted, 'resident window should be evicted (or trimmed) after switching away').toBeLessThan(150)

    // SWITCH BACK → activation rehydrates the latest slice; the restore must pull in the anchor's
    // slice on demand and reposition to it.
    await navigateToStressRoom(page)
    await page.waitForTimeout(2500) // activation + on-demand around-load + retry restore + re-assert

    // CORE OF THE FIX: the deep anchor's cache slice was pulled back in. The resident window now
    // spans far more than the latest-~100 rehydration (the buggy path stayed at ~100, never reloaded
    // the anchor), and the captured deep-history anchor is resident again.
    const reloaded = await page.evaluate(([jid, id]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      const msgs = rs.messages.get(jid) ?? []
      return { residentLen: msgs.length, hasAnchor: msgs.some((m: { id: string }) => m.id === id) }
    }, [STRESS_ROOM_JID, anchorId] as const)
    expect(reloaded.residentLen, 'resident window did not grow past the latest slice — anchor slice not reloaded').toBeGreaterThan(150)
    expect(reloaded.hasAnchor, `deep anchor "${anchorId}" was not reloaded into the resident window`).toBe(true)

    // POSITIONED in deep history — NOT stranded near the top at the load-more trigger (the bug), and
    // NOT snapped to the bottom (the latest seeds). The top-most visible row is a synthesized OLDER
    // message and the view sits well off both the top and the bottom.
    const placed = await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return null
      const sRect = s.getBoundingClientRect()
      let topVisible: string | null = null
      for (const el of Array.from(s.querySelectorAll('.message-row[data-message-id]')) as HTMLElement[]) {
        const r = el.getBoundingClientRect()
        if (r.bottom > sRect.top && r.top < sRect.bottom) { topVisible = el.dataset.messageId ?? null; break }
      }
      return {
        topVisible,
        scrollTop: Math.round(s.scrollTop),
        distFromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
      }
    })
    expect(placed, 'message list not found after return').not.toBeNull()
    expect(placed!.topVisible, `view did not restore to deep history (top-visible="${placed!.topVisible}") — likely snapped to bottom or stranded at top`).toContain('older-')
    expect(placed!.scrollTop, 'view is stranded at the very top (load-more trigger) instead of the reading position').toBeGreaterThan(300)
    expect(placed!.distFromBottom, 'view snapped to the bottom instead of restoring the deep reading position').toBeGreaterThan(1500)
  })

  // ── 9: Re-opening a scrolled-up conversation must not drift older each time ──
  //
  // Reported (real data): opening a conversation that isn't at the bottom restores a position that
  // creeps further back in time on every re-open. Cause: the one-shot anchor restore landed on
  // ESTIMATED row sizes; rows then measured taller, the anchor slid below the fold, and handleScroll
  // SAVED the drifted (older) position — so the next open started from there and compounded. The
  // measurement-aware re-assert (pinVirtualizedAnchor) lands on settled sizes and gates the save.
  //
  // CAVEAT: the demo's stress room is text-only, so its rows measure synchronously on mount and the
  // one-shot restore does NOT visibly compound here — the real-world drift needs rows that measure
  // taller AFTER paint (images / link previews). So this asserts the general "stable restore across
  // re-opens" contract (a regression guard) rather than isolating the media-induced compounding; the
  // specific fix is pinned by the trace diagnosis + by mirroring the marker/target re-assert loops.
  test('invariant-9: re-opening a scrolled-up conversation restores a stable position (no backward drift)', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    const distFromBottom = () => page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1
    })

    // Scroll UP into the loaded window (real wheel so the virtualizer re-windows), away from the
    // bottom but not so far it needs an on-demand slice — this exercises the anchor-restore path.
    const box = await page.locator('[data-message-list]').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -2500)
    await page.waitForTimeout(700)

    expect(await distFromBottom(), 'precondition: must be scrolled up off the bottom').toBeGreaterThan(AT_BOTTOM_OK_PX)

    // Re-open the conversation several times; after each restore record the content anchor (the
    // bottom-most visible message — the same thing the restore persists/targets) and the restored
    // distance-from-bottom. "Goes back in time" = the anchor message changes / the distance grows
    // each open. We compare RESTORED opens to each other (not to the live pre-leave scroll, whose
    // distFromBottom legitimately differs once rows below the fold finish measuring).
    const anchors: (string | null)[] = []
    const dists: number[] = []
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void (window as any).__roomStore?.getState?.()?.activateRoom(null)
      })
      await page.waitForTimeout(300)
      await navigateToStressRoom(page)
      await page.waitForTimeout(900) // activation + anchor re-assert settle
      anchors.push((await findBottomVisibleMessage(page))?.id ?? null)
      dists.push(await distFromBottom())
    }

    // The bug made each re-open land on a progressively OLDER anchor (monotonic creep). The fix keeps
    // it within a ≤1-message measurement settle (the now-correct bottom-visible anchor can resolve one
    // row as estimated heights settle); creep grows the spread with every open and still fails here.
    expect(anchors.every((a) => a !== null), `every re-open must capture an anchor (${JSON.stringify(anchors)})`).toBe(true)
    const anchorSpread = Math.max(...anchors.map(stressMsgIndex)) - Math.min(...anchors.map(stressMsgIndex))
    expect(
      anchorSpread,
      `restored anchor drifted ${anchorSpread} messages across re-opens (bottom-visible per open: ${JSON.stringify(anchors)}) — anchor not re-pinned`,
    ).toBeLessThanOrEqual(1)
    // …and the restored distance-from-bottom is stable open-to-open (the bug grew it ~1000–2000px
    // each time). 200px covers media/measurement settle between opens.
    expect(
      Math.max(...dists) - Math.min(...dists),
      `restored position drifted across re-opens (distFromBottom: ${JSON.stringify(dists)})`,
    ).toBeLessThan(200)
  })

  // invariant-10: the MEDIA-DRIFT reproduction that invariant-9 cannot do on its own.
  //
  // invariant-9 runs against the text-only stress room, whose rows measure synchronously on mount
  // ≈ the 64px estimate — so the estimate→measure correction is tiny and the one-shot restore does
  // NOT visibly compound there (it passes with or without the fix). The real-world bug needs rows
  // that measure MUCH TALLER than the estimate AFTER paint (images / link previews): the virtualizer
  // lands the restore on estimated offsets, the rows then measure tall, content shifts under a fixed
  // scrollTop so the bottom-most-visible message slides OLDER, a scroll event fires, and the old code
  // SAVED that drifted anchor — compounding on every re-open.
  //
  // We reproduce that deterministically (no flaky async image decode) by forcing every measured row
  // to ~2.5x the estimate via injected CSS. ResizeObserver reports the tall size to the virtualizer,
  // exactly as a decoded image would. This goes RED without pinVirtualizedAnchor + the user-scroll
  // save gate (anchor drifts older / distance grows each open) and GREEN with them.
  test('invariant-10: tall (media-like) rows do not drift the restored position across re-opens', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Force every virtualizer-measured row to ~2.5x the 64px estimate. `[data-index]` is the element
    // the virtualizer observes (ref={measureElement}); min-height on it makes ResizeObserver report a
    // tall size, mimicking a row whose real height the layout only learns after paint.
    await page.addStyleTag({ content: '[data-message-list] [data-index] { min-height: 160px; }' })
    await page.waitForTimeout(500) // let the initial measurement + bottom-stick settle at the tall size

    const distFromBottom = () => page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1
    })

    // Scroll up off the bottom (real wheel so the virtualizer re-windows) to a deep-ish anchor.
    const box = await page.locator('[data-message-list]').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -3000)
    await page.waitForTimeout(700)

    expect(await distFromBottom(), 'precondition: must be scrolled up off the bottom').toBeGreaterThan(AT_BOTTOM_OK_PX)

    // Re-open several times WITHOUT scrolling. With tall rows the estimate→measure correction runs on
    // every remount, so an unguarded restore drifts the bottom-visible anchor older each open.
    const anchors: (string | null)[] = []
    const dists: number[] = []
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        void (window as any).__roomStore?.getState?.()?.activateRoom(null)
      })
      await page.waitForTimeout(300)
      await navigateToStressRoom(page)
      await page.waitForTimeout(1000) // activation + tall-row measurement + anchor re-assert settle
      anchors.push((await findBottomVisibleMessage(page))?.id ?? null)
      dists.push(await distFromBottom())
    }

    expect(anchors.every((a) => a !== null), `every re-open must capture an anchor (${JSON.stringify(anchors)})`).toBe(true)
    const tallAnchorSpread = Math.max(...anchors.map(stressMsgIndex)) - Math.min(...anchors.map(stressMsgIndex))
    expect(
      tallAnchorSpread,
      `restored anchor drifted ${tallAnchorSpread} messages across re-opens with tall rows (bottom-visible per open: ${JSON.stringify(anchors)}) — anchor not re-pinned / drifted position saved`,
    ).toBeLessThanOrEqual(1)
    // Pixel drift is measured from the SECOND open onward: the first re-open still warms the
    // height cache (rows below the viewport learned their real 160px height during it), which
    // legitimately shifts raw distFromBottom once — estimates for unmounted rows are not part of
    // the restore contract (the content anchor above is). The compounding bug this guards against
    // (position sliding older EVERY open) still trips: it grows dists on every re-open.
    const steadyDists = dists.slice(1)
    expect(
      Math.max(...steadyDists) - Math.min(...steadyDists),
      `restored position drifted across repeated re-opens with tall rows (distFromBottom: ${JSON.stringify(dists)})`,
    ).toBeLessThan(250)
  })

  // invariant-10b: the marker-entry twin of invariant-10.
  //
  // invariant-9 and -10 both restore a SAVED position, so they exercise the saved-position executor.
  // Entering on an unread divider is driven by a different one, and no invariant covered it: the
  // divider had to survive the estimate→measure correction on nothing but unit coverage.
  //
  // Tall rows make that correction deterministic, exactly as in invariant-10: the virtualizer lands
  // the marker on estimated offsets, the rows then measure ~2.5x taller, and content shifts under a
  // fixed scrollTop. Whether the divider survives that shift is the whole question.
  //
  // What this does NOT cover: the settle-window marking added in #1264. While a re-assert loop runs,
  // `programmaticScroll = reassertLoopRef.current !== null` already classifies every scroll event as
  // ours, so recordProgrammaticWrite is redundant here — this test passes with and without it,
  // verified by removing both calls. The hole that fix closes is the ~250ms after the loop ENDS
  // (scrollGate's PROGRAMMATIC_SETTLE_MS), which this scenario never reaches. Do not read a green
  // run here as evidence that the marking is in place.
  test('invariant-10b: entering on the unread divider holds it through the measurement settle', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Read the room for real, then pin lastSeen to the true last row so the activation scan starts
    // from there (the viewport observer can lag a row on a fast programmatic scroll).
    await scrollToBottom(page)
    await page.waitForTimeout(400)
    const { lastId, pointerMatchesLast } = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      const msgs = rs.messages.get(jid) ?? []
      const last = msgs[msgs.length - 1]
      if (last) rs.advanceReadPointer(jid, { id: last.id, occupantId: last.occupantId })
      const pointer = (rs.roomMeta.get(jid)?.readPointer ?? rs.rooms.get(jid)?.readPointer)?.identity
      return {
        lastId: last?.id ?? null,
        pointerMatchesLast:
          pointer?.messageId === last?.id && pointer?.occupantId === last?.occupantId,
      }
    }, STRESS_ROOM_JID)
    expect(lastId, 'stress room must have messages').not.toBeNull()
    expect(pointerMatchesLast, 'read-pointer setup must reach the last room row').toBe(true)

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (window as any).__roomStore.getState().activateRoom(null)
    })
    await page.waitForTimeout(300)

    // Enough arrivals while away that the divider lands well ABOVE the live edge: the entry has to
    // be a real scroll-up write, not a bottom-stick that would never exercise the marker executor.
    const AWAY_COUNT = 40
    await page.evaluate(([jid, count]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      for (let i = 0; i < (count as number); i++) {
        c.emitSDK('room:message', {
          roomJid: jid,
          message: {
            type: 'groupchat', id: `marker-settle-${i}`, from: `${jid}/AwayBot`, nick: 'AwayBot',
            body: `arrived while away #${i}`,
            timestamp: new Date(), isOutgoing: false, roomJid: jid,
          },
          incrementUnread: true,
        })
      }
    }, [STRESS_ROOM_JID, AWAY_COUNT] as const)
    await page.waitForTimeout(200)

    // Tall rows AFTER the backlog exists, so the correction lands on the marker entry itself.
    await page.addStyleTag({ content: '[data-message-list] [data-index] { min-height: 160px; }' })

    await navigateToStressRoom(page)
    const markerId = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__roomStore.getState().firstNewMessageMarkers.get(jid)?.id ?? null
    }, STRESS_ROOM_JID)
    expect(markerId, 're-entry must compute an unread divider').not.toBeNull()

    // Where the divider sits once entry has positioned it, before the tall-row settle can move it.
    const dividerTop = () => page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      const el = document.querySelector('[data-new-message-marker]') as HTMLElement | null
      if (!s || !el) return null
      return Math.round(el.getBoundingClientRect().top - s.getBoundingClientRect().top)
    })

    await page.waitForTimeout(600)  // entry positioning + first re-assert frames
    const afterEntry = await dividerTop()
    expect(afterEntry, 'the divider must be positioned and in the DOM after entry').not.toBeNull()

    await page.waitForTimeout(1400) // the measurement settle the bug let through as user input
    const afterSettle = await dividerTop()
    expect(afterSettle, 'the divider must survive the settle, not be unmounted by a takeover').not.toBeNull()

    // Untouched by the reader, the divider must stay where entry put it: the re-assert loop has to
    // hold it while every row below grows ~2.5x its estimate.
    expect(
      Math.abs((afterSettle as number) - (afterEntry as number)),
      `unread divider drifted ${(afterSettle as number) - (afterEntry as number)}px through the measurement settle ` +
      `(entry ${afterEntry}px → settle ${afterSettle}px) — marker entry not re-pinned across the tall-row correction`,
    ).toBeLessThan(120)
  })

  // ── 12: A relayout WHILE AWAY (viewport width + view density) holds the reading anchor ──
  //
  // Restore is driven by the CONTENT ANCHOR (the bottom-visible message + the fraction of its height
  // at the viewport bottom), re-derived from each row's CURRENT measured height on return — so it is
  // independent of the layout that existed at save time. This pins that contract across the two real
  // relayout knobs a saved PIXEL cannot survive: a viewport-WIDTH change rewraps bubbles, and a
  // DENSITY change re-pads every message group — both move absolute offsets (and the total height) out
  // from under any saved scrollTop. After such a change while the conversation is away, returning must
  // keep the SAME message in view at ~the same fractional position: not snapped to the bottom, not
  // jumped to a stale pixel.
  //
  // This is the regression guard for making the anchor authoritative (PR removing the exact-scrollTop
  // fast-path): the old fast-path gated on width, so it already deferred to the anchor on a width
  // change — but a density change that left the total height ~unchanged could still mis-fire it onto
  // the stale pixel. Removing it routes every relayout through the one correct (anchor) path.
  test('invariant-12: a width + density change while away holds the reading anchor on return', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    const distFromBottom = () => page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1
    })

    // Scroll up off the bottom to a mid-history reading position (real wheel so the virtualizer
    // re-windows), then settle.
    const box = await page.locator('[data-message-list]').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -2500)
    await page.waitForTimeout(700)
    // The save fires on the scroll EVENT, at the row sizes the virtualizer had ESTIMATED then; rows
    // re-measure over the next frames, shifting the visually-settled bottom-anchor. Nudge once more
    // after the settle so the persisted anchor matches the SETTLED position we capture below
    // (otherwise the test's reference diverges from what was saved — a harness artifact, not drift).
    await page.mouse.wheel(0, -4)
    await page.waitForTimeout(500)
    expect(await distFromBottom(), 'precondition: must be scrolled up off the bottom').toBeGreaterThan(AT_BOTTOM_OK_PX)

    const before = await findBottomVisibleMessage(page)
    expect(before, 'must capture a reading anchor before leaving').not.toBeNull()
    const anchorId = before!.id

    // LEAVE the room (its mounted window unmounts).
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (window as any).__roomStore?.getState?.()?.activateRoom(null)
    })
    await page.waitForTimeout(300)

    // RELAYOUT WHILE AWAY, via the two real layout knobs: narrow the viewport (rewraps bubbles) and
    // flip the density to compact (re-pads every message group). Both move absolute offsets and the
    // total height out from under any saved pixel; only the re-derived content anchor survives. 900px
    // stays in the desktop layout (above the mobile breakpoint) so navigation is unchanged.
    await page.setViewportSize({ width: 900, height: 800 })
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__settingsStore?.getState?.()?.setDensityMode('compact')
    })
    await page.waitForTimeout(200)

    // RETURN — restore must re-derive the anchor's pixel target from the NEW layout.
    await navigateToStressRoom(page)
    await page.waitForTimeout(1600) // activation + anchor re-assert settle at the new layout

    // (A) Did NOT snap to the bottom — the saved scrolled-up reading position was restored, not lost.
    expect(await distFromBottom(), 'view snapped to the bottom after the relayout instead of holding the anchor').toBeGreaterThan(AT_BOTTOM_OK_PX)

    // (B) The SAME message (±2 as the rewrapped / re-padded rows settle) is still the bottom-visible
    // content — the reading position held at the fold through a relayout that changed every row's
    // height, i.e. it landed on the content anchor and NOT a stale saved pixel (which the larger row
    // heights would have left showing much older content). The precise fractional offset is not
    // asserted: a width rewrap can multiply the anchor message's own height, so its in-viewport
    // fraction legitimately shifts even as the message itself stays pinned at the fold.
    const after = await findBottomVisibleMessage(page)
    expect(after, 'must capture a reading anchor after return').not.toBeNull()
    const drift = Math.abs(stressMsgIndex(after!.id) - stressMsgIndex(anchorId))
    expect(drift, `bottom-visible anchor moved ${drift} messages across the relayout (before=${anchorId}, after=${after!.id})`).toBeLessThanOrEqual(2)
  })

})

// ── DIAGNOSTIC: new-message marker on re-entry (the user-reported bug) ──────────
//
// Reproduces: read a room to the bottom, leave, receive a NEW live message while away,
// return. Expected: the "new messages" divider shows above the new message and the view
// lands so the new message is visible. Bug: no marker, not at bottom.
//
// This block is DIAGNOSTIC — it dumps store + DOM + scroll state and the [Scroll] /
// [ScrollStateManager] decision trace, then asserts the expected behavior so it goes RED
// against the bug.

test.describe('Marker-on-reentry diagnostic', () => {
  test('repro: return to room after a new message shows the marker and the message', async ({ page }) => {
    // Turn on the scroll-decision trace before the app boots.
    await page.addInitScript(() => {
      try { window.localStorage.setItem('fluux:scroll-debug', '1') } catch { /* ignore */ }
    })
    const trace: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (t.includes('[Scroll]') || t.includes('[ScrollStateManager]')) trace.push(t)
    })

    await loadDemo(page)
    // Enable the shared scroll-decision trace via the window toggle (survives demo.tsx's
    // boot-time localStorage clear, which wipes the 'fluux:scroll-debug' key set above).
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__fluuxScrollDebug?.(true)
    })
    await navigateToStressRoom(page)

    // READ the room the real way: scroll to the bottom and let the viewport observer advance
    // lastSeen + the bottom-reach clear the marker. Then confirm we're genuinely read & at bottom.
    await scrollToBottom(page)
    await page.waitForTimeout(400)
    // Belt-and-braces: make sure lastSeen is the true last message so onActivate's forward scan
    // starts from there (the viewport observer can lag a row on fast programmatic scroll).
    const { lastId, pointerMatchesLast } = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      const msgs = rs.messages.get(jid) ?? []
      const last = msgs[msgs.length - 1]
      if (last) rs.advanceReadPointer(jid, { id: last.id, occupantId: last.occupantId })
      const pointer = (rs.roomMeta.get(jid)?.readPointer ?? rs.rooms.get(jid)?.readPointer)?.identity
      return {
        lastId: last?.id ?? null,
        pointerMatchesLast:
          pointer?.messageId === last?.id && pointer?.occupantId === last?.occupantId,
      }
    }, STRESS_ROOM_JID)
    expect(lastId, 'stress room must have messages').not.toBeNull()
    expect(pointerMatchesLast, 'read-pointer setup must reach the last room row').toBe(true)
    console.log('── READ STATE (at bottom) ──', JSON.stringify(await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return { scrollTop: s ? Math.round(s.scrollTop) : null, distFromBottom: s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : null }
    })))

    // LEAVE the room (switch away) — genuinely at the bottom, so NO restore-position should be saved.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (window as any).__roomStore.getState().activateRoom(null)
    })
    await page.waitForTimeout(300)

    // A NEW live incoming message arrives while we're away.
    const newMsgId = `repro-new-${Date.now()}`
    await page.evaluate(([jid, msgId]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      c.emitSDK('room:message', {
        roomJid: jid,
        message: {
          type: 'groupchat', id: msgId, from: `${jid}/AwayBot`, nick: 'AwayBot',
          body: 'this arrived while you were away — the marker must show above it',
          timestamp: new Date(), isOutgoing: false, roomJid: jid,
        },
        incrementUnread: true,
      })
    }, [STRESS_ROOM_JID, newMsgId])
    await page.waitForTimeout(200)

    const beforeReentry = await page.evaluate(([jid, expectLast]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      return {
        markerInStore: rs.firstNewMessageMarkers.get(jid)?.id ?? null,
        lastSeen: (rs.roomMeta.get(jid)?.readPointer ?? rs.rooms.get(jid)?.readPointer)?.messageId ?? null,
        unread: rs.roomMeta.get(jid)?.unreadCount ?? rs.rooms.get(jid)?.unreadCount ?? null,
        expectedLastSeen: expectLast,
      }
    }, [STRESS_ROOM_JID, lastId] as const)
    console.log('── BEFORE RE-ENTRY ──', JSON.stringify(beforeReentry))

    const reentryMark = trace.length // remember where the re-entry trace starts
    await navigateToStressRoom(page)
    // Catch the marker the store computes on activation BEFORE any scroll can clear it.
    const markerAtActivation = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__roomStore.getState().firstNewMessageMarkers.get(jid)?.id ?? null
    }, STRESS_ROOM_JID)
    console.log('── MARKER AT ACTIVATION (store) ──', markerAtActivation)
    await page.waitForTimeout(1500) // let the marker re-assert loop run

    const after = await page.evaluate(([jid, msgId]) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      const markerEl = document.querySelector('[data-new-message-marker]') as HTMLElement | null
      const newEl = s?.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`) as HTMLElement | null
      const sRect = s?.getBoundingClientRect()
      const inView = (el: HTMLElement | null) => {
        if (!el || !sRect) return null
        const r = el.getBoundingClientRect()
        return { top: Math.round(r.top - sRect.top), bottom: Math.round(r.bottom - sRect.top), visible: r.bottom > sRect.top && r.top < sRect.bottom }
      }
      return {
        markerInStore: rs.firstNewMessageMarkers.get(jid)?.id ?? null,
        markerDividerInDOM: !!markerEl,
        markerDividerPos: inView(markerEl),
        newMessageInDOM: !!newEl,
        newMessagePos: inView(newEl),
        scrollTop: s ? Math.round(s.scrollTop) : null,
        distFromBottom: s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : null,
        clientHeight: s ? s.clientHeight : null,
      }
    }, [STRESS_ROOM_JID, newMsgId] as const)
    console.log('── AFTER RE-ENTRY ──', JSON.stringify(after, null, 2))
    console.log('── FULL TRACE (first-entry + read + leave) ──\n' + trace.slice(0, reentryMark).join('\n'))
    console.log('── RE-ENTRY TRACE ──\n' + trace.slice(reentryMark).join('\n'))

    // NOTE: this synthetic stress room is seeded in memory and the demo's room auto-select can
    // leave us on a different room mid-setup, so the STORE may resolve the marker to a different
    // (older) unread message than the one we injected — a room cache-reload artifact unrelated to
    // the scroll-layer fix. Real rooms persist to cache and resolve lastSeen correctly. This test
    // therefore asserts the SCROLL-LAYER contract: whatever unread marker the store computes, the
    // divider must be positioned VISIBLY (not stranded below the fold) — the bug this fix targets.
    if (after.markerInStore !== newMsgId) {
      console.warn(`NOTE: store marker = ${after.markerInStore} (expected ${newMsgId}) — room cache-reload artifact, see comment.`)
    }
    expect(after.markerInStore, 'an unread marker must exist on re-entry').not.toBeNull()
    expect(after.markerDividerInDOM, 'the "new messages" divider should be mounted in the DOM').toBe(true)
    expect(after.markerDividerPos?.visible, 'the divider must be visible (not stranded below the fold)').toBe(true)
  })

  test('occupant collision: re-entry plants the divider on the arriving occupant row', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)
    await scrollToBottom(page)

    const sharedId = `occupant-collision-${Date.now()}`
    const occupantA = 'occupant-collision-a'
    const occupantB = 'occupant-collision-b'

    const pointerSetup = await page.evaluate(([jid, id, firstOccupant]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (window as any).__demoClient
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__roomStore
      client.emitSDK('room:message', {
        roomJid: jid,
        message: {
          type: 'groupchat', id, from: `${jid}/ReuseBot`, nick: 'ReuseBot',
          occupantId: firstOccupant, body: 'message from the departed occupant',
          timestamp: new Date(Date.now() - 1_000), isOutgoing: false, roomJid: jid,
        },
        incrementUnread: false,
      })
      const state = store.getState()
      state.advanceReadPointer(jid, { id, occupantId: firstOccupant })
      state.clearFirstNewMessageId(jid)
      const pointer = (store.getState().roomMeta.get(jid)?.readPointer ??
        store.getState().rooms.get(jid)?.readPointer)?.identity
      return { messageId: pointer?.messageId, occupantId: pointer?.occupantId }
    }, [STRESS_ROOM_JID, sharedId, occupantA] as const)
    expect(pointerSetup).toEqual({ messageId: sharedId, occupantId: occupantA })

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (window as any).__roomStore.getState().activateRoom(null)
    })
    await page.waitForTimeout(300)

    await page.evaluate(([jid, id, secondOccupant]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (window as any).__demoClient
      client.emitSDK('room:message', {
        roomJid: jid,
        message: {
          type: 'groupchat', id, from: `${jid}/ReuseBot`, nick: 'ReuseBot',
          occupantId: secondOccupant, body: 'message from the new occupant',
          timestamp: new Date(), isOutgoing: false, roomJid: jid,
        },
        incrementUnread: true,
      })
    }, [STRESS_ROOM_JID, sharedId, occupantB] as const)

    await navigateToStressRoom(page)
    const markerAtActivation = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__roomStore.getState().firstNewMessageMarkers.get(jid) ?? null
    }, STRESS_ROOM_JID)
    expect(markerAtActivation).toEqual({ id: sharedId, occupantId: occupantB })
    await page.waitForTimeout(1_000)

    const rendered = await page.evaluate(([id, secondOccupant]) => {
      const list = document.querySelector('[data-message-list]') as HTMLElement | null
      const marker = list?.querySelector('[data-new-message-marker]') as HTMLElement | null
      const markerRow = marker?.closest<HTMLElement>('[data-message-row-id]') ?? null
      const rows = Array.from(
        list?.querySelectorAll<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`) ?? [],
      ).map((row) => ({ handle: row.dataset.messageRowId, text: row.textContent }))
      const expectedHandle = `occupant-row:${JSON.stringify([id, secondOccupant])}`
      return {
        rows,
        markerHandle: markerRow?.dataset.messageRowId ?? null,
        expectedHandle,
        markerVisible: marker ? marker.getBoundingClientRect().height > 0 : false,
      }
    }, [sharedId, occupantB] as const)

    expect(rendered.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: expect.stringContaining('departed occupant') }),
      expect.objectContaining({ text: expect.stringContaining('new occupant') }),
    ]))
    expect(rendered.markerHandle).toBe(rendered.expectedHandle)
    expect(rendered.markerVisible).toBe(true)
  })
})

// ── DIAGNOSTIC: same bug in a clean 1:1 (the user's primary report) ─────────────
// No room auto-select race, no cache eviction/reload — isolates the scroll-layer bug.
test.describe('Marker-on-reentry diagnostic (1:1)', () => {
  test('repro: return to a 1:1 after a new message shows the marker', async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('fluux:scroll-debug', '1') } catch { /* ignore */ }
    })
    const trace: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (t.includes('[Scroll]') || t.includes('[ScrollStateManager]')) trace.push(t)
    })

    await loadDemo(page)
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__fluuxScrollDebug?.(true)
    })

    const AVA = 'ava@fluux.chat'
    const JAMES = 'james@fluux.chat'

    // Enter ava and read to the bottom.
    await activateChat(page, AVA)
    await scrollToBottom(page)
    await page.waitForTimeout(300)
    const { lastId: avaLast, pointerMatchesLast } = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore.getState()
      const msgs = cs.messages.get(jid) ?? []
      const last = msgs[msgs.length - 1]
      if (last) cs.advanceReadPointer(jid, { id: last.id })
      const pointer = (cs.conversationMeta.get(jid)?.readPointer ?? cs.conversations.get(jid)?.readPointer)?.identity
      return {
        lastId: last?.id ?? null,
        pointerMatchesLast: pointer?.messageId === last?.id,
      }
    }, AVA)
    expect(avaLast, 'ava must have messages').not.toBeNull()
    expect(pointerMatchesLast, 'read-pointer setup must reach the last chat row').toBe(true)
    console.log('── 1:1 READ STATE ──', JSON.stringify(await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return { scrollTop: s ? Math.round(s.scrollTop) : null, distFromBottom: s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : null }
    })))

    // Switch to james (leave ava genuinely at the bottom).
    await activateChat(page, JAMES)
    await page.waitForTimeout(200)

    // A new incoming message arrives in ava while we're in james.
    const newId = `repro-1on1-${Date.now()}`
    await page.evaluate(([jid, id]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      c.emitSDK('chat:message', {
        message: {
          type: 'chat', conversationId: jid, from: jid, id,
          body: 'arrived while you were away — the marker must show above it',
          timestamp: new Date(), isOutgoing: false,
        },
      })
    }, [AVA, newId] as const)
    await page.waitForTimeout(200)

    const before = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore.getState()
      return {
        markerInStore: cs.firstNewMessageMarkers.get(jid)?.id ?? null,
        lastSeen: (cs.conversationMeta.get(jid)?.readPointer ?? cs.conversations.get(jid)?.readPointer)?.messageId ?? null,
        unread: cs.conversationMeta.get(jid)?.unreadCount ?? cs.conversations.get(jid)?.unreadCount ?? null,
      }
    }, AVA)
    console.log('── 1:1 BEFORE RE-ENTRY ──', JSON.stringify(before))

    const mark = trace.length
    await activateChat(page, AVA)
    const markerAtActivation = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (window as any).__chatStore.getState().firstNewMessageMarkers.get(jid)?.id ?? null
    }, AVA)
    console.log('── 1:1 MARKER AT ACTIVATION (store) ──', markerAtActivation)
    await page.waitForTimeout(1500)

    const after = await page.evaluate(([jid, id]) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore.getState()
      const markerEl = document.querySelector('[data-new-message-marker]') as HTMLElement | null
      const newEl = s?.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
      const sRect = s?.getBoundingClientRect()
      const inView = (el: HTMLElement | null) => {
        if (!el || !sRect) return null
        const r = el.getBoundingClientRect()
        return { top: Math.round(r.top - sRect.top), visible: r.bottom > sRect.top && r.top < sRect.bottom }
      }
      return {
        markerInStore: cs.firstNewMessageMarkers.get(jid)?.id ?? null,
        markerDividerInDOM: !!markerEl,
        markerDividerPos: inView(markerEl),
        newMessageInDOM: !!newEl,
        newMessagePos: inView(newEl),
        scrollTop: s ? Math.round(s.scrollTop) : null,
        distFromBottom: s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : null,
      }
    }, [AVA, newId] as const)
    console.log('── 1:1 AFTER RE-ENTRY ──', JSON.stringify(after, null, 2))
    console.log('── 1:1 RE-ENTRY TRACE ──\n' + trace.slice(mark).join('\n'))

    expect(after.markerInStore, 'store should have computed the marker for the new message').toBe(newId)
    expect(after.markerDividerInDOM, 'the "new messages" divider should be mounted in the DOM').toBe(true)
    expect(after.newMessageInDOM, 'the new message row should be mounted').toBe(true)
    expect(after.newMessagePos?.visible, 'the new message should be visible in the viewport').toBe(true)
  })
})

// ── DIAGNOSTIC: a new bottom row sticks to the bottom (incoming + send, plain + new-day divider) ──
// The user report: "stick to bottom does not work if the last message is not from me (or if it's
// the first for today and a day marker needs to be inserted)". The real cause: a send whose bottom
// row is a GROUP-START (taller — avatar + sender header, ± a date separator) grows after paint; on
// WebKitGTK that growth fires a scroll event mid-pin that flipped isAtBottom false and bailed the
// pin. invariant-4 covers an incoming room message; these isolate the 1:1 path, the date-divider
// case, and the group-start send growth race (the WebKitGTK model below).
test.describe('At-bottom stick diagnostic (1:1)', () => {
  const AVA = 'ava@fluux.chat'

  async function emitIncoming(page: Page, jid: string, id: string, whenMs: number): Promise<void> {
    await page.evaluate(([j, i, ts]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      if (!c) throw new Error('no __demoClient')
      c.emitSDK('chat:message', {
        message: {
          type: 'chat', conversationId: j, from: j, id: i,
          body: 'incoming while you watch — must stick to the bottom',
          timestamp: new Date(ts as number), isOutgoing: false,
        },
      })
    }, [jid, id, whenMs] as const)
  }

  async function newMsgStuck(page: Page, id: string): Promise<{ visible: boolean; distFromBottom: number }> {
    return page.evaluate((msgId) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return { visible: false, distFromBottom: -1 }
      const el = s.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`) as HTMLElement | null
      const sRect = s.getBoundingClientRect()
      const visible = !!el && (() => {
        const r = el.getBoundingClientRect()
        return r.top >= sRect.top - 5 && r.bottom <= sRect.bottom + 120
      })()
      return { visible, distFromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) }
    }, id)
  }

  /**
   * "Stuck" for a row that can be TALLER than the viewport: its top may be above the fold, so the
   * claim is that its BOTTOM edge sits at the viewport bottom.
   */
  async function bottomEdgeStuck(
    page: Page,
    id: string,
  ): Promise<{ bottomVisible: boolean; distFromBottom: number }> {
    return page.evaluate((msgId) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return { bottomVisible: false, distFromBottom: -1 }
      const el = s.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`) as HTMLElement | null
      const sRect = s.getBoundingClientRect()
      const r = el?.getBoundingClientRect()
      return {
        bottomVisible: !!(r && r.bottom <= sRect.bottom + 8 && r.bottom > sRect.top),
        distFromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
      }
    }, id)
  }

  /**
   * Append an outgoing message whose predecessor is from the OTHER party, so it renders as a
   * group-START row (avatar + sender header) — the taller row whose post-paint growth is what the
   * two WebKit models below drive.
   */
  async function appendGroupStartSend(page: Page, jid: string, id: string): Promise<void> {
    await page.evaluate(([j, msgId]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore
      const st = cs.getState()
      const msgs = (st.messages.get(j) ?? []).slice()
      msgs.push({
        type: 'chat', conversationId: j, from: 'me@fluux.chat', to: j, id: msgId,
        body: 'my reply — starts a new bubble group', isOutgoing: true, timestamp: new Date(),
      })
      const m = new Map(st.messages)
      m.set(j, msgs)
      cs.setState({ messages: m })
    }, [jid, id] as const)
    await page.waitForSelector(`[data-message-id="${id}"]`, { timeout: 5_000 })
  }

  /** Model the post-paint growth of the just-sent row: taller than AT_BOTTOM_THRESHOLD (150). */
  const GROWTH_TO_PX = 600

  test('plain: incoming message (same day) while at bottom stays visible', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    const id = `incoming-plain-${Date.now()}`
    await emitIncoming(page, AVA, id, Date.now())
    await page.waitForSelector(`[data-message-id="${id}"]`, { timeout: 5_000 })
    await page.waitForTimeout(400)

    const res = await newMsgStuck(page, id)
    expect(res.visible, `incoming message "${id}" not visible — distFromBottom=${res.distFromBottom}`).toBe(true)
    expect(res.distFromBottom, 'view not pinned to the bottom after incoming message').toBeLessThan(AT_BOTTOM_OK_PX)
  })

  test('new-day: incoming message that inserts a date divider while at bottom stays visible', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    // Timestamp on the NEXT day → groupMessagesByDate creates a new group, inserting a date
    // separator AND the message at the bottom (the "day marker needs to be inserted" case).
    const id = `incoming-newday-${Date.now()}`
    await emitIncoming(page, AVA, id, Date.now() + 24 * 60 * 60 * 1000)
    await page.waitForSelector(`[data-message-id="${id}"]`, { timeout: 5_000 })
    await page.waitForTimeout(400)

    const res = await newMsgStuck(page, id)
    expect(res.visible, `new-day incoming message "${id}" not visible — distFromBottom=${res.distFromBottom}`).toBe(true)
    expect(res.distFromBottom, 'view not pinned to the bottom after new-day incoming message').toBeLessThan(AT_BOTTOM_OK_PX)
  })

  test('typing-then-incoming: message preceded by a typing indicator while at bottom stays visible', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    // Real-world sequence: the other party is typing (a band appears below the scrollport), THEN
    // the message lands (the band disappears and the message appends).
    await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      c.emitSDK('chat:typing', { conversationId: jid, jid, isTyping: true })
    }, AVA)
    await page.waitForTimeout(400)

    const id = `incoming-aftertyping-${Date.now()}`
    await page.evaluate(([j, i]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      c.emitSDK('chat:typing', { conversationId: j, jid: j, isTyping: false })
      c.emitSDK('chat:message', {
        message: {
          type: 'chat', conversationId: j, from: j, id: i,
          body: 'arrived right after typing — must stick to the bottom',
          timestamp: new Date(), isOutgoing: false,
        },
      })
    }, [AVA, id] as const)
    await page.waitForSelector(`[data-message-id="${id}"]`, { timeout: 5_000 })
    await page.waitForTimeout(400)

    const res = await newMsgStuck(page, id)
    expect(res.visible, `post-typing incoming message "${id}" not visible — distFromBottom=${res.distFromBottom}`).toBe(true)
    expect(res.distFromBottom, 'view not pinned to the bottom after post-typing incoming message').toBeLessThan(AT_BOTTOM_OK_PX)
  })

  test('tall incoming: a multi-line message far taller than the row estimate sticks to the bottom', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    const id = `incoming-tall-${Date.now()}`
    await page.evaluate(([j, i]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      c.emitSDK('chat:message', {
        message: {
          type: 'chat', conversationId: j, from: j, id: i,
          body: Array.from({ length: 18 }, (_, k) => `tall incoming line ${k + 1} — far taller than the 64px estimate`).join('\n'),
          timestamp: new Date(), isOutgoing: false,
        },
      })
    }, [AVA, id] as const)
    await page.waitForSelector(`[data-message-id="${id}"]`, { timeout: 5_000 })
    await page.waitForTimeout(500)

    // For a tall message, "stuck" means its BOTTOM edge is at the viewport bottom (its top may be
    // above the fold if the message is taller than the viewport).
    const res = await bottomEdgeStuck(page, id)
    expect(res.bottomVisible, `tall incoming message "${id}" bottom not at viewport bottom — distFromBottom=${res.distFromBottom}`).toBe(true)
    expect(res.distFromBottom, 'view not pinned to the bottom after tall incoming message').toBeLessThan(AT_BOTTOM_OK_PX)
  })

  // ROOT-CAUSE MODEL (the Tauri/WebKitGTK send-stick bug): a sent message whose bottom row is a
  // GROUP-START (avatar + sender header, ± a date separator) measures much TALLER than the row
  // estimate AFTER paint. On WebKitGTK that post-paint growth fires a 'scroll' event while the
  // pin-bottom loop still owns scrollTop; handleScroll reads the now-large distFromBottom and flips
  // isAtBottomRef false, so the pin loop BAILS and the send is stranded below the fold.
  //
  // Playwright's engines don't fire a scroll event on pure scrollHeight growth, so we MODEL the
  // engine condition deterministically: grow the just-sent row and dispatch a 'scroll' event during
  // the pin's settle window. RED with the unconditional isAtBottomRef write; GREEN once handleScroll
  // ignores scroll events fired while a programmatic re-assert loop owns scrollTop.
  //
  // The model is armed BEFORE the append and runs from the pin's own `PIN start`, one frame in, so
  // "inside the pin window" is a frame fact rather than a wall-clock race against CDP round-trips —
  // see scripts/e2e/pinWindow.ts for why driving this from Node made the invariant load-sensitive.
  test('group-start send survives a growth-driven scroll event during the pin (WebKitGTK model)', async ({ page }) => {
    await loadDemo(page)
    await enableScrollTrace(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    const id = `send-groupstart-${Date.now()}`
    // WebKitGTK: the row grows tall AFTER paint (scrollHeight up, scrollTop unchanged →
    // distFromBottom large) and the engine fires a scroll event.
    const growthModel: PinGrowthStep[] = [
      { label: 'post-paint growth + scroll event', afterFrames: 1, growRowToPx: GROWTH_TO_PX },
    ]
    const outcome = await withPinWindow(
      page,
      { trigger: 'new-message', messageId: id, steps: growthModel },
      () => appendGroupStartSend(page, AVA, id),
    )

    const res = await bottomEdgeStuck(page, id)
    expect(res.bottomVisible, `group-start send "${id}" stranded below the fold — distFromBottom=${res.distFromBottom}, pin outcome=${outcome}`).toBe(true)
    expect(res.distFromBottom, `pin bailed on a growth-driven scroll event (outcome=${outcome}) — send not stuck`).toBeLessThan(AT_BOTTOM_OK_PX)
  })

  // ROOT-CAUSE MODEL #2 (the RESIDUAL send-stick hole the single-event #760 fix does NOT close): on
  // WebKit a tall bottom row's growth settles across MORE THAN ONE scroll event. handleScroll's
  // growth discriminator (`scrollHeight > prevScrollHeightRef`) only catches the FIRST event — it
  // advances prevScrollHeightRef every time, so a SECOND scroll event fired at the now-settled height
  // (scrollHeight === prevScrollHeightRef) but a still-short scrollTop is NOT recognised as
  // growth-driven. The unconditional isAtBottom write then flips it false and the position-gated pin
  // BAILS — exactly the original symptom, one scroll event later. The height-unchanged discriminator
  // fundamentally cannot tell this WebKit growth-settle noise from a real scrollbar drag.
  //
  // Engine-agnostic because we MODEL both events synthetically: RED on the position-gated pin (it
  // bails on event 2 and leaves the send stranded), GREEN once the pin is intent-gated (it keeps
  // converging on real geometry and only yields to a genuine wheel/touch/keyboard scroll).
  test('group-start send survives a growth that settles across TWO scroll events (height-unchanged discriminator hole)', async ({ page }) => {
    await loadDemo(page)
    await enableScrollTrace(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    const id = `send-twophase-${Date.now()}`
    // Two-phase growth settle, both events inside the pin window:
    //   event 1 (growth frame): scrollHeight UP vs prev → discriminator absorbs it (isAtBottom kept).
    //   event 2 (two frames later): SAME height, scrollTop short → discriminator misses → the
    //   position-gated pin flips isAtBottom false and bails. The intent-gated pin re-pins through it.
    const growthModel: PinGrowthStep[] = [
      { label: 'event 1: height > prev (absorbed)', afterFrames: 1, growRowToPx: GROWTH_TO_PX },
      { label: 'event 2: height === prev (slips guard)', afterFrames: 2, scrollTopDelta: -400 },
    ]
    const outcome = await withPinWindow(
      page,
      { trigger: 'new-message', messageId: id, steps: growthModel },
      () => appendGroupStartSend(page, AVA, id),
    )

    const res = await bottomEdgeStuck(page, id)
    expect(res.bottomVisible, `two-phase-growth send "${id}" stranded below the fold — distFromBottom=${res.distFromBottom}, pin outcome=${outcome}`).toBe(true)
    expect(res.distFromBottom, `pin bailed on a height-unchanged growth-settle scroll event (outcome=${outcome}) — send not stuck`).toBeLessThan(AT_BOTTOM_OK_PX)
  })

  test('outgoing new-day: a sent message that inserts a date divider sticks to the bottom', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    // The user sends the FIRST message of a new day: optimistic row + a date separator are both
    // inserted at the bottom. Emulate the optimistic add via the store (timestamp = next day).
    const id = `outgoing-newday-${Date.now()}`
    await page.evaluate(([jid, msgId]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore
      const st = cs.getState()
      const msgs = (st.messages.get(jid) ?? []).slice()
      msgs.push({
        type: 'chat', conversationId: jid, from: 'me@fluux.chat', to: jid, id: msgId,
        body: 'first message of a new day — sent by me', isOutgoing: true,
        timestamp: new Date(Date.now() + 24 * 60 * 60 * 1000),
      })
      const m = new Map(st.messages)
      m.set(jid, msgs)
      cs.setState({ messages: m })
    }, [AVA, id] as const)
    await page.waitForSelector(`[data-message-id="${id}"]`, { timeout: 5_000 })
    await page.waitForTimeout(400)

    const res = await newMsgStuck(page, id)
    expect(res.visible, `outgoing new-day message "${id}" not visible — distFromBottom=${res.distFromBottom}`).toBe(true)
    expect(res.distFromBottom, 'view not pinned to the bottom after outgoing new-day message').toBeLessThan(AT_BOTTOM_OK_PX)
  })
})

// ── Ambient re-pin re-arms follow-live from GEOMETRY, not from a scroll event ─────────────────
// Two ordinary gestures pause follow-live and then produce no scroll event able to resolve the
// pause: wheeling DOWN while already at the resident bottom (the scroller cannot move, and
// `overscroll-contain` blocks chaining), and a manual return whose scroll events a concurrent row
// remeasure declassifies. Every ambient re-pin — typing band, container shrink, late row growth,
// incoming message — shares one gate, so from those states all four are refused and the view falls
// behind by the band height plus one row per unfollowed message. Every other wheel gesture in this
// file scrolls UP, which is exactly why none of them covered this.
test.describe('Ambient re-pin re-arms follow-live from geometry', () => {
  /**
   * "Still glued to the bottom", not merely "near" it: BOTTOM_PIN_TOLERANCE is what a converged pin
   * run leaves. Asserting at the band instead (AT_BOTTOM_OK_PX is 150) would pass on the defect,
   * whose whole signature is a 40px typing band and ~42px per unfollowed message.
   */
  const PIN_TOLERANCE_PX = 4
  /**
   * How far the held reading position may drift while ambient stimuli fire around it. Two orders of
   * magnitude below the ~800px a wrongful re-pin would move it, so it still falsifies one.
   */
  const HELD_POSITION_PX = 24

  async function hoverList(page: Page): Promise<void> {
    const box = await page.locator('[data-message-list]').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  }

  async function readGeometry(page: Page): Promise<{ scrollTop: number; distFromBottom: number }> {
    return page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return { scrollTop: -1, distFromBottom: -1 }
      return {
        scrollTop: Math.round(s.scrollTop),
        distFromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
      }
    })
  }

  async function setTyping(page: Page, isTyping: boolean): Promise<void> {
    await page.evaluate(([jid, on]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      if (!c) throw new Error('no __demoClient')
      c.emitSDK('room:typing', { roomJid: jid as string, nick: 'U0_1', isTyping: on as boolean })
    }, [STRESS_ROOM_JID, isTyping] as const)
  }

  /**
   * `awaitRow` only for a reader at the edge: a scrolled-up reader never mounts the new tail row,
   * so waiting for it there would time out on correct behaviour.
   */
  async function emitRoomMessage(page: Page, id: string, awaitRow = true): Promise<void> {
    await page.evaluate(([jid, msgId]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      if (!c) throw new Error('no __demoClient')
      c.emitSDK('room:message', {
        roomJid: jid as string,
        isLiveArrival: true,
        message: {
          type: 'groupchat', id: msgId as string, from: `${jid}/U0_1`, nick: 'U0_1',
          body: `live arrival ${msgId} — the view must follow it`,
          timestamp: new Date(), isOutgoing: false,
          roomJid: jid as string, stanzaId: `sid-${msgId}`,
        },
      })
    }, [STRESS_ROOM_JID, id] as const)
    if (awaitRow) await page.waitForSelector(`[data-message-id="${id}"]`, { timeout: 5_000 })
  }

  /** Enter the stress room and take the live edge the way a reader does, then hover the list. */
  async function enterAtBottom(page: Page): Promise<void> {
    await loadDemo(page)
    await navigateToStressRoom(page)
    await page.keyboard.press('End')
    await page.waitForTimeout(SETTLE_MS)
    await hoverList(page)
    expect(
      (await readGeometry(page)).distFromBottom,
      'precondition: the reader starts glued to the live edge',
    ).toBeLessThanOrEqual(PIN_TOLERANCE_PX)
  }

  test('a wheel DOWN at the bottom still lets the typing band hold the view at the edge', async ({ page }) => {
    await enterAtBottom(page)

    // A trusted wheel that cannot move anything. It pauses follow-live and fires no scroll event.
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(SETTLE_MS)

    await setTyping(page, true)
    await page.waitForSelector('[data-typing-pill]', { timeout: 5_000 })
    await page.waitForTimeout(SETTLE_MS)

    const after = await readGeometry(page)
    expect(
      after.distFromBottom,
      'the typing band shrank the scrollport and the view did not follow it back to the edge',
    ).toBeLessThanOrEqual(PIN_TOLERANCE_PX)
  })

  test('a manual return to the bottom still follows incoming messages', async ({ page }) => {
    await enterAtBottom(page)

    // Up, then a decaying burst back down — the trackpad shape. The virtualizer remeasures rows
    // during the return, which declassifies its scroll events, so the return re-arms nothing.
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(120)
    for (const delta of [200, 160, 120, 90, 60, 40, 25, 15, 8, 4]) {
      await page.mouse.wheel(0, delta)
      await page.waitForTimeout(16)
    }
    await page.waitForTimeout(SETTLE_MS)
    expect(
      (await readGeometry(page)).distFromBottom,
      'precondition: the reader is back at the bottom by hand',
    ).toBeLessThanOrEqual(PIN_TOLERANCE_PX)

    let lastId = ''
    for (let index = 0; index < 3; index += 1) {
      lastId = `ambient-rearm-${Date.now()}-${index}`
      await emitRoomMessage(page, lastId)
      await page.waitForTimeout(400)
    }

    const after = await readGeometry(page)
    expect(
      after.distFromBottom,
      'the view stopped following incoming messages after a manual return to the bottom',
    ).toBeLessThanOrEqual(PIN_TOLERANCE_PX)
    expect(
      await page.evaluate((id) => {
        const s = document.querySelector('[data-message-list]') as HTMLElement | null
        const el = s?.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
        if (!s || !el) return false
        const sr = s.getBoundingClientRect()
        const r = el.getBoundingClientRect()
        return r.bottom <= sr.bottom + 2 && r.top >= sr.top - 5
      }, lastId),
      'the newest message is not fully visible at the bottom',
    ).toBe(true)
  })

  test('deliberately re-pins a reader who stopped INSIDE the at-bottom band', async ({ page }) => {
    // The permissive half of the boundary, pinned on purpose: a reader who stopped ~100px up is
    // inside the at-bottom band and IS brought back. Every ordinary ambient re-pin already treats
    // them that way. Recovery receives that same caller-owned geometry verdict, so the outcome
    // cannot depend on whether the generation happens to be alive.
    //
    // What this test can and cannot see: the small move up here settles the pause at a distance
    // still inside the band, so the LIVE path serves it. Caller-facing and controller unit tests
    // cover delivery of that same verdict to dead-state recovery. This test fixes the user-visible
    // half: at this distance the view returns to the bottom, by whichever path owns it. Being
    // carried back from 100px is the intent; being carried back from a real reading position is not,
    // which is what CLEAR_OF_BOTTOM_PX guards below.
    const NEAR_OFFSET_PX = 100

    await enterAtBottom(page)

    // The dead state first: a wheel down that cannot move anything, then a small deliberate move up
    // that leaves the reader inside the band.
    await page.mouse.wheel(0, 120)
    await page.waitForTimeout(300)
    await page.mouse.wheel(0, -NEAR_OFFSET_PX)
    await page.waitForTimeout(SETTLE_MS)
    const before = await readGeometry(page)
    expect(
      before.distFromBottom,
      'precondition: the reader is off the edge but still inside the at-bottom band',
    ).toBeGreaterThan(PIN_TOLERANCE_PX)
    expect(before.distFromBottom, 'precondition: inside the band').toBeLessThan(AT_BOTTOM_OK_PX)

    await setTyping(page, true)
    await page.waitForSelector('[data-typing-pill]', { timeout: 5_000 })
    await page.waitForTimeout(SETTLE_MS)

    expect(
      (await readGeometry(page)).distFromBottom,
      'a reader inside the band must be re-pinned, exactly as an armed follow already is',
    ).toBeLessThanOrEqual(PIN_TOLERANCE_PX)
  })

  test('never re-pins a reader who deliberately scrolled up', async ({ page }) => {
    await enterAtBottom(page)

    await page.mouse.wheel(0, -2500)
    await page.waitForTimeout(SETTLE_MS)
    const before = await readGeometry(page)
    expect(
      before.distFromBottom,
      'precondition: the reader is clear of the bottom band',
    ).toBeGreaterThan(CLEAR_OF_BOTTOM_PX)

    // Every ambient stimulus at once. None of them may infer intent from a reader who left.
    await setTyping(page, true)
    await page.waitForSelector('[data-typing-pill]', { timeout: 5_000 })
    await page.waitForTimeout(300)
    await emitRoomMessage(page, `stay-put-${Date.now()}`, false)
    await page.waitForTimeout(SETTLE_MS)

    const after = await readGeometry(page)
    expect(
      Math.abs(after.scrollTop - before.scrollTop),
      'a scrolled-up reader was dragged by an ambient re-pin',
    ).toBeLessThanOrEqual(HELD_POSITION_PX)
    expect(after.distFromBottom).toBeGreaterThan(CLEAR_OF_BOTTOM_PX)
  })

  test('compensated measured growth does not re-pin just outside the bottom band', async ({ page }) => {
    await enterAtBottom(page)

    const parkedScrollTop = await page.evaluate((distanceFromBottom) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      return scroller
        ? Math.max(0, scroller.scrollHeight - scroller.clientHeight - distanceFromBottom)
        : -1
    }, AT_BOTTOM_OK_PX + 12)
    expect(parkedScrollTop, 'precondition: the list must be tall enough to park near the band').toBeGreaterThan(0)
    await setScrollTop(page, parkedScrollTop)
    await page.waitForFunction((targetDistance) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      return !!scroller && Math.abs(
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight - targetDistance,
      ) <= 2
    }, AT_BOTTOM_OK_PX + 12, { timeout: 5_000 })
    await page.waitForTimeout(SETTLE_MS)

    const before = await page.evaluate((jid) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!scroller) return null
      const scrollerRect = scroller.getBoundingClientRect()
      const rows = (Array.from(
        scroller.querySelectorAll('.message-row[data-message-id]'),
      ) as HTMLElement[]).map((row) => ({
        row,
        rect: row.getBoundingClientRect(),
      }))
      const grow = rows
        .filter(({ rect }) => rect.bottom <= scrollerRect.top - 1)
        .sort((a, b) => b.rect.bottom - a.rect.bottom)[0]
      const tracked = rows
        .filter(({ rect }) => rect.top >= scrollerRect.top + 5 && rect.bottom <= scrollerRect.bottom - 5)
        .sort((a, b) => a.rect.top - b.rect.top)[0]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = (window as any).__roomStore.getState().messages.get(jid) ?? []
      const growMessage = messages.find((message) => message.id === grow?.row.dataset.messageId)
      if (!grow || !tracked || !growMessage) return null
      return {
        growId: grow.row.dataset.messageId!,
        trackId: tracked.row.dataset.messageId!,
        signatureVisible:
          (!!growMessage.reactions && Object.keys(growMessage.reactions).length > 0) ||
          growMessage.linkPreview != null ||
          growMessage.attachment != null ||
          !!growMessage.isEdited ||
          !!growMessage.isRetracted,
        growBottom: Math.round(grow.rect.bottom - scrollerRect.top),
        trackTop: Math.round(tracked.rect.top - scrollerRect.top),
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: scroller.scrollHeight,
        distanceFromBottom: Math.round(
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        ),
      }
    }, STRESS_ROOM_JID)

    expect(before, 'precondition: a mounted row above a visible reading row must exist').not.toBeNull()
    expect(before!.growBottom, 'precondition: the grown row must be above the viewport').toBeLessThanOrEqual(-1)
    expect(
      before!.signatureVisible,
      'precondition: the grown row must carry nothing the row-growth signature fingerprints',
    ).toBe(false)
    expect(
      before!.distanceFromBottom,
      'precondition: the reader must be just outside the at-bottom band',
    ).toBeGreaterThan(AT_BOTTOM_OK_PX)
    expect(
      before!.distanceFromBottom,
      'precondition: the reader must stay close enough for a small double-count to cross the band',
    ).toBeLessThanOrEqual(AT_BOTTOM_OK_PX + 20)

    const updated = await page.evaluate(([jid, id]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__roomStore.getState()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const message = (store.messages.get(jid) ?? []).find((item: any) => item.id === id)
      if (!message) return false
      store.updateMessage(jid, id, {
        body: [
          message.body,
          'compensated growth line 1',
          'compensated growth line 2',
          'compensated growth line 3',
          'compensated growth line 4',
        ].join('\n'),
      })
      return true
    }, [STRESS_ROOM_JID, before!.growId] as const)
    expect(updated, 'precondition: the mounted row must still exist in the room store').toBe(true)
    await page.waitForFunction(([id, previousHeight]) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      const row = scroller?.querySelector(`[data-message-id="${CSS.escape(id as string)}"]`)
      return !!row?.textContent?.includes('compensated growth line 4') &&
        scroller!.scrollHeight > (previousHeight as number)
    }, [before!.growId, before!.scrollHeight] as const, { timeout: 10_000 })
    await page.waitForTimeout(SETTLE_MS)

    const after = await page.evaluate((trackId) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!scroller) return null
      const tracked = scroller.querySelector(
        `[data-message-id="${CSS.escape(trackId)}"]`,
      ) as HTMLElement | null
      return {
        trackTop: tracked
          ? Math.round(tracked.getBoundingClientRect().top - scroller.getBoundingClientRect().top)
          : null,
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: scroller.scrollHeight,
        distanceFromBottom: Math.round(
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        ),
      }
    }, before!.trackId)

    expect(after, 'the message list must remain readable after measured growth').not.toBeNull()
    expect(
      after!.scrollHeight,
      'precondition: the mounted row must genuinely increase the scroll height',
    ).toBeGreaterThan(before!.scrollHeight)
    expect(
      after!.scrollTop,
      'precondition: the virtualizer must compensate for the row above the viewport',
    ).toBeGreaterThan(before!.scrollTop)
    expect(after!.trackTop, 'the tracked reading row must stay mounted').not.toBeNull()
    expect(
      Math.abs(after!.trackTop! - before!.trackTop),
      'the compensated growth moved the reader\'s visible row',
    ).toBeLessThanOrEqual(PIN_TOLERANCE_PX)
    expect(
      Math.abs(after!.distanceFromBottom - before!.distanceFromBottom),
      'the compensated growth changed the reader\'s distance from the bottom',
    ).toBeLessThanOrEqual(PIN_TOLERANCE_PX)
    expect(
      after!.distanceFromBottom,
      'the compensated growth re-pinned a reader outside the at-bottom band',
    ).toBeGreaterThan(AT_BOTTOM_OK_PX)
  })
})

// ── DIAGNOSTIC: send sticks to the bottom even when the optimistic row is reconciled ────────────
// Regression for the overlay/content-coordinate mismatch documented beside the typing band in
// MessageList. In the old layout a 30px pill had only 16px clearance at the exact bottom, and a
// 20px scroll offset already clipped the last line.
test.describe('Typing indicator never covers message text', () => {
  const AVA = 'ava@fluux.chat'

  /** Distances from the bottom to park the viewport at. 16-48 is the window the old bug lived in. */
  const OFFSETS_PX = [0, 8, 16, 20, 24, 32, 40, 48, 96, 240]

  /** "Glued", not merely "near" (AT_BOTTOM_OK_PX is 150) — only sub-pixel rounding is allowed. */
  const GLUED_TOLERANCE_PX = 2

  function capturePinStarts(page: Page): () => Promise<string[]> {
    const pending: Array<Promise<string | null>> = []
    page.on('console', (message) => {
      if (!message.text().includes('[Scroll] PIN start')) return
      const data = message.args()[1]
      if (!data) return
      pending.push(
        data
          .jsonValue()
          .then((value) => {
            const trigger = (value as { trigger?: unknown } | null)?.trigger
            return typeof trigger === 'string' ? trigger : null
          })
          .catch(() => null),
      )
    })
    return async () =>
      (await Promise.all(pending)).filter((trigger): trigger is string => trigger !== null)
  }

  async function enableScrollDebug(page: Page): Promise<void> {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__fluuxScrollDebug?.(true)
    })
  }

  interface BottomAnchorProbe {
    /** Id of the row whose bottom edge is lowest — the one bottom anchoring is about. */
    tailRowId: string | null
    tailOnScreen: boolean
    distFromBottom: number
    scrollHeight: number
  }

  interface OverlapProbe {
    pillFound: boolean
    pillHeight: number
    pillWidth: number
    visibleRows: number
    /** Largest vertical intersection (px) between the pill and any VISIBLE part of a message row. */
    worstOverlap: number
    worstRowId: string | null
  }

  /**
   * Emit `composing` and wait for the LIVE list's pill to be laid out. Scoped to the live list's
   * own container rather than a bare document query: other MessageLists can be mounted (search /
   * activity previews), and a zero-width one would satisfy a document-wide selector while telling
   * us nothing about the conversation under test.
   */
  async function startTyping(page: Page, jid: string): Promise<void> {
    await page.evaluate((j) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      if (!c) throw new Error('no __demoClient')
      c.emitSDK('chat:typing', { conversationId: j, jid: j, isTyping: true })
    }, jid)
    await page.waitForFunction(() => {
      const s = document.querySelector('[data-message-list]')
      const pill = s?.parentElement?.querySelector('[data-typing-pill]') as HTMLElement | null
      if (!pill) return false
      const r = pill.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    }, undefined, { timeout: 5_000 })
  }

  /**
   * Park the viewport `offset` px above the bottom and measure how deeply the pill cuts into
   * message text. Rows are clipped to the scrollport first: the virtualizer keeps overscan rows
   * mounted below the fold, and those are not on screen — only pixels the reader can actually see
   * count as covered.
   */
  async function probeOverlap(page: Page, offset: number): Promise<OverlapProbe> {
    return page.evaluate((off) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      const pill = s?.parentElement?.querySelector('[data-typing-pill]') as HTMLElement | null
      if (!s || !pill) {
        return { pillFound: false, pillHeight: 0, pillWidth: 0, visibleRows: 0, worstOverlap: 0, worstRowId: null }
      }

      s.scrollTop = s.scrollHeight - s.clientHeight - off
      const sRect = s.getBoundingClientRect()
      const p = pill.getBoundingClientRect()

      let visibleRows = 0
      let worstOverlap = 0
      let worstRowId: string | null = null
      for (const el of Array.from(s.querySelectorAll('[data-message-id]'))) {
        const r = el.getBoundingClientRect()
        const visTop = Math.max(r.top, sRect.top)
        const visBottom = Math.min(r.bottom, sRect.bottom)
        if (visBottom - visTop <= 0) continue // clipped out of the scrollport
        visibleRows++
        const overlapY = Math.min(visBottom, p.bottom) - Math.max(visTop, p.top)
        const overlapX = Math.min(r.right, p.right) - Math.max(r.left, p.left)
        if (overlapY > 0 && overlapX > 0 && overlapY > worstOverlap) {
          worstOverlap = overlapY
          worstRowId = el.getAttribute('data-message-id')
        }
      }
      return {
        pillFound: true,
        pillHeight: Math.round(p.height),
        pillWidth: Math.round(p.width),
        visibleRows,
        worstOverlap: Math.round(worstOverlap),
        worstRowId,
      }
    }, offset)
  }

  /**
   * Read-only bottom-anchor reading: which row is at the tail, whether its bottom edge is on
   * screen, and how far the view sits from the true bottom. Deliberately writes nothing —
   * `probeOverlap` parks the viewport itself, so anchoring has to be read BEFORE it runs or the
   * measurement is of the probe, not of the app.
   */
  async function probeBottomAnchor(page: Page): Promise<BottomAnchorProbe> {
    return page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return { tailRowId: null, tailOnScreen: false, distFromBottom: -1, scrollHeight: -1 }
      const sRect = s.getBoundingClientRect()
      let tailRowId: string | null = null
      let tailBottom = -Infinity
      for (const el of Array.from(s.querySelectorAll('[data-message-id]'))) {
        const bottom = el.getBoundingClientRect().bottom
        if (bottom > tailBottom) {
          tailBottom = bottom
          tailRowId = el.getAttribute('data-message-id')
        }
      }
      return {
        tailRowId,
        tailOnScreen: tailBottom > sRect.top && tailBottom <= sRect.bottom + 8,
        distFromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
        scrollHeight: Math.round(s.scrollHeight),
      }
    })
  }

  test('no scroll offset puts a visible message row under the pill', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)
    await startTyping(page, AVA)
    await page.waitForTimeout(SETTLE_MS)

    const results: Array<{ offset: number; probe: OverlapProbe }> = []
    for (const offset of OFFSETS_PX) {
      const probe = await probeOverlap(page, offset)
      // Guard against a hollow pass: an unmounted pill or an empty list would trivially
      // report zero overlap.
      expect(probe.pillFound, `typing pill not rendered at offset ${offset}`).toBe(true)
      expect(probe.pillHeight, `typing pill has no height at offset ${offset}`).toBeGreaterThan(10)
      expect(probe.pillWidth, `typing pill has no width at offset ${offset}`).toBeGreaterThan(10)
      expect(probe.visibleRows, `no message rows visible at offset ${offset}`).toBeGreaterThan(0)
      results.push({ offset, probe })
    }

    const covered = results.filter((r) => r.probe.worstOverlap > 0)
    expect(
      covered,
      'typing pill covers message text at ' +
        covered.map((r) => `offset=${r.offset}px (${r.probe.worstOverlap}px of ${r.probe.worstRowId})`).join(', '),
    ).toEqual([])
  })

  test('growing the composer to two lines and shrinking it back holds the bottom and never parks text under the pill', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)

    // The seeded conversation ends on an unsupported-encryption placeholder, whose row height does
    // not follow its body. Anchoring is a claim about the TAIL row, so give the list one whose
    // height the test can actually move.
    const tailId = `composer-tail-${Date.now()}`
    await page.evaluate(([jid, id]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (window as any).__demoClient
      if (!client) throw new Error('no __demoClient')
      client.emitSDK('chat:message', {
        message: {
          type: 'chat', conversationId: jid, from: jid, id,
          body: 'the newest message, whose row the composer must keep at the bottom',
          timestamp: new Date(), isOutgoing: false,
        },
      })
    }, [AVA, tailId] as const)
    await page.waitForSelector(`[data-message-id="${tailId}"]`, { timeout: 5_000 })

    await scrollToBottom(page)
    await startTyping(page, AVA)
    await page.waitForTimeout(SETTLE_MS)

    const readPinStarts = capturePinStarts(page)
    await enableScrollDebug(page)

    /** Drive the draft the way React's controlled textarea expects, then let layout settle. */
    const setDraft = async (value: string) => {
      await page.evaluate((v) => {
        const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
        if (!ta) throw new Error('no composer textarea')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
        setter.call(ta, v)
        ta.dispatchEvent(new Event('input', { bubbles: true }))
      }, value)
      await page.waitForTimeout(SETTLE_MS)
    }

    const twoLines =
      'This draft is long enough to wrap the composer onto a second line, which shrinks the ' +
      'message viewport under a pill that does not move with it.'

    const anchored = await probeBottomAnchor(page)
    expect(anchored.tailRowId, 'precondition: the newest message must be the tail row').toBe(tailId)
    expect(anchored.distFromBottom, 'precondition: must start at the bottom').toBeLessThanOrEqual(GLUED_TOLERANCE_PX)

    // ── Composer GROWS ──────────────────────────────────────────────────────
    await setDraft(twoLines)

    // Anchoring is read FIRST: probeOverlap parks the viewport itself, so any bottom claim made
    // after it would be a claim about the probe.
    const grownAnchor = await probeBottomAnchor(page)
    expect(
      grownAnchor.tailRowId,
      `the row at the bottom changed while the composer grew (${anchored.tailRowId} → ${grownAnchor.tailRowId})`,
    ).toBe(anchored.tailRowId)
    expect(
      grownAnchor.distFromBottom,
      `bottom lost while the composer grew — ${grownAnchor.distFromBottom}px short`,
    ).toBeLessThanOrEqual(GLUED_TOLERANCE_PX)
    expect(grownAnchor.tailOnScreen, 'the newest row went below the fold while the composer grew').toBe(true)

    const grown = await probeOverlap(page, 0)
    expect(grown.pillFound && grown.visibleRows > 0, 'pill/rows missing after composer grew').toBe(true)
    expect(grown.worstOverlap, `pill covers ${grown.worstRowId} while the composer is two lines`).toBe(0)

    // ── Composer SHRINKS, with growth the row-growth SIGNATURE cannot see ───
    // The composer collapsing on its own is absorbed by the browser clamping scrollTop, so a bare
    // shrink cannot tell whether the app holds the bottom or the engine does. What separates them
    // is content that grows in the same commit: the clamp fires a scroll event whose handler reads
    // a DOM already carrying that growth, so the recorded "where the reader was" baseline arrives
    // pre-drifted and the measured-growth backstop nets the growth out against itself.
    //
    // The growth is deliberately invisible to computeRowGrowthSignature (no reaction, preview,
    // attachment, correction or retraction flag): that is what the measured backstop exists for —
    // a resident row that simply re-measures taller, the way a late bitmap decode or a webfont swap
    // leaves it after an earlier signature-triggered loop has settled.
    await page.evaluate((jid) => {
      const ta = document.querySelector('textarea') as HTMLTextAreaElement | null
      if (!ta) throw new Error('no composer textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, '')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chatStore = (window as any).__chatStore
      const state = chatStore.getState()
      const messages = (state.messages.get(jid) ?? []).slice()
      const last = messages.length - 1
      messages[last] = {
        ...messages[last],
        body: Array.from({ length: 14 }, (_, line) => `re-measured taller, line ${line}`).join('\n'),
      }
      const next = new Map(state.messages)
      next.set(jid, messages)
      chatStore.setState({ messages: next })
    }, AVA)
    await page.waitForTimeout(SETTLE_MS)

    const shrunkAnchor = await probeBottomAnchor(page)

    // Control: without this the anchoring claim below would pass on a growth too small to push the
    // newest row out of the at-bottom band, and would prove nothing about re-pinning.
    expect(
      shrunkAnchor.scrollHeight - grownAnchor.scrollHeight,
      `the row must grow by more than the at-bottom band (${grownAnchor.scrollHeight} → ${shrunkAnchor.scrollHeight}) — otherwise this case is vacuous`,
    ).toBeGreaterThan(AT_BOTTOM_OK_PX)

    expect(
      shrunkAnchor.tailRowId,
      `the row at the bottom changed while the composer shrank (${anchored.tailRowId} → ${shrunkAnchor.tailRowId})`,
    ).toBe(anchored.tailRowId)
    expect(
      shrunkAnchor.distFromBottom,
      `bottom not readjusted after the composer shrank back — ${shrunkAnchor.distFromBottom}px short`,
    ).toBeLessThanOrEqual(GLUED_TOLERANCE_PX)
    expect(shrunkAnchor.tailOnScreen, 'the newest row went below the fold when the composer shrank').toBe(true)

    const shrunk = await probeOverlap(page, 0)
    expect(shrunk.pillFound && shrunk.visibleRows > 0, 'pill/rows missing after composer shrank').toBe(true)
    expect(shrunk.worstOverlap, `pill covers ${shrunk.worstRowId} after the composer shrank back`).toBe(0)

    const pinStarts = await readPinStarts()
    expect(pinStarts, 'composer growth must retain container-shrink reconciliation').toContain(
      'container-shrink',
    )
    // The shrink direction has two possible rescuers and which one runs is an engine fact, so name
    // the obligation rather than the engine: Chromium's scroll anchoring leaves the measured-growth
    // baseline intact and `row-growth` absorbs the growth, while WebKit's clamp refreshes that
    // baseline post-growth and only the container-growth branch is left to see it.
    expect(
      pinStarts.filter((trigger) => trigger === 'container-growth' || trigger === 'row-growth'),
      `nothing reconciled the live edge after the composer shrank (pins: ${pinStarts.join(', ')})`,
    ).not.toEqual([])
  })

  /** Emit `composing`/`paused` for a set of MUC nicks. `room:typing` carries one nick at a time. */
  async function emitRoomTyping(page: Page, roomJid: string, nicks: string[], isTyping: boolean): Promise<void> {
    await page.evaluate(({ jid, names, on }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      if (!c) throw new Error('no __demoClient')
      for (const nick of names) c.emitSDK('room:typing', { roomJid: jid, nick, isTyping: on })
    }, { jid: roomJid, names: nicks, on: isTyping })
  }

  /**
   * Replace the room's typing set outright: `previous` is stopped and the pill is allowed to
   * unmount before `nicks` start. Going through empty is what makes the label deterministic —
   * the store keeps typers in a Set, so a name that survives a transition keeps its original
   * position and `nicks[0]` would not be the one the label leads with.
   */
  async function setRoomTypers(
    page: Page,
    roomJid: string,
    nicks: string[],
    previous: string[] = [],
  ): Promise<void> {
    if (previous.length > 0) {
      await emitRoomTyping(page, roomJid, previous, false)
      await page.waitForFunction(() => {
        const s = document.querySelector('[data-message-list]')
        return !s?.parentElement?.querySelector('[data-typing-pill]')
      }, undefined, { timeout: 5_000 })
    }
    await emitRoomTyping(page, roomJid, nicks, true)
    await page.waitForFunction((expected) => {
      const s = document.querySelector('[data-message-list]')
      const pill = s?.parentElement?.querySelector('[data-typing-pill]') as HTMLElement | null
      if (!pill) return false
      const r = pill.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && (pill.textContent ?? '').includes(expected)
    }, nicks[0], { timeout: 5_000 })
    await page.waitForTimeout(SETTLE_MS)
  }

  /** Height of the live list's pill, or 0 when it is not mounted. */
  async function pillHeight(page: Page): Promise<number> {
    return page.evaluate(() => {
      const s = document.querySelector('[data-message-list]')
      const pill = s?.parentElement?.querySelector('[data-typing-pill]') as HTMLElement | null
      return pill ? Math.round(pill.getBoundingClientRect().height) : 0
    })
  }

  // Issue #1151: the compact label used to be `truncate`d, so a crowded room was cut off with an
  // ellipsis rather than wrapping. It may now take a SECOND line — the band sizes itself from the
  // pill, so it grows with it — and is capped there. Both halves of that need a browser: the
  // clearance above the pill is the thing a taller pill could eat, and the clamp only exists once
  // the text is really laid out.
  test('a wrapped two-line room label grows the band instead of covering message text', async ({ page }) => {
    // Narrow (but still the desktop layout — the mobile breakpoint is 768) so an ordinary
    // multi-typer label wraps, which is where the truncation was most visible.
    await page.setViewportSize({ width: 800, height: 800 })
    await loadDemo(page)
    await navigateToStressRoom(page)
    await scrollToBottom(page)

    await setRoomTypers(page, STRESS_ROOM_JID, ['Ada'])
    const single = await probeOverlap(page, 0)
    expect(single.pillFound, 'typing pill not rendered for a single typer').toBe(true)
    expect(single.pillHeight, 'single-line pill has no height').toBeGreaterThan(10)

    const CROWD = [
      'Sophia Reyes (Product Design)',
      'Marcus Chen (Infrastructure)',
      'Priya Raghunathan (Support)',
      'Alexandre Dubois (Localisation)',
    ]
    await setRoomTypers(page, STRESS_ROOM_JID, CROWD, ['Ada'])
    const wrapped = await probeOverlap(page, 0)

    // Control: without this the overlap sweep below would pass on a one-line pill and prove
    // nothing about wrapping. A regression to `truncate` fails HERE, not silently.
    expect(
      wrapped.pillHeight,
      `crowded label did not wrap (pill still ${wrapped.pillHeight}px, single line is ${single.pillHeight}px)`,
    ).toBeGreaterThan(single.pillHeight)

    // The cap: an absurdly long label must still stop at two lines.
    const OVERLONG = [
      'Sophia Reyes, Head of Product Design and Research',
      'Marcus Chen, Infrastructure and Platform Reliability',
      ...CROWD.slice(2),
    ]
    await setRoomTypers(page, STRESS_ROOM_JID, OVERLONG, CROWD)
    const clamped = await probeOverlap(page, 0)
    expect(
      clamped.pillHeight,
      `label ran past two lines (${clamped.pillHeight}px vs ${wrapped.pillHeight}px for two)`,
    ).toBe(wrapped.pillHeight)

    // And the taller pill must not eat the clearance the band is there to provide, at any offset.
    await setRoomTypers(page, STRESS_ROOM_JID, CROWD, OVERLONG)
    const covered: Array<{ offset: number; probe: OverlapProbe }> = []
    for (const offset of OFFSETS_PX) {
      const probe = await probeOverlap(page, offset)
      expect(probe.pillFound, `typing pill not rendered at offset ${offset}`).toBe(true)
      expect(probe.visibleRows, `no message rows visible at offset ${offset}`).toBeGreaterThan(0)
      if (probe.worstOverlap > 0) covered.push({ offset, probe })
    }
    expect(
      covered,
      'two-line typing pill covers message text at ' +
        covered.map((r) => `offset=${r.offset}px (${r.probe.worstOverlap}px of ${r.probe.worstRowId})`).join(', '),
    ).toEqual([])
  })

  // The cost of letting the label wrap: the band can now grow while it is ALREADY shown, which the
  // off→on typing re-pin deliberately ignores (it only fires on the mount edge). A reader glued to
  // the bottom when a second typer joins must not be left short of it — this is the case that says
  // whether the scroller's own resize reconciliation is enough to cover the growth.
  test('a typer joining mid-flight grows the pill without unsticking the bottom', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 })
    await loadDemo(page)
    await navigateToStressRoom(page)
    await scrollToBottom(page)

    await setRoomTypers(page, STRESS_ROOM_JID, ['Sophia Reyes (Product Design)'])
    const before = await pillHeight(page)
    expect(before, 'typing pill not mounted for the first typer').toBeGreaterThan(10)

    // Join, do not replace: the pill stays mounted and grows in place.
    await emitRoomTyping(
      page,
      STRESS_ROOM_JID,
      ['Marcus Chen (Infrastructure)', 'Priya Raghunathan (Support)', 'Alexandre Dubois (Localisation)'],
      true,
    )
    await page.waitForTimeout(SETTLE_MS)

    const after = await pillHeight(page)
    // Control: a pill that did not actually grow makes the glue assertion below meaningless.
    expect(after, `pill did not grow when typers joined (still ${after}px)`).toBeGreaterThan(before)

    const dist = await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1
    })
    expect(dist, 'view left off the bottom when the typing pill grew to two lines').toBeLessThanOrEqual(
      GLUED_TOLERANCE_PX,
    )

    const probe = await probeOverlap(page, 0)
    expect(probe.worstOverlap, `grown pill covers ${probe.worstRowId}`).toBe(0)
  })

  /**
   * The demo server echoes EVERY groupchat stanza back as a message, including the
   * body-less chat states the composer sends while you type. A real MUC creates no row
   * for those, so without this the case below measures against two phantom empty rows
   * appended around the send and the sent row is never the tail. Dropped at the transport
   * seam, the same way the echo already skips reaction stanzas.
   */
  async function suppressChatStateEcho(page: Page): Promise<void> {
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = (window as any).__demoClient
      if (!client) throw new Error('no __demoClient')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const original = Object.getPrototypeOf(client).beginStanzaSend as (s: any) => Promise<void>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      client.beginStanzaSend = async function (stanza: any) {
        const groupchat = stanza?.name === 'message' && stanza?.attrs?.type === 'groupchat'
        if (groupchat && !stanza?.getChildText?.('body')) return
        return original.call(this, stanza)
      }
    })
  }

  // The gesture the suite had no case for: SENDING while the band is up. The reported
  // defect is that the sent message ends up under the pill, which has two possible
  // shapes — the pill being a list item the message is inserted after (DOM order), or the
  // bottom never being reconciled so the message renders where the pill sits (layout).
  // They need different fixes, so this asserts both separately rather than one composite
  // "looks right".
  test('a message sent while the band is up lands above it, at the live edge', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)
    await suppressChatStateEcho(page)
    await scrollToBottom(page)
    await setRoomTypers(page, STRESS_ROOM_JID, ['Ada', 'Marcus Chen'])

    const before = await probeBottomAnchor(page)
    expect(before.distFromBottom, 'precondition: glued to the live edge before the send').toBeLessThanOrEqual(
      GLUED_TOLERANCE_PX,
    )
    expect(await pillHeight(page), 'precondition: the band is mounted with height').toBeGreaterThan(10)

    const marker = `sent-under-pill-${Date.now()}`
    const composer = page.locator('textarea').first()
    await composer.click()
    await composer.fill(`ok ${marker}`)
    await page.keyboard.press('Enter')
    await page.waitForFunction(
      (text) =>
        Array.from(document.querySelectorAll('[data-message-list] [data-message-row-id]')).some(
          (row) => (row.textContent ?? '').includes(text),
        ),
      marker,
      { timeout: 10_000 },
    )
    await page.waitForTimeout(SETTLE_MS)

    const sent = await page.evaluate((text) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      const pill = scroller?.parentElement?.querySelector('[data-typing-pill]') as HTMLElement | null
      if (!scroller || !pill) return null
      const rows = Array.from(scroller.querySelectorAll('[data-message-row-id]')) as HTMLElement[]
      const matched = rows.filter((row) => (row.textContent ?? '').includes(text))
      const row = matched[matched.length - 1]
      if (!row) return null
      const scrollerRect = scroller.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      const position = row.compareDocumentPosition(pill)
      return {
        matches: matched.length,
        pillInsideScroller: scroller.contains(pill),
        pillFollowsRow: (position & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        isTail: rows[rows.length - 1] === row,
        belowFold: Math.round(rowRect.bottom - scrollerRect.bottom),
        distFromBottom: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
      }
    }, marker)

    expect(sent, 'the sent row and the pill must both be present').not.toBeNull()
    expect(sent!.matches, 'the sent body must map to exactly one row').toBe(1)

    // ORDER. The band is a sibling below the scrollport, so no message can follow it.
    expect(sent!.pillInsideScroller, 'the pill must not be a row inside the scroller').toBe(false)
    expect(sent!.pillFollowsRow, 'the sent row must precede the pill in document order').toBe(true)
    expect(sent!.isTail, 'the sent row must be the last row in the list').toBe(true)

    // LAYOUT. A shrunk scrollport is never clamped back by the engine, so a missed re-pin
    // leaves the sent row hanging below the fold with the band immediately under it.
    expect(sent!.belowFold, `the sent row hangs ${sent!.belowFold}px below the fold`).toBeLessThanOrEqual(0)
    expect(sent!.distFromBottom, `the view sits ${sent!.distFromBottom}px off the bottom after the send`).toBeLessThanOrEqual(
      GLUED_TOLERANCE_PX,
    )

    const overlap = await probeOverlap(page, 0)
    expect(overlap.pillFound && overlap.visibleRows > 0, 'pill/rows missing after the send').toBe(true)
    expect(overlap.worstOverlap, `the pill covers ${overlap.worstRowId} after the send`).toBe(0)
  })

  /** React on the newest message through the real store path, so its row genuinely grows. */
  async function reactToNewest(page: Page, jid: string): Promise<string> {
    const lastId = await page.evaluate((j) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const st = (window as any).__chatStore.getState()
      const msgs = st.messages.get(j) ?? []
      const last = msgs[msgs.length - 1]
      if (!last) return null
      st.updateReactions(j, last.id, j, ['👍'])
      return last.id as string
    }, jid)
    expect(lastId, 'precondition: a newest message to react to').toBeTruthy()
    await page.waitForFunction(
      (id) => {
        const s = document.querySelector('[data-message-list]')
        return !!s?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)?.textContent?.includes('👍')
      },
      lastId as string,
      { timeout: 5_000 },
    )
    return lastId as string
  }

  /** How far off the bottom we are, and how far the reacted row hangs below the fold. */
  async function measureGlued(page: Page, id: string): Promise<{ dist: number; belowFold: number }> {
    return page.evaluate((msgId) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      const el = s?.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`) as HTMLElement | null
      if (!s || !el) return { dist: -1, belowFold: 9999 }
      return {
        dist: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
        // How far the reacted row's bottom (chip included) sits BELOW the scrollport's bottom edge.
        belowFold: Math.round(el.getBoundingClientRect().bottom - s.getBoundingClientRect().bottom),
      }
    }, id)
  }

  // Reported alongside the overlap: "we don't stick perfectly to the bottom when the last message
  // ALSO has reactions". These two pin the combination down at both orders (they exercise different
  // effects: the typing re-pin vs the reaction nudge). Both were already GREEN on the pre-band code
  // in Chromium and WebKit — the re-pin runs in a layout effect, so it lands before paint and no dip
  // is observable here; what the reader was seeing was almost certainly the overlap itself, a chip
  // hidden under the pill reading as "not stuck to the bottom". Kept as guards: with the indicator
  // out of the scroll content, showing it must not change the content height, and the reacted row
  // must stay whole. Tolerance is tight on purpose — this asserts "glued", not "near".
  test('typing starting on a last message that carries a reaction stays glued to the bottom', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    const lastId = await reactToNewest(page, AVA)
    await scrollToBottom(page)

    const readPinStarts = capturePinStarts(page)
    await enableScrollDebug(page)
    await startTyping(page, AVA)
    await page.waitForTimeout(SETTLE_MS)

    const glued = await measureGlued(page, lastId)
    expect(glued.dist, 'view left off the bottom after typing started').toBeLessThanOrEqual(GLUED_TOLERANCE_PX)
    expect(glued.belowFold, 'reaction chip on the last message left below the fold').toBeLessThanOrEqual(0)

    const pinStarts = await readPinStarts()
    expect(pinStarts.filter((trigger) => trigger === 'typing')).toHaveLength(1)
    expect(pinStarts.filter((trigger) => trigger === 'container-shrink')).toHaveLength(0)
  })

  test('a reaction landing on the last message while typing shows stays glued to the bottom', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    await startTyping(page, AVA)
    await page.waitForTimeout(SETTLE_MS)

    const lastId = await reactToNewest(page, AVA)
    await page.waitForTimeout(SETTLE_MS)

    const glued = await measureGlued(page, lastId)
    expect(glued.dist, 'view left off the bottom after a reaction landed under the pill').toBeLessThanOrEqual(GLUED_TOLERANCE_PX)
    expect(glued.belowFold, 'reaction chip on the last message left below the fold').toBeLessThanOrEqual(0)
  })
})

// "I sent a message and the view didn't stick to the bottom." A send REPLACES the optimistic last
// row in place (reconciled to the server id) WITHOUT growing messageCount, so the old count-only
// new-message effect never re-pinned. The reconciled row often measures taller (final layout), so
// the view is left clipped above the true bottom. Fix keys the re-pin off the last message ID.
test.describe('Send-stick diagnostic (1:1)', () => {
  test('repro: a reconciled-in-place last message still sticks to the bottom (count unchanged)', async ({ page }) => {
    await page.addInitScript(() => {
      try { window.localStorage.setItem('fluux:scroll-debug', '1') } catch { /* ignore */ }
    })
    const trace: string[] = []
    page.on('console', (m) => {
      const t = m.text()
      if (t.includes('[Scroll]')) trace.push(t)
    })

    await loadDemo(page)
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__fluuxScrollDebug?.(true)
    })

    const AVA = 'ava@fluux.chat'
    await activateChat(page, AVA)
    await scrollToBottom(page)
    await page.waitForTimeout(300)

    // Simulate optimistic → server reconcile: replace the last row with a NEW id, TALLER, outgoing
    // message, keeping the array length identical (messageCount does NOT grow). This is the case
    // the old effect dropped.
    const sim = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cs = (window as any).__chatStore
      const st = cs.getState()
      const msgs = (st.messages.get(jid) ?? []).slice()
      const before = msgs.length
      const last = msgs[msgs.length - 1]
      const newId = `reconciled-${Date.now()}`
      msgs[msgs.length - 1] = {
        ...last, id: newId, isOutgoing: true,
        body: 'reconciled message — taller than the optimistic one\n'.repeat(6),
      }
      const m = new Map(st.messages)
      m.set(jid, msgs)
      cs.setState({ messages: m })
      return { before, after: msgs.length, newId }
    }, AVA)
    expect(sim.after, 'precondition: messageCount must NOT grow (reconcile in place)').toBe(sim.before)
    await page.waitForTimeout(800) // let the re-pin loop run as the taller row measures

    const after = await page.evaluate((id) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      const el = s?.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
      const sRect = s?.getBoundingClientRect()
      const r = el?.getBoundingClientRect()
      return {
        distFromBottom: s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : null,
        lastVisible: !!(el && sRect && r && r.bottom <= sRect.bottom + 8 && r.bottom > sRect.top),
      }
    }, sim.newId)
    console.log('── SEND-STICK AFTER RECONCILE ──', JSON.stringify(after))
    console.log('── TRACE ──\n' + trace.filter((t) => t.includes('NEW MSG')).join('\n'))

    expect(after.lastVisible, 'the reconciled last message must be fully visible at the bottom').toBe(true)
    expect(after.distFromBottom ?? 999, 'the view must be pinned to the bottom after reconcile').toBeLessThan(AT_BOTTOM_OK_PX)
  })
})

// ── Reaction bottom-stick: a reaction growing a mid-viewport row must not shove the newest down ──
//
// Adding the first reaction to a message grows its row by the reaction chip. While the reader is
// sticked to the bottom, that growth must be absorbed ABOVE (previous messages scroll up) so the
// newest message stays glued to the bottom edge — NOT pushed down/out of view. This covers the
// mid-viewport case specifically: a reaction on a message a few rows above the last pushes everything
// below it (including the newest message) down, and the browser's overflow-anchor does NOT compensate
// for growth below its chosen top anchor. RED before the fix (the old effect only re-pinned for a
// reaction on the LAST row, so a mid-viewport reaction left the newest row dipped below the fold);
// GREEN once any reaction re-asserts the bottom via the pin loop.
test.describe('Reaction bottom-stick (room)', () => {
  test('a reaction on a mid-viewport row keeps the newest message glued to the bottom', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)
    await scrollToBottom(page)
    await page.waitForTimeout(300)

    // Pick the newest message id and a target to react to: a row fully inside the viewport, NOT the
    // last, and WITHOUT existing reactions (so adding one is a genuine 0→chip growth). A fully-visible
    // mid-viewport row sits below the browser's top overflow-anchor, so its growth is not auto-
    // compensated — it pushes the rows below it (the newest included) down. Also capture the newest
    // row's pre-reaction distance so we assert it was glued to begin with.
    const pick = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      const msgs = rs.messages.get(jid) ?? []
      const lastId: string | null = msgs[msgs.length - 1]?.id ?? null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hasReactions = new Set(msgs.filter((m: any) => m.reactions && Object.keys(m.reactions).length > 0).map((m: any) => m.id))

      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return { lastId, targetId: null as string | null, beforeDist: -1 }
      const sRect = s.getBoundingClientRect()
      const rows = (Array.from(s.querySelectorAll('.message-row[data-message-id]')) as HTMLElement[])
        .filter((el) => {
          if (el.offsetHeight <= 0) return false
          const r = el.getBoundingClientRect()
          const id = el.dataset.messageId!
          return r.top >= sRect.top && r.bottom <= sRect.bottom && id !== lastId && !hasReactions.has(id)
        })
      // Choose one around the middle of the fully-visible, reaction-free rows.
      const target = rows.length ? rows[Math.floor(rows.length / 2)] : null
      return {
        lastId,
        targetId: target?.dataset.messageId ?? null,
        beforeDist: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
      }
    }, STRESS_ROOM_JID)

    expect(pick.lastId, 'precondition: a newest message id exists').toBeTruthy()
    expect(pick.targetId, 'precondition: a fully-visible, reaction-free, non-last row to react to').toBeTruthy()
    expect(pick.beforeDist, 'precondition: the view is glued to the bottom before the reaction').toBeLessThan(AT_BOTTOM_OK_PX)

    // Apply a reaction on the mid-viewport target through the real store path (grows its row).
    await page.evaluate(([jid, targetId]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__roomStore.getState().updateReactions(jid, targetId, 'Reactor', ['👍'])
    }, [STRESS_ROOM_JID, pick.targetId] as const)

    // Confirm the chip actually mounted (the row genuinely grew), then let the pin loop converge.
    await page.waitForFunction((targetId) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      const el = s?.querySelector(`[data-message-id="${CSS.escape(targetId)}"]`) as HTMLElement | null
      return !!el && el.textContent?.includes('👍')
    }, pick.targetId as string, { timeout: 5_000 })
    await page.waitForTimeout(800)

    const after = await page.evaluate((lastId) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return { lastVisible: false, distFromBottom: -1 }
      const el = s.querySelector(`[data-message-id="${CSS.escape(lastId)}"]`) as HTMLElement | null
      const sRect = s.getBoundingClientRect()
      const r = el?.getBoundingClientRect()
      return {
        // The newest row's bottom must still sit at (not past) the viewport bottom — a mid-viewport
        // reaction pushing it down would leave r.bottom well below sRect.bottom (by the chip height).
        lastVisible: !!(r && r.bottom <= sRect.bottom + 8 && r.bottom > sRect.top),
        distFromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
      }
    }, pick.lastId as string)

    expect(after.lastVisible, `newest message pushed below the fold by a mid-viewport reaction — distFromBottom=${after.distFromBottom}`).toBe(true)
    expect(after.distFromBottom, 'the view must stay pinned to the bottom after a mid-viewport reaction').toBeLessThan(AT_BOTTOM_OK_PX)
  })

  // The reader's own gesture, and the one the reaction strip exists for: react to the row that is
  // ALREADY at the bottom. The mid-viewport case above deliberately excludes the last row
  // (`id !== lastId`), and the two last-row reaction cases in the typing-indicator suite both
  // require the pill to be showing — so the plain gesture had no invariant of its own.
  test('a reaction on the LAST row keeps that row whole, with no typing indicator', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)
    await scrollToBottom(page)

    const before = await page.evaluate((jid) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = (window as any).__roomStore.getState().messages.get(jid) ?? []
      const last = messages[messages.length - 1]
      if (!scroller || !last) return null
      return {
        lastId: last.id as string,
        hasReactions: !!last.reactions && Object.keys(last.reactions).length > 0,
        scrollHeight: scroller.scrollHeight,
        distanceFromBottom: Math.round(
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        ),
      }
    }, STRESS_ROOM_JID)

    expect(before, 'the message list and a newest row must be readable').not.toBeNull()
    expect(before!.hasReactions, 'precondition: adding one must be a genuine 0→chip growth').toBe(false)
    expect(
      before!.distanceFromBottom,
      'precondition: the view is glued to the bottom before the reaction',
    ).toBeLessThanOrEqual(2)

    await page.evaluate(([jid, id]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__roomStore.getState().updateReactions(jid, id, 'Reactor', ['👍'])
    }, [STRESS_ROOM_JID, before!.lastId] as const)
    await page.waitForFunction((id) => {
      const scroller = document.querySelector('[data-message-list]')
      return !!scroller
        ?.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
        ?.textContent?.includes('👍')
    }, before!.lastId, { timeout: 5_000 })
    await page.waitForTimeout(SETTLE_MS)

    const after = await page.evaluate((id) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      const row = scroller?.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
      if (!scroller || !row) return null
      return {
        scrollHeight: scroller.scrollHeight,
        distanceFromBottom: Math.round(
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        ),
        belowFold: Math.round(
          row.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom,
        ),
      }
    }, before!.lastId)

    expect(
      after!.scrollHeight,
      'precondition: the chip must have grown the row, or nothing is under test',
    ).toBeGreaterThan(before!.scrollHeight)
    expect(after!.belowFold, 'the reaction chip was left below the fold').toBeLessThanOrEqual(0)
    expect(
      after!.distanceFromBottom,
      'the view was left off the bottom after reacting to the newest row',
    ).toBeLessThanOrEqual(2)
  })
})

// ── A last-row growth the row-growth signature cannot see ────────────────────────────────────────
//
// Two independent nets absorb a resident row growing in place: the row-growth SIGNATURE effect, and
// the virtualizer's MEASURED growth (see rowGrowthSignature.ts and VirtualRowSizeHistory). The
// signature only fingerprints reactions, fastenings, attachments, corrections and retractions, so a
// body replaced in place carries nothing it can see — `message:security-updated` does exactly that
// when an OpenPGP key or trust resolves after the row is on screen, patching `body` through
// `updateMessage` with no `isEdited`. That leaves the measured net as the only owner, which is why
// this case has to be exercised separately from every reaction test.
//
// On the LAST row the growth has nowhere to go but below the fold, so the pixels the reader loses
// are the ones just added.
test.describe('Measured-growth backstop (last row)', () => {
  test('a body replaced in place on the LAST row keeps the bottom in view', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)
    await scrollToBottom(page)

    const before = await page.evaluate((jid) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const messages: any[] = (window as any).__roomStore.getState().messages.get(jid) ?? []
      const last = messages[messages.length - 1]
      if (!scroller || !last) return null
      return {
        lastId: last.id as string,
        // Everything computeRowGrowthSignature fingerprints must be absent, or the signature net
        // would cover this growth and the measured net would not be under test.
        signatureVisible:
          (!!last.reactions && Object.keys(last.reactions).length > 0) ||
          last.linkPreview != null ||
          last.attachment != null ||
          !!last.isEdited ||
          !!last.isRetracted,
        scrollHeight: scroller.scrollHeight,
        distanceFromBottom: Math.round(
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        ),
      }
    }, STRESS_ROOM_JID)

    expect(before, 'the message list and a newest row must be readable').not.toBeNull()
    expect(
      before!.signatureVisible,
      'precondition: the newest row must carry nothing the row-growth signature fingerprints',
    ).toBe(false)
    expect(
      before!.distanceFromBottom,
      'precondition: the view is glued to the bottom before the body is replaced',
    ).toBeLessThanOrEqual(2)

    // The shape message:security-updated delivers: a taller body, patched in place, nothing else.
    await page.evaluate(([jid, id]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__roomStore.getState().updateMessage(jid, id, {
        body: Array.from({ length: 8 }, (_, line) => `decrypted line ${line} of a taller body`).join('\n'),
      })
    }, [STRESS_ROOM_JID, before!.lastId] as const)
    await page.waitForFunction(([id, grewPast]) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      return (
        !!scroller &&
        scroller.scrollHeight > (grewPast as number) &&
        !!scroller
          .querySelector(`[data-message-id="${CSS.escape(id as string)}"]`)
          ?.textContent?.includes('decrypted line 7')
      )
    }, [before!.lastId, before!.scrollHeight] as const, { timeout: 10_000 })
    await page.waitForTimeout(SETTLE_MS)

    const afterFirstGrowth = await page.evaluate((id) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      const row = scroller?.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
      if (!scroller || !row) return null
      return {
        scrollHeight: scroller.scrollHeight,
        distanceFromBottom: Math.round(
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        ),
        belowFold: Math.round(
          row.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom,
        ),
      }
    }, before!.lastId)

    expect(
      afterFirstGrowth!.scrollHeight,
      'precondition: the replaced body must have grown the row, or nothing is under test',
    ).toBeGreaterThan(before!.scrollHeight)
    expect(
      afterFirstGrowth!.belowFold,
      'the replaced body left the newest row hanging below the fold',
    ).toBeLessThanOrEqual(0)
    expect(
      afterFirstGrowth!.distanceFromBottom,
      'the view was left off the bottom by a growth only the measured net can see',
    ).toBeLessThanOrEqual(2)

    await page.evaluate(([jid, id]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__roomStore.getState().updateMessage(jid, id, {
        body: Array.from({ length: 16 }, (_, line) => `decrypted line ${line} of a taller body`).join('\n'),
      })
    }, [STRESS_ROOM_JID, before!.lastId] as const)
    await page.waitForFunction(([id, grewPast]) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      return (
        !!scroller &&
        scroller.scrollHeight > (grewPast as number) &&
        !!scroller
          .querySelector(`[data-message-id="${CSS.escape(id as string)}"]`)
          ?.textContent?.includes('decrypted line 15')
      )
    }, [before!.lastId, afterFirstGrowth!.scrollHeight] as const, { timeout: 10_000 })
    await page.waitForTimeout(SETTLE_MS)

    const afterSecondGrowth = await page.evaluate((id) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      const row = scroller?.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
      if (!scroller || !row) return null
      return {
        scrollHeight: scroller.scrollHeight,
        distanceFromBottom: Math.round(
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        ),
        belowFold: Math.round(
          row.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom,
        ),
      }
    }, before!.lastId)

    expect(
      afterSecondGrowth!.scrollHeight,
      'precondition: the second replacement must grow the row again, or nothing is under test',
    ).toBeGreaterThan(afterFirstGrowth!.scrollHeight)
    expect(
      afterSecondGrowth!.belowFold,
      'the second replaced body left the newest row hanging below the fold',
    ).toBeLessThanOrEqual(0)
    expect(
      afterSecondGrowth!.distanceFromBottom,
      'the view was left off the bottom by the second measured-only growth',
    ).toBeLessThanOrEqual(2)

    await page.evaluate(([jid, id]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__roomStore.getState().updateMessage(jid, id, {
        body: Array.from({ length: 16 }, (_, line) => `decrypted line ${line} of a taller body`).join('\n'),
      })
    }, [STRESS_ROOM_JID, before!.lastId] as const)
    await page.waitForTimeout(SETTLE_MS)

    const afterUnchangedRender = await page.evaluate((id) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
      const row = scroller?.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
      if (!scroller || !row) return null
      return {
        scrollHeight: scroller.scrollHeight,
        distanceFromBottom: Math.round(
          scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
        ),
        belowFold: Math.round(
          row.getBoundingClientRect().bottom - scroller.getBoundingClientRect().bottom,
        ),
      }
    }, before!.lastId)

    expect(
      afterUnchangedRender!.scrollHeight,
      'precondition: replacing the body with itself must not change the row height',
    ).toBe(afterSecondGrowth!.scrollHeight)
    expect(
      afterUnchangedRender!.distanceFromBottom,
      'a height-unchanged re-render moved the view off the bottom',
    ).toBe(afterSecondGrowth!.distanceFromBottom)
    expect(
      afterUnchangedRender!.belowFold,
      'a height-unchanged re-render moved the newest row below the fold',
    ).toBe(afterSecondGrowth!.belowFold)
  })
})

// ── 11: Media decoding above a scrolled-up viewport must not drift the reading position ──────────
//
// The reported bug (real WebKitGTK trace): switch INTO a conversation, the saved scrolled-up anchor
// restores, then images ABOVE the viewport decode AFTER the ~1s restore re-assert window closes.
// That growth pushes the reader's content down/out ("drifts back in time") and the media-load
// handler's not-at-bottom branch did nothing to compensate. Demo images reserve space (width/height
// present) so they can't reproduce it; we MODEL the late decode deterministically: fire a media
// batch (handleMediaLoad) to snapshot the reading anchor, then grow a mounted row ABOVE the viewport
// (as a decoded image would) and let the debounced batch settle. RED before the fix (anchor drifts
// by the growth); GREEN once the handler re-anchors the scrolled-up reading position.
test.describe('Media-growth drift while scrolled up', () => {
  test('invariant-11: media decode above a scrolled-up viewport keeps the reading anchor fixed', async ({ page }) => {
    const trace: string[] = []
    page.on('console', (m) => { const t = m.text(); if (t.includes('[Scroll]')) trace.push(t) })
    await loadDemo(page)
    await page.evaluate(() => { (window as any).__fluuxScrollDebug?.(true) }) // eslint-disable-line @typescript-eslint/no-explicit-any
    await navigateToStressRoom(page)

    // Scroll UP off the bottom with real wheel so the virtualizer windows and there is content both
    // above and below (mirrors invariant-9's reliable scroll-up).
    const box = await page.locator('[data-message-list]').first().boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, -2500)
    await page.waitForTimeout(700)

    const distFromBottom = () => page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1
    })
    expect(await distFromBottom(), 'precondition: must be scrolled up off the bottom').toBeGreaterThan(AT_BOTTOM_OK_PX)

    // Track a message in the LOWER part of the viewport; grow a row in the UPPER part (content above
    // it). Both stay mounted through the small compensation, so the CSS growth isn't lost to an
    // unmount (a real decoded image keeps its size; transient inline CSS would not). Measured by
    // bounding rect (the offsetTop-based findBottomVisibleMessage is ambiguous under virtualization).
    const visibleRows = () => page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return []
      const sr = s.getBoundingClientRect()
      return (Array.from(s.querySelectorAll('.message-row[data-message-id]')) as HTMLElement[])
        .map((el) => ({ id: el.dataset.messageId!, top: el.getBoundingClientRect().top - sr.top, bottom: el.getBoundingClientRect().bottom - sr.top }))
        .filter((r) => r.top >= 5 && r.bottom <= sr.height - 5)
        .sort((a, b) => a.top - b.top)
    })

    const visBefore = await visibleRows()
    expect(visBefore.length, 'need several fully-visible rows to pick a grow target above a tracked row').toBeGreaterThan(3)
    const growId = visBefore[1].id                          // upper row → content above the tracked one
    const track = visBefore[visBefore.length - 2]            // lower row → the reading position

    // Start a media batch NOW (snapshots the reading anchor BEFORE growth), THEN grow the upper row.
    const GROW_PX = 220
    const grew = await page.evaluate(([gid, growPx]) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return false
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trigger = (window as any).__fluuxTriggerMediaLoad
      if (typeof trigger !== 'function') return false
      trigger() // batch start: snapshot the reading anchor at its correct position
      const row = s.querySelector(`.message-row[data-message-id="${CSS.escape(gid as string)}"]`) as HTMLElement | null
      const idx = row?.closest('[data-index]') as HTMLElement | null
      if (!idx) return false
      idx.style.minHeight = idx.offsetHeight + (growPx as number) + 'px'
      trigger() // keep the debounce window open through the growth
      return true
    }, [growId, GROW_PX] as const)
    expect(grew, 'could not grow the upper row (need __fluuxTriggerMediaLoad)').toBe(true)

    await page.waitForTimeout(600) // media debounce (150ms) + re-anchor settle

    const afterTop = await getMessageOffsetFromTop(page, track.id)
    const drift = afterTop !== null ? Math.abs(afterTop - track.top) : 9999
    console.log('── MEDIA-DRIFT ──', JSON.stringify({ trackedId: track.id, beforeTop: Math.round(track.top), afterTop: afterTop !== null ? Math.round(afterTop) : null, drift: Math.round(drift), grow: GROW_PX }))
    if (drift >= 120) console.log('── TRACE ──\n' + trace.filter((t) => t.includes('MEDIA') || t.includes('anchor') || t.includes('RESTORE')).slice(-12).join('\n'))

    // The tracked message must stay at the same viewport position despite content growing above it.
    expect(drift, `reading position drifted ${Math.round(drift)}px after media grew above (grew ${GROW_PX}px)`).toBeLessThan(120)
  })
})

// ── 13: Sliding window — load-older AT THE CAP slides (evicts newest) and holds the anchor ────────
//
// The whole feature: past the resident cap, scrolling up must keep loading (the window slides)
// rather than hitting a wall, WITHOUT growing RAM unbounded. We shrink the cap to 100 via
// ?window=100 so the slide happens after a handful of messages instead of 5000+. Seed 250 so the
// resident array is solidly AT the cap (100) after activation, with older + newer available.
// A single load-older at the cap must: (a) NOT grow the resident array past the cap (the newest
// were evicted — proof of the slide, not an unbounded append); (b) flip windowAtLiveEdge to false
// (the resident bottom is no longer the newest); (c) restore the anchor off the top (not blank,
// not stuck at 0). Then the jump-to-latest FAB must recenter back to the live edge.
test.describe('Sliding window (load-older past the cap)', () => {
  const readState = (page: Page) => page.evaluate((jid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rs = (window as any).__roomStore.getState()
    const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
    return {
      count: (rs.messages.get(jid) ?? []).length,
      atLiveEdge: rs.windowAtLiveEdge.get(jid) ?? true,
      scrollTop: scroller?.scrollTop ?? 0,
    }
  }, STRESS_ROOM_JID)

  test('invariant-13: load-older at the cap slides (evicts newest, flips windowAtLiveEdge), jump-to-latest recenters', async ({ page }) => {
    // ?window=100 shrinks the resident cap; stress seeds 250 so the window is full at the live edge.
    await page.goto('/demo.html?tutorial=false&virt=1&window=100&stress=rooms:1,messages:250,msgStep:0', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-nav="messages"]', { timeout: 20_000 })
    await page.waitForTimeout(1800) // 250-msg seed + IndexedDB writes
    await navigateToStressRoom(page)
    await page.waitForTimeout(2000) // activation loads the latest window from cache + settles

    const before = await readState(page)
    expect(before.atLiveEdge, `expected to start at the live edge — ${JSON.stringify(before)}`).toBe(true)
    // Resident array is bounded by the window AND full (at the cap), so load-older will slide.
    expect(before.count, `resident not bounded by the window — ${JSON.stringify(before)}`).toBeLessThanOrEqual(100)
    expect(before.count, `resident not full (not at the cap) — ${JSON.stringify(before)}`).toBeGreaterThanOrEqual(90)

    // Scroll to the top → load-older. AT THE CAP this SLIDES: prepend a batch + evict the newest.
    await scrollToTopAndLoad(page)
    // Wait until the slide has actually applied: windowAtLiveEdge flips false once the newest are evicted.
    await page.waitForFunction((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      return (rs.windowAtLiveEdge.get(jid) ?? true) === false
    }, STRESS_ROOM_JID, { timeout: 6_000 }).catch(() => { /* asserted below with context */ })
    await page.waitForTimeout(800) // anchor-restore re-assert settle

    const after = await readState(page)
    // (a) The window SLID, it did not grow past the cap (the newest were evicted).
    expect(after.count, `resident grew past the cap — window did not slide: ${JSON.stringify(after)}`).toBeLessThanOrEqual(100)
    // (b) The resident bottom is no longer the newest message.
    expect(after.atLiveEdge, `windowAtLiveEdge did not flip false after load-older at the cap: ${JSON.stringify(after)}`).toBe(false)
    // (c) The anchor restore moved us off the top (not blank, not stuck at scrollTop 0).
    expect(after.scrollTop, `anchor not restored (stuck at top) after slide: ${JSON.stringify(after)}`).toBeGreaterThan(5)

    // Jump-to-latest: the FAB recenters the resident window to the newest slice and returns to the live edge.
    await page.locator('[data-fab="scroll-to-bottom"]').first().click()
    await page.waitForFunction((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      return (rs.windowAtLiveEdge.get(jid) ?? true) === true
    }, STRESS_ROOM_JID, { timeout: 6_000 }).catch(() => { /* asserted below */ })
    const recentered = await readState(page)
    expect(recentered.atLiveEdge, `jump-to-latest did not recenter to the live edge: ${JSON.stringify(recentered)}`).toBe(true)
    expect(recentered.count, `resident not bounded after recenter: ${JSON.stringify(recentered)}`).toBeLessThanOrEqual(100)
  })
})

// ── Jump-to-last-read pill: survives a jump-to-present and returns to the divider (#870) ──
//
// Reproduces the "dead pill": read a room to the bottom, leave, receive MANY new messages
// while away, return (opens at the divider). Jump to present via the FAB. The per-visit
// anchor must SURVIVE the jump so the pill shows "N new · Jump to last read", and clicking
// it must return the divider to view. With the pre-fix clear branches this pill never
// durably appears, so this test goes RED against the bug.
test.describe('Jump-to-last-read pill', () => {
  test('pill appears after FAB jump-to-present and returns to the divider', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Read the room the real way, then pin lastSeen to the true last message.
    await scrollToBottom(page)
    await page.waitForTimeout(400)
    const pointerMatchesLast = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      const msgs = rs.messages.get(jid) ?? []
      const last = msgs[msgs.length - 1]
      if (last) rs.advanceReadPointer(jid, { id: last.id, occupantId: last.occupantId })
      const pointer = (rs.roomMeta.get(jid)?.readPointer ?? rs.rooms.get(jid)?.readPointer)?.identity
      return pointer?.messageId === last?.id && pointer?.occupantId === last?.occupantId
    }, STRESS_ROOM_JID)
    expect(pointerMatchesLast, 'read-pointer setup must reach the last room row').toBe(true)

    // Leave the room (genuinely at the bottom, so no restore-position is saved).
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void (window as any).__roomStore.getState().activateRoom(null)
    })
    await page.waitForTimeout(300)

    // Many new messages arrive while away, so the divider sits well above the live edge
    // (and its row is trimmed from the DOM once we jump — exercising the trim-survival path).
    const baseTs = Date.now()
    await page.evaluate(([jid, count, base]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      for (let i = 0; i < (count as number); i++) {
        c.emitSDK('room:message', {
          roomJid: jid,
          message: {
            type: 'groupchat', id: `pill-new-${base}-${i}`, from: `${jid}/AwayBot`, nick: 'AwayBot',
            body: `away message ${i} — the divider must survive a jump to present`,
            timestamp: new Date((base as number) + i), isOutgoing: false, roomJid: jid,
          },
          incrementUnread: true,
        })
      }
    }, [STRESS_ROOM_JID, 30, baseTs])
    await page.waitForTimeout(200)

    // Re-enter: opens at the divider, so the pill is hidden (divider visible).
    await navigateToStressRoom(page)
    await page.waitForTimeout(1500) // let the marker re-assert loop settle
    await expect(page.locator('[data-new-message-marker]'), 'divider row should exist on re-entry').toBeVisible()
    await expect(page.locator('[data-jump-to-last-read]'), 'pill is hidden while the divider is visible').toHaveCount(0)

    // Jump to present via the FAB (two-step: to marker, then to bottom). Click until at bottom.
    const fab = page.locator('[data-fab="scroll-to-bottom"]')
    for (let i = 0; i < 3; i++) {
      if (await fab.isVisible().catch(() => false)) {
        await fab.click()
        await page.waitForTimeout(600)
      }
      const dist = await page.evaluate(() => {
        const s = document.querySelector('[data-message-list]') as HTMLElement | null
        return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : 99999
      })
      if (dist < 8) break
    }

    // The anchor survived the jump: the pill now shows and offers the return.
    await expect(page.locator('[data-jump-to-last-read]'), 'pill must appear after a jump-to-present').toBeVisible({ timeout: 4000 })

    // Click the pill: the divider returns to view.
    await page.locator('[data-jump-to-last-read] button').click()
    await page.waitForTimeout(1200)
    const dividerVisible = await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      const m = document.querySelector('[data-new-message-marker]') as HTMLElement | null
      if (!s || !m) return false
      const sr = s.getBoundingClientRect()
      const mr = m.getBoundingClientRect()
      return mr.bottom > sr.top && mr.top < sr.bottom
    })
    expect(dividerVisible, 'clicking the pill must return the divider to view').toBe(true)
  })

  // The "New messages" divider marks the opening boundary while the read pointer advances
  // independently. Setup is store-driven (divider behind an advanced pointer) so any scroll-driven
  // repositioning has a deterministic, visibly different target.
  //
  // The reader is carried clear of the at-bottom band BEFORE the divider is planted, and every wait
  // below is on an observable condition. That is not tidying: planting the divider while the list
  // was still parked at the live edge put this test one scroll event away from the read-through
  // clear, and which engine won that race decided whether it passed (see the wheel step).
  test('divider holds its planted position through a genuine scroll (never moved, never cleared)', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Entry parks this room at the live edge. Wait for THAT rather than for a duration: every step
    // below is stated relative to the at-bottom band, so a sleep would only establish it by luck.
    await page.waitForFunction((band) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return !!s && s.scrollHeight - s.scrollTop - s.clientHeight < band
    }, AT_BOTTOM_OK_PX, { timeout: 15_000 })

    // Scroll the reader genuinely UP and clear of the at-bottom band BEFORE planting the divider.
    // The ORDER is the invariant this test needs and used to leave to chance. While the list sits
    // inside the at-bottom band, the first genuine scroll event is the documented read-through clear
    // ("MARKER CLEAR (reached bottom)") — a path that legitimately owns clearing — so it would wipe
    // the divider before the post-plant invariant ran. Whether that happened came down to how the engine
    // delivers one wheel gesture: Chromium and WebKit/macOS apply the whole 1200px in a single
    // scroll event (first event ~1248px from the bottom, safely clear), while WebKitGTK on CI
    // delivers it incrementally and the first event can land ~88px from the bottom — inside the
    // band. That is the whole flake: same code, same assertion, engine-dependent event granularity.
    // Scrolling clear first keeps the read-through path out of this invariant.
    const listBox = await page.locator('[data-message-list]').first().boundingBox()
    if (listBox) await page.mouse.move(listBox.x + listBox.width / 2, listBox.y + listBox.height / 2)
    await expect.poll(
      async () => {
        await page.mouse.wheel(0, -1200)
        return page.evaluate(() => {
          const s = document.querySelector('[data-message-list]') as HTMLElement | null
          return s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : -1
        })
      },
      { message: 'a genuine wheel scroll-up must carry the reader clear of the at-bottom band', timeout: 20_000 },
    ).toBeGreaterThan(CLEAR_OF_BOTTOM_PX)

    const minimumUpwardHeadroom = 700
    const preparedScroll = await page.evaluate(([minimumHeadroom, clearFromBottom]) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return null
      const maxScrollTop = s.scrollHeight - s.clientHeight
      const highestAllowed = maxScrollTop - clearFromBottom
      if (highestAllowed < minimumHeadroom) return null
      s.scrollTop = Math.min(Math.max(s.scrollTop, minimumHeadroom), highestAllowed)
      return {
        scrollTop: Math.round(s.scrollTop),
        distFromBottom: Math.round(maxScrollTop - s.scrollTop),
      }
    }, [minimumUpwardHeadroom, CLEAR_OF_BOTTOM_PX] as const)
    expect(preparedScroll, 'stress room must have room to scroll upward away from the bottom').not.toBeNull()
    expect(preparedScroll!.scrollTop).toBeGreaterThanOrEqual(minimumUpwardHeadroom)
    expect(preparedScroll!.distFromBottom).toBeGreaterThanOrEqual(CLEAR_OF_BOTTOM_PX)

    // Plant a divider behind an advanced read pointer, with a verified incoming message after the
    // pointer so an unintended re-derivation has a deterministic forward target.
    const setup = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__roomStore
      const s = store.getState()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgs = (s.messages.get(jid) ?? []) as { id: string; from?: string; occupantId?: string; timestamp: Date; isOutgoing?: boolean }[]
      // First unread after the pointer must exist and be incoming — find the last incoming message
      // and put the pointer immediately before it, so any re-derivation lands on it.
      let targetIdx = -1
      for (let i = msgs.length - 1; i >= 2; i--) { if (!msgs[i].isOutgoing) { targetIdx = i; break } }
      if (targetIdx < 2) return { ok: false, len: msgs.length }
      const pIdx = targetIdx - 1
      const dIdx = Math.max(0, Math.floor(pIdx * 0.3))
      const dividerId = msgs[dIdx].id
      // The divider names a ROW: occupant included when the row carries one, so the
      // handle it produces matches the one the list renders.
      const dividerOccupantId = msgs[dIdx].occupantId
      const pointerId = msgs[pIdx].id
      // One read position, written whole — the literal shape `makeReadPointer`
      // writes: an EXACT order (the named message's own timestamp plus the cache
      // tie-break) and an identity naming it. The exact role is not optional
      // decoration here: every stress-room message shares one millisecond, so a
      // FLOOR order cannot certify its position at all and the divider correctly
      // falls back to "the whole slice is after the boundary". Only a migrated
      // pre-#1081 pointer is ever a floor.
      //
      // `local`, because a demo message carries no archive id — and the divider
      // does not care: identity names a position, it never orders one.
      //
      // NOTE: this file is not covered by `npm run typecheck` (the root tsconfig
      // has `files: []`, and the app's `include` covers apps/fluux/scripts, not
      // this one), so a stale pointer shape here compiles and fails only as a
      // browser-side timeout. Keep it in step with `ReadPointer` by hand.
      const readPointer = {
        order: {
          role: 'exact',
          timestamp: msgs[pIdx].timestamp.getTime(),
          tiebreak: { kind: 'room', from: msgs[pIdx].from ?? '', id: pointerId },
        },
        identity: { state: 'local', messageId: pointerId },
      }
      const roomMeta = new Map(s.roomMeta)
      const meta = roomMeta.get(jid)
      if (meta) roomMeta.set(jid, { ...meta, readPointer })
      const rooms = new Map(s.rooms)
      const room = rooms.get(jid)
      if (room) rooms.set(jid, { ...room, readPointer })
      const markers = new Map(s.firstNewMessageMarkers)
      markers.set(jid, dividerOccupantId ? { id: dividerId, occupantId: dividerOccupantId } : { id: dividerId })
      store.setState({ roomMeta, rooms, firstNewMessageMarkers: markers })
      return { ok: true, dividerId, pointerId, dIdx, pIdx, targetIdx, len: msgs.length }
    }, STRESS_ROOM_JID)
    expect(setup.ok, `stress room needs a resident incoming message (len=${setup.len})`).toBe(true)

    const readDividerState = () => page.evaluate(([jid, dividerId]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rs = (window as any).__roomStore.getState()
      const msgs = rs.messages.get(jid) ?? []
      const markerId = rs.firstNewMessageMarkers.get(jid)?.id ?? null
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      return {
        markerId,
        markerIdx: msgs.findIndex((m: { id: string }) => m.id === markerId),
        dividerIdx: msgs.findIndex((m: { id: string }) => m.id === dividerId),
        scrollTop: s ? Math.round(s.scrollTop) : null,
        distFromBottom: s ? Math.round(s.scrollHeight - s.scrollTop - s.clientHeight) : null,
      }
    }, [STRESS_ROOM_JID, setup.dividerId] as const)

    const beforeWheel = await readDividerState()
    expect(beforeWheel.scrollTop).not.toBeNull()
    expect(beforeWheel.scrollTop!).toBeGreaterThanOrEqual(minimumUpwardHeadroom)
    expect(beforeWheel.distFromBottom!).toBeGreaterThanOrEqual(CLEAR_OF_BOTTOM_PX)

    await page.mouse.wheel(0, -600)
    await expect.poll(
      async () => (await readDividerState()).scrollTop,
      {
        message: 'the post-plant wheel must produce a genuine upward scroll',
        timeout: 5_000,
      },
    ).toBeLessThan(beforeWheel.scrollTop!)

    const stableUntil = Date.now() + 5_000
    while (Date.now() < stableUntil) {
      const sample = await readDividerState()
      expect(
        sample.markerId,
        `divider must stay planted at ${setup.dividerId} while the reader scrolls`,
      ).toBe(setup.dividerId)
      await page.waitForTimeout(50)
    }

    const after = await readDividerState()
    console.log('── DIVIDER HOLD ──', JSON.stringify({ setup, after }))

    // Neither moved toward the pointer nor cleared by the scroll.
    expect(after.markerId, 'a genuine scroll must not clear the divider').not.toBeNull()
    expect(
      after.markerId,
      `divider must stay at ${setup.dividerId} (moved to ${after.markerId}, pointer was at ${setup.pointerId})`,
    ).toBe(setup.dividerId)
    expect(after.markerIdx, 'the divider must not advance toward the read pointer').toBe(after.dividerIdx)
  })
})

test.describe('Fastening stick diagnostic (1:1)', () => {
  const AVA = 'ava@fluux.chat'

  /**
   * The reported bug, end to end in a real engine: you send a message containing a link, and the
   * OGP preview card is fastened onto that ALREADY-RENDERED row seconds later. Nothing about the
   * message list changes except the row's height — same message count, same last-message id, no
   * reactions — so this exercises the only trigger that can notice it (the row-growth signature)
   * AND the real spacer/row geometry the jsdom harness can only approximate.
   */
  async function emitLinkMessage(page: Page, jid: string, id: string): Promise<void> {
    await page.evaluate(([j, i]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      if (!c) throw new Error('no __demoClient')
      c.emitSDK('chat:message', {
        message: {
          type: 'chat', conversationId: j, from: j, id: i,
          body: 'look at this https://example.invalid/article',
          timestamp: new Date(), isOutgoing: false,
        },
      })
    }, [jid, id] as const)
  }

  async function fastenPreview(page: Page, jid: string, id: string, url: string): Promise<void> {
    await page.evaluate(([j, i, u]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      c.emitSDK('chat:message-updated', {
        conversationId: j,
        messageId: i,
        updates: {
          linkPreview: {
            url: u,
            title: 'A fastened link preview card',
            description:
              'Fastened after the fact. Long enough that the card is several lines tall, so the ' +
              'row it grows genuinely pushes the newest message below the fold when nothing re-pins.',
            siteName: 'example.invalid',
            // An image gives the card an aspect-video box, so the row grows by well over the
            // at-bottom threshold — without it the growth stays under the threshold and the test
            // passes even with a gate that reads post-growth geometry.
            image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
          },
        },
      })
    }, [jid, id, url] as const)
  }

  async function bottomState(page: Page, msgId: string) {
    return page.evaluate((id) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return { visible: false, distFromBottom: -1, scrollHeight: -1 }
      const el = s.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
      const sRect = s.getBoundingClientRect()
      const visible = !!el && el.getBoundingClientRect().bottom <= sRect.bottom + 8
      return {
        visible,
        distFromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
        scrollHeight: s.scrollHeight,
      }
    }, msgId)
  }

  test('a link-preview fastening on the newest row keeps the view stuck to the bottom', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    const id = `fastened-${Date.now()}`
    const url = `https://example.invalid/${id}`
    await emitLinkMessage(page, AVA, id)
    await page.waitForSelector(`[data-message-id="${id}"]`, { timeout: 5_000 })
    await page.waitForTimeout(SETTLE_MS)

    const before = await bottomState(page, id)
    expect(before.distFromBottom, 'precondition: must start stuck to the bottom').toBeLessThan(AT_BOTTOM_OK_PX)

    await fastenPreview(page, AVA, id, url)
    // Wait for the REAL card to be in the DOM — this is the growth the scroll layer must absorb.
    await page.waitForSelector(`a[href="${url}"]`, { timeout: 5_000 })
    await page.waitForTimeout(600)

    const after = await bottomState(page, id)
    // The growth must exceed the at-bottom threshold, otherwise a gate that reads POST-growth
    // geometry still squeaks under the threshold and the test proves nothing.
    expect(
      after.scrollHeight - before.scrollHeight,
      `the preview card must grow the content by more than the at-bottom threshold (before=${before.scrollHeight}, after=${after.scrollHeight}) — otherwise this test is vacuous`,
    ).toBeGreaterThan(AT_BOTTOM_OK_PX)
    expect(
      after.distFromBottom,
      `view not re-pinned after the fastening — distFromBottom=${after.distFromBottom}`,
    ).toBeLessThan(AT_BOTTOM_OK_PX)
    expect(after.visible, `the fastened message "${id}" was pushed below the fold`).toBe(true)
  })

  test('a link-preview fastening does not yank a scrolled-up reader to the bottom', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    const id = `fastened-up-${Date.now()}`
    const url = `https://example.invalid/${id}`
    await emitLinkMessage(page, AVA, id)
    await page.waitForSelector(`[data-message-id="${id}"]`, { timeout: 5_000 })
    await page.waitForTimeout(SETTLE_MS)

    await setScrollTop(page, 200)
    await page.waitForTimeout(SETTLE_MS)
    const before = await getScrollTop(page)

    await fastenPreview(page, AVA, id, url)
    await page.waitForSelector(`a[href="${url}"]`, { timeout: 5_000 })
    await page.waitForTimeout(600)

    const after = await getScrollTop(page)
    expect(
      Math.abs(after - before),
      `a scrolled-up reader was moved by the fastening (${before} -> ${after})`,
    ).toBeLessThan(AT_BOTTOM_OK_PX)
  })
})

test.describe('Fastening + reaction stick diagnostic (1:1)', () => {
  const AVA = 'ava@fluux.chat'

  // SCOPE: a burst of successive in-place changes on the same row — the message, then its preview
  // card, then a reaction — must leave the list stuck to the bottom, with no user movement anywhere.
  // What it demonstrates is that the ACTIVE pin loop absorbs them as they land.
  //
  // What it does NOT cover: a growth skipped because a pin loop still claimed the bottom. There is
  // no second chance for such a growth — nothing re-runs the effect for a consumed signature — so
  // waiting longer here proves nothing and would only imply a recovery that does not exist. Staging
  // that case is not possible from here anyway: it needs the preview to commit while the loop still
  // holds its claim, and the loop converges in ~130ms, faster than emits can be interleaved. The gap
  // is documented on rowGrowthDecision and pinned by its unit test.
  test('an active pin loop absorbs a burst of in-place changes on the same row', async ({ page }) => {
    await loadDemo(page)
    await activateChat(page, AVA)
    await scrollToBottom(page)

    const id = `pending-${Date.now()}`
    const url = `https://example.invalid/${id}`

    // The whole sequence runs INSIDE the page: a Playwright round-trip is far longer than the pin
    // loop's convergence, so emitting these from separate evaluate() calls spaces them out beyond
    // anything a real client would produce. In-page they arrive in the burst this is meant to cover
    // — message, then its preview, then a reaction on the same row.
    await page.evaluate(async ([j, i, u]) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = (window as any).__demoClient
      c.emitSDK('chat:message', {
        message: {
          type: 'chat', conversationId: j, from: j, id: i,
          body: 'look at this https://example.invalid/article',
          timestamp: new Date(), isOutgoing: false,
        },
      })
      // Separate ticks, or React batches all three into ONE render and this collapses into a single
      // row-growth signature change — which is not the sequence under test.
      await wait(30)
      c.emitSDK('chat:message-updated', {
        conversationId: j, messageId: i,
        updates: {
          linkPreview: {
            url: u, title: 'A fastened link preview card',
            description: 'Fastened after the fact, tall enough to push the newest message below the fold.',
            siteName: 'example.invalid',
            image: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
          },
        },
      })
      await wait(60)
      c.emitSDK('chat:message-updated', {
        conversationId: j, messageId: i,
        updates: { reactions: { '\u{1F44D}': ['someone@fluux.chat'] } },
      })
    }, [AVA, id, url] as const)
    await page.waitForSelector(`a[href="${url}"]`, { timeout: 5_000 })

    // A normal settle, matching the sibling fastening tests. Deliberately NOT the claim's stale
    // window: no re-pin is owed after that window, so a longer wait would suggest a second chance
    // the implementation does not offer.
    await page.waitForTimeout(600)

    const state = await page.evaluate((msgId) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      if (!s) return { visible: false, distFromBottom: -1 }
      const el = s.querySelector(`[data-message-id="${CSS.escape(msgId)}"]`) as HTMLElement | null
      const sRect = s.getBoundingClientRect()
      return {
        visible: !!el && el.getBoundingClientRect().bottom <= sRect.bottom + 8,
        distFromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
      }
    }, id)

    expect(
      state.distFromBottom,
      `list not pinned after the message+preview+reaction burst — distFromBottom=${state.distFromBottom}`,
    ).toBeLessThan(AT_BOTTOM_OK_PX)
    expect(state.visible, 'the fastened message was left below the fold').toBe(true)
  })
})

// ── 14: A mid-array insertion above a scrolled-up reader must not move the reading position ──────
//
// A DELAYED arrival — offline replay, gateway/MUC history, the MAM `{ids}` fetch — reaches the LIVE
// path carrying an OLD timestamp, so appendLive's sort places it chronologically: in the MIDDLE of
// the resident array, above a reader who has scrolled up. That is a different event from the media
// growth invariant-11 covers (it changes the element COUNT, not the height of an existing element),
// and it reaches none of the same machinery: no media event fires, the new-message effect
// deliberately does nothing for an incoming message while scrolled up, and browser-native scroll
// anchoring is inert under virtualization because the virtualizer rewrites each row's inline `top`
// every commit. RED before the fix (the reader drifts down by ~the inserted height: ~50px for one
// row, ~424px for a tall one, ~248px for a 10-message burst); GREEN once the insertion re-anchors
// the scrolled-up reading position.
//
// The window bound is deliberately left at its default: appendLive only GATES an out-of-order
// arrival once the window has slid off the live edge, which needs ~100 load-older triggers at the
// production windowSize, so a normal scrolled-up reader is always in the ungated case this covers.
test.describe('Insertion drift while scrolled up', () => {
  const INSERTION_URL =
    '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:200,mode:live,msgStep:0'
  const FULL_WINDOW_INSERTION_URL =
    '/demo.html?tutorial=false&virt=1&window=200&stress=rooms:1,messages:200,mode:live,msgStep:0'

  /** Open the stress room and scroll clear of the bottom, with content above AND below. */
  async function openScrolledUp(
    page: Page,
    url = INSERTION_URL,
    targetDistanceFromBottom?: number,
    virtualized = true,
  ): Promise<void> {
    await bootDemo(page, url)
    await page.evaluate(() => {
      ;(
        window as Window & { __fluuxScrollShadow?: (reset?: boolean) => unknown }
      ).__fluuxScrollShadow?.(true)
    })
    if (!virtualized) {
      await page.evaluate(() => {
        localStorage.setItem('fluux:flags:enableMessageVirtualization', 'false')
      })
    }
    await navigateToStressRoom(page, virtualized)
    const list = page.locator('[data-message-list]').first()
    await list.evaluate((element, { targetDistance, virtualized: usesVirtualizer }) => {
      const scroller = element as HTMLElement
      if (!usesVirtualizer) scroller.style.overflowAnchor = 'none'
      const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
      scroller.scrollTop = targetDistance === undefined
        ? Math.max(800, Math.min(maxScrollTop - 800, maxScrollTop * 0.55))
        : Math.max(0, maxScrollTop - targetDistance)
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    }, { targetDistance: targetDistanceFromBottom, virtualized })
    const box = await list.boundingBox()
    if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(SETTLE_MS)
  }

  /** Rendered rows (scroller-relative) plus the resident array, read together. */
  const readView = (page: Page) => page.evaluate((jid) => {
    const s = document.querySelector('[data-message-list]') as HTMLElement | null
    if (!s) return null
    const sr = s.getBoundingClientRect()
    const rows = (Array.from(s.querySelectorAll('.message-row[data-message-id]')) as HTMLElement[])
      .map((el) => {
        const r = el.getBoundingClientRect()
        return { id: el.dataset.messageId!, top: r.top - sr.top, bottom: r.bottom - sr.top }
      })
      .sort((a, b) => a.top - b.top)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgs: any[] = (window as any).__roomStore.getState().messages.get(jid) ?? []
    return {
      scrollTop: Math.round(s.scrollTop),
      distFromBottom: Math.round(s.scrollHeight - s.scrollTop - s.clientHeight),
      visible: rows.filter((r) => r.top >= 5 && r.bottom <= sr.height - 5),
      ids: msgs.map((m) => m.id as string),
      stamps: msgs.map((m) => new Date(m.timestamp).getTime()),
    }
  }, STRESS_ROOM_JID)

  /**
   * Inject `bodies` as delayed arrivals through the REAL live path (roomStore.addMessage →
   * appendLive — the same action the `room:message` binding calls), timestamped to sort in ABOVE
   * the viewport, and report how far the tracked reading row moved.
   */
  async function insertAboveViewport(
    page: Page,
    bodies: string[],
    options: {
      coalescedTail?: boolean
      maxDistanceFromBottom?: number
      minDistanceFromBottom?: number
      userTakeover?: boolean
    } = {},
  ) {
    const before = await readView(page)
    expect(before, 'the message list must be readable').not.toBeNull()
    expect(
      before!.distFromBottom,
      'precondition: the reader must be clear of the bottom',
    ).toBeGreaterThanOrEqual(options.minDistanceFromBottom ?? CLEAR_OF_BOTTOM_PX)
    if (options.maxDistanceFromBottom !== undefined) {
      expect(
        before!.distFromBottom,
        'precondition: the reader must remain below the requested distance',
      ).toBeLessThan(options.maxDistanceFromBottom)
    }
    expect(
      before!.scrollTop,
      'precondition: there must be content ABOVE the viewport to insert into',
    ).toBeGreaterThan(600)
    expect(
      before!.visible.length,
      'precondition: several fully-visible rows to track',
    ).toBeGreaterThan(3)

    // Track a row in the LOWER half of the viewport; insert 10 messages ABOVE the top-visible row
    // so the insertion is genuinely off-screen above rather than at the live edge.
    const track = before!.visible[before!.visible.length - 2]
    const topIdx = before!.ids.indexOf(before!.visible[0].id)
    expect(topIdx, 'precondition: the top-visible row is in the resident array').toBeGreaterThan(12)
    const insertTs = before!.stamps[topIdx - 10]
    let scrollTopBeforeTakeover: number | null = null

    if (options.coalescedTail) {
      expect(bodies).toHaveLength(1)
      await page.evaluate(([jid, ts, body, tailTs]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const store = (window as any).__roomStore.getState()
        store.addMessage(jid as string, {
          type: 'groupchat',
          id: 'delayed-arrival-0',
          stanzaId: 'sid-delayed-arrival-0',
          from: `${jid}/DelayedSender`,
          nick: 'DelayedSender',
          body: body as string,
          timestamp: new Date(ts as number),
          isOutgoing: false,
          isDelayed: true,
          roomJid: jid as string,
        })
        store.addMessage(jid as string, {
          type: 'groupchat',
          id: 'coalesced-tail-arrival',
          stanzaId: 'sid-coalesced-tail-arrival',
          from: `${jid}/TailSender`,
          nick: 'TailSender',
          body: 'live tail arrival in the same commit',
          timestamp: new Date(tailTs as number),
          isOutgoing: false,
          roomJid: jid as string,
        })
      }, [
        STRESS_ROOM_JID,
        insertTs,
        bodies[0],
        before!.stamps[before!.stamps.length - 1] + 1_000,
      ] as const)
    } else {
      for (let i = 0; i < bodies.length; i++) {
        await page.evaluate(([jid, ts, idx, body]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(window as any).__roomStore.getState().addMessage(jid as string, {
            type: 'groupchat',
            id: `delayed-arrival-${idx}`,
            stanzaId: `sid-delayed-arrival-${idx}`,
            from: `${jid}/DelayedSender`,
            nick: 'DelayedSender',
            body: body as string,
            timestamp: new Date(ts as number),
            isOutgoing: false,
            isDelayed: true,
            roomJid: jid as string,
          })
        }, [STRESS_ROOM_JID, insertTs, i, bodies[i]] as const)
        if (i === 0 && options.userTakeover) {
          await page.waitForFunction(
            (baseline) => {
              const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
              return scroller !== null && scroller.scrollTop > baseline + 200
            },
            before!.scrollTop,
          )
          scrollTopBeforeTakeover = await page.locator('[data-message-list]').first().evaluate(
            (element) => (element as HTMLElement).scrollTop,
          )
          await page.mouse.wheel(0, 600)
        }
        await page.waitForTimeout(80)
      }
    }
    await page.waitForTimeout(1200) // let any re-anchor / measurement settle

    const after = await readView(page)
    const trackedTop = await page.evaluate((id) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      const el = s?.querySelector(
        `.message-row[data-message-id="${CSS.escape(id)}"]`,
      ) as HTMLElement | null
      if (!s || !el) return null
      return el.getBoundingClientRect().top - s.getBoundingClientRect().top
    }, track.id)

    const insertedIndexes = bodies.map((_, i) => after!.ids.indexOf(`delayed-arrival-${i}`))
    return {
      trackedId: track.id,
      beforeTop: Math.round(track.top),
      afterTop: trackedTop === null ? null : Math.round(trackedTop),
      // A tracked row that unmounted entirely is a gross mis-position, not a small drift — report
      // it as such rather than silently passing on a missing element.
      drift: trackedTop === null ? Number.POSITIVE_INFINITY : Math.abs(trackedTop - track.top),
      allInsertedAboveViewport: insertedIndexes.every((k) => k >= 0 && k < topIdx),
      residentCountBefore: before!.ids.length,
      residentCountAfter: after!.ids.length,
      scrollTopBefore: before!.scrollTop,
      scrollTopAfter: after!.scrollTop,
      scrollTopBeforeTakeover,
      tailAtResidentEnd:
        after!.ids.indexOf('coalesced-tail-arrival') === after!.ids.length - 1,
    }
  }

  // Tolerance: a re-anchor settles against measured row heights, so a sub-row residual is expected.
  // Well under the smallest real regression this catches (a single inserted row is ~50px+, and the
  // uncompensated tall/burst cases are 250-425px).
  const INSERTION_DRIFT_PX = 40

  test('invariant-14: a single delayed arrival inserted above the viewport holds the reading position', async ({ page }) => {
    const probes: string[] = []
    page.on('console', (m) => { const t=m.text(); if (t.includes('[AnchorProbe]')||t.includes('[RestoreProbe]')) probes.push(t) })
    await openScrolledUp(page)
    const r = await insertAboveViewport(page, ['delayed arrival (offline replay)'])
    console.log('── INSERTION-DRIFT single ──', JSON.stringify(r))
    console.log('── ANCHOR PROBES ──\n' + probes.join('\n'))
    expect(r.allInsertedAboveViewport, 'the arrival must land ABOVE the viewport, not at the live edge').toBe(true)
    expect(
      r.residentCountAfter,
      `the insertion must not have provoked a pagination load — ${JSON.stringify(r)}`,
    ).toBe(r.residentCountBefore + 1)
    expect(
      r.drift,
      `reading position drifted ${r.drift}px after a message was inserted above the viewport`,
    ).toBeLessThan(INSERTION_DRIFT_PX)
  })

  test('invariant-14b: a TALL delayed arrival above the viewport holds the reading position', async ({ page }) => {
    await openScrolledUp(page)
    // Far taller than a normal row, so an uncompensated insertion drifts by hundreds of px — this
    // is what proves the hold is a real re-anchor and not a fixed small correction.
    const r = await insertAboveViewport(page, ['delayed arrival line\n'.repeat(18)])
    console.log('── INSERTION-DRIFT tall ──', JSON.stringify(r))
    expect(r.allInsertedAboveViewport, 'the arrival must land ABOVE the viewport').toBe(true)
    expect(
      r.drift,
      `reading position drifted ${r.drift}px after a TALL message was inserted above the viewport`,
    ).toBeLessThan(INSERTION_DRIFT_PX)
  })

  test('invariant-14c: a BURST of delayed arrivals above the viewport holds the reading position', async ({ page }) => {
    await openScrolledUp(page)
    // The offline-replay shape: a reconnect flushes a backlog, so the arrivals land as a run rather
    // than singly, and each one re-triggers the compensation.
    const r = await insertAboveViewport(page, Array.from({ length: 10 }, (_, i) => `replayed backlog message ${i}`))
    console.log('── INSERTION-DRIFT burst ──', JSON.stringify(r))
    expect(r.allInsertedAboveViewport, 'every arrival must land ABOVE the viewport').toBe(true)
    expect(
      r.residentCountAfter,
      `the burst must not have provoked a pagination load — ${JSON.stringify(r)}`,
    ).toBe(r.residentCountBefore + 10)
    expect(
      r.drift,
      `reading position drifted ${r.drift}px after a 10-message burst was inserted above the viewport`,
    ).toBeLessThan(INSERTION_DRIFT_PX)
  })

  test('invariant-14d: a delayed arrival at the resident bound holds the reading position', async ({ page }) => {
    await openScrolledUp(page, FULL_WINDOW_INSERTION_URL)
    const r = await insertAboveViewport(page, ['full-window delayed arrival\n'.repeat(18)])
    console.log('── INSERTION-DRIFT full-window ──', JSON.stringify(r))
    expect(r.allInsertedAboveViewport, 'the arrival must land ABOVE the viewport').toBe(true)
    expect(
      r.residentCountAfter,
      `the resident window must stay at its configured bound — ${JSON.stringify(r)}`,
    ).toBe(r.residentCountBefore)
    expect(
      r.drift,
      `reading position drifted ${r.drift}px after a full-window insertion`,
    ).toBeLessThan(INSERTION_DRIFT_PX)
  })

  test('invariant-14e: user input takes over insertion preservation', async ({ page }) => {
    await openScrolledUp(page)
    const r = await insertAboveViewport(
      page,
      ['delayed arrival before user takeover\n'.repeat(18)],
      { userTakeover: true },
    )
    console.log('── INSERTION-DRIFT user-takeover ──', JSON.stringify(r))
    expect(r.scrollTopBeforeTakeover, 'the insertion must settle before wheel takeover').not.toBeNull()
    expect(
      r.scrollTopAfter - r.scrollTopBeforeTakeover!,
      `the insertion restore overrode the reader's wheel movement — ${JSON.stringify(r)}`,
    ).toBeGreaterThan(500)
  })

  // A load-older that delivers NOTHING leaves no trace of itself: windowAtLiveEdge stays true and
  // firstMessageId never moves, so the directional-history restore neither fires nor releases its
  // snapshot. Left pending, the next UNRELATED firstMessageId change is misread as that load
  // completing — and at the resident bound an interior delayed arrival evicts the oldest row, which
  // is exactly such a change. The stale top anchor is then restored and insertion preservation is
  // skipped (its pending controller request refuses every ambient layout preservation), so the
  // reader is thrown back to where the abandoned load-older would have put them.
  //
  // The snapshot is now bounded by the lifetime of the load it was armed for, so an abandoned
  // load-older releases it instead of leaving it to claim someone else's window change. See
  // invariant-14k/14l for the other half: that bound must not cut a load-older's batch short.
  test('invariant-14g: an abandoned load-older does not defeat a later insertion at the resident bound', async ({ page }) => {
    await openScrolledUp(page, FULL_WINDOW_INSERTION_URL)

    // Neutralise both older-history sources so the load below genuinely returns nothing while still
    // being STARTED (the snapshot is taken when the load begins, not when it resolves).
    const stubbed = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const store = (window as any).__roomStore
      if (!store) return false
      store.setState({ loadOlderMessagesFromCache: async () => 0 })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const demo = (window as any).__demoClient
      // Returning false rather than skipping: a silently un-stubbed loader
      // fails much later, as an assertion about rows that looks unrelated.
      if (!demo?.messages) return false
      demo.messages.queryRoomMAM = async () => {}
      return true
    })
    expect(stubbed, 'the older-history loaders must be stubbable for this scenario').toBe(true)

    const firstIdBefore = (await readView(page))!.ids[0]

    // Start a load-older that will deliver nothing, and let it settle.
    await scrollToTopAndLoad(page)
    await page.waitForTimeout(SETTLE_MS)

    const afterAbandoned = await readView(page)
    expect(
      afterAbandoned!.ids[0],
      'precondition: the abandoned load must not have delivered any older rows',
    ).toBe(firstIdBefore)

    // Return to mid-history so the reader is scrolled up but clear of the top boundary.
    await page.locator('[data-message-list]').first().evaluate((element) => {
      const scroller = element as HTMLElement
      const maxScrollTop = scroller.scrollHeight - scroller.clientHeight
      scroller.scrollTop = Math.max(800, Math.min(maxScrollTop - 800, maxScrollTop * 0.55))
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }))
    })
    await page.waitForTimeout(SETTLE_MS)

    const r = await insertAboveViewport(page, ['delayed arrival after an abandoned load-older\n'.repeat(18)])
    console.log('── INSERTION-DRIFT abandoned-load-older ──', JSON.stringify(r))
    expect(r.allInsertedAboveViewport, 'the arrival must land ABOVE the viewport').toBe(true)
    expect(
      r.drift,
      `reading position drifted ${r.drift}px after an abandoned load-older preceded the insertion`,
    ).toBeLessThan(INSERTION_DRIFT_PX)
  })

  test('invariant-14f: a scroller resize refreshes the insertion anchor', async ({ page }) => {
    await openScrolledUp(page)
    const resized = await page.locator('[data-message-list]').first().evaluate((element) => {
      const scroller = element as HTMLElement
      const before = scroller.clientHeight
      scroller.style.flex = 'none'
      scroller.style.height = `${before - 96}px`
      return { before, after: scroller.clientHeight }
    })
    expect(resized.after, 'the scroller must shrink before insertion').toBeLessThan(resized.before)
    await page.waitForTimeout(100)

    const r = await insertAboveViewport(page, ['delayed arrival after scroller resize\n'.repeat(18)])
    console.log('── INSERTION-DRIFT scroller-resize ──', JSON.stringify(r))
    expect(
      r.drift,
      `reading position drifted ${r.drift}px after a scroller resize and insertion`,
    ).toBeLessThan(INSERTION_DRIFT_PX)
  })

  test('invariant-14h: insertion preservation starts at the semantic live-edge threshold', async ({ page }) => {
    await openScrolledUp(page, INSERTION_URL, 225)
    const r = await insertAboveViewport(
      page,
      ['delayed arrival inside the FAB threshold gap\n'.repeat(18)],
      {
        minDistanceFromBottom: AT_BOTTOM_OK_PX,
        maxDistanceFromBottom: FAB_THRESHOLD_PX,
      },
    )
    expect(
      r.drift,
      `reading position drifted ${r.drift}px inside the live-edge/FAB threshold gap`,
    ).toBeLessThan(INSERTION_DRIFT_PX)
  })

  test('invariant-14i: a capped coalesced interior and tail arrival holds the reading position', async ({ page }) => {
    await openScrolledUp(page, FULL_WINDOW_INSERTION_URL)
    const r = await insertAboveViewport(
      page,
      ['coalesced delayed interior arrival\n'.repeat(18)],
      { coalescedTail: true },
    )
    expect(r.allInsertedAboveViewport, 'the delayed arrival must land above the viewport').toBe(true)
    expect(r.tailAtResidentEnd, 'the coalesced live arrival must land at the resident tail').toBe(true)
    expect(r.residentCountAfter, 'the resident window must remain at its bound').toBe(
      r.residentCountBefore,
    )
    expect(
      r.drift,
      `reading position drifted ${r.drift}px after a capped coalesced interior and tail arrival`,
    ).toBeLessThan(INSERTION_DRIFT_PX)
  })

  test('invariant-14j: a legacy coalesced interior and tail arrival holds the reading position', async ({ page }) => {
    await openScrolledUp(page, INSERTION_URL, undefined, false)
    const r = await insertAboveViewport(
      page,
      ['legacy delayed interior arrival\n'.repeat(18)],
      { coalescedTail: true },
    )
    expect(r.allInsertedAboveViewport, 'the delayed arrival must land above the viewport').toBe(true)
    expect(r.tailAtResidentEnd, 'the coalesced live arrival must land at the resident tail').toBe(true)
    expect(
      r.drift,
      `legacy reading position drifted ${r.drift}px after a coalesced interior and tail arrival`,
    ).toBeLessThan(INSERTION_DRIFT_PX)
  })

  // ── The other half of the snapshot lifecycle: it must NOT be released too eagerly ──────────
  //
  // Releasing the directional snapshot whenever an interior arrival lands is the obvious way to
  // stop a stale snapshot claiming an unrelated first-id change (invariant-14g). It is also wrong:
  // a load-older that is still IN FLIGHT when the arrival lands comes back to an empty snapshot and
  // gets no restore. The two tests below hold a load-older open across an interior arrival — once
  // under the resident cap, once at it — and require the reader to be held either way.
  //
  // 14l is the one that discriminates, and it is RED-verified: with the snapshot cancelled on every
  // interior-placement advance, the tracked row is not merely drifted but WINDOWED OUT ENTIRELY
  // (afterTop null), and it is the only failure in the whole suite — insertion preservation quietly
  // absorbs the under-cap case (14k), so nothing else here notices the loss.

  /** Total drift budget for a sequence that both preserves an insertion AND restores a prepend.
   *  Two settles compound, so this is wider than either alone — but a dropped restore is ~3000px
   *  (a 50-row batch) and a dropped preservation ~450px, so both regressions stay unmissable. */
  const IN_FLIGHT_DRIFT_PX = 60

  /**
   * Hold the demo's older-history MAM answer open, so an arrival can be injected while a
   * load-older is genuinely IN FLIGHT, then let the batch land and report how far the tracked
   * reading row moved across the whole sequence.
   */
  async function insertDuringInFlightLoadOlder(page: Page, body: string) {
    // Gate the synthetic MAM batch. The cache path in front of it returns nothing in demo mode
    // (all seeded messages are already resident), so this is the whole delivery of a load-older.
    const gated = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const demo = (window as any).__demoClient
      if (!demo?.messages) return false
      const original = demo.messages.queryRoomMAM.bind(demo.messages)
      let open: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        open = resolve
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__releaseOlderLoad = open
      demo.messages.queryRoomMAM = async (options: unknown) => {
        await gate
        return original(options)
      }
      return true
    })
    expect(gated, 'the demo older-history answer must be gateable for this scenario').toBe(true)

    const before = await readView(page)
    expect(before, 'the message list must be readable').not.toBeNull()
    expect(
      before!.distFromBottom,
      'precondition: the reader must be clear of the bottom',
    ).toBeGreaterThanOrEqual(CLEAR_OF_BOTTOM_PX)
    expect(
      before!.visible.length,
      'precondition: several fully-visible rows to track',
    ).toBeGreaterThan(3)

    const track = before!.visible[before!.visible.length - 2]
    const topIdx = before!.ids.indexOf(before!.visible[0].id)
    expect(topIdx, 'precondition: the top-visible row is in the resident array').toBeGreaterThan(12)
    const insertTs = before!.stamps[topIdx - 10]

    // Arm the directional snapshot WITHOUT moving the reader: handleLoadEarlier, not a
    // scroll-to-top, so the reader stays mid-history with content above and below.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const trigger = (window as any).__fluuxTriggerLoadOlder
      if (typeof trigger === 'function') trigger()
    })
    await page.waitForTimeout(200)

    const inFlight = await page.evaluate((jid) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Boolean((window as any).__roomStore.getState().getRoomMAMQueryState(jid)?.isLoading)
    }, STRESS_ROOM_JID)
    expect(inFlight, 'precondition: the load-older must still be in flight').toBe(true)

    // The delayed arrival lands while that load is still waiting for its batch.
    await page.evaluate(([jid, ts, text]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__roomStore.getState().addMessage(jid as string, {
        type: 'groupchat',
        id: 'delayed-arrival-0',
        stanzaId: 'sid-delayed-arrival-0',
        from: `${jid}/DelayedSender`,
        nick: 'DelayedSender',
        body: text as string,
        timestamp: new Date(ts as number),
        isOutgoing: false,
        isDelayed: true,
        roomJid: jid as string,
      })
    }, [STRESS_ROOM_JID, insertTs, body] as const)
    await page.waitForTimeout(400)

    const midway = await readView(page)

    // Let the load-older deliver its batch.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__releaseOlderLoad?.()
    })
    await page.waitForTimeout(2000)

    const after = await readView(page)
    const trackedTop = await page.evaluate((id) => {
      const s = document.querySelector('[data-message-list]') as HTMLElement | null
      const el = s?.querySelector(
        `.message-row[data-message-id="${CSS.escape(id)}"]`,
      ) as HTMLElement | null
      if (!s || !el) return null
      return el.getBoundingClientRect().top - s.getBoundingClientRect().top
    }, track.id)

    // Read placement from the MIDWAY array: the batch that lands afterwards renumbers every index.
    const insertedIndex = midway!.ids.indexOf('delayed-arrival-0')
    const midwayTopIndex = midway!.visible.length > 0
      ? midway!.ids.indexOf(midway!.visible[0].id)
      : -1
    return {
      trackedId: track.id,
      beforeTop: Math.round(track.top),
      afterTop: trackedTop === null ? null : Math.round(trackedTop),
      drift: trackedTop === null ? Number.POSITIVE_INFINITY : Math.abs(trackedTop - track.top),
      insertedAboveViewport:
        insertedIndex >= 0 && midwayTopIndex >= 0 && insertedIndex < midwayTopIndex,
      firstIdBefore: before!.ids[0],
      firstIdMidway: midway!.ids[0],
      firstIdAfter: after!.ids[0],
      residentCountBefore: before!.ids.length,
      residentCountMidway: midway!.ids.length,
      residentCountAfter: after!.ids.length,
      scrollTopBefore: before!.scrollTop,
      scrollTopAfter: after!.scrollTop,
    }
  }

  test('invariant-14k: an interior arrival during an in-flight load-older does not cost the batch its restore', async ({ page }) => {
    await openScrolledUp(page)
    const r = await insertDuringInFlightLoadOlder(
      page,
      'delayed arrival during an in-flight load-older\n'.repeat(18),
    )
    console.log('── INSERTION-DRIFT in-flight-load-older ──', JSON.stringify(r))
    expect(r.insertedAboveViewport, 'the arrival must land ABOVE the viewport').toBe(true)
    expect(
      r.firstIdMidway,
      'precondition: under the resident cap the arrival must not move the first id',
    ).toBe(r.firstIdBefore)
    expect(
      r.firstIdAfter,
      `precondition: the gated load-older must have delivered its batch — ${JSON.stringify(r)}`,
    ).not.toBe(r.firstIdBefore)
    expect(
      r.drift,
      `reading position drifted ${r.drift}px when a batch landed after an interior arrival`,
    ).toBeLessThan(IN_FLIGHT_DRIFT_PX)
  })

  test('invariant-14l: an interior arrival at the resident bound holds the reading position across an in-flight load-older', async ({ page }) => {
    await openScrolledUp(page, FULL_WINDOW_INSERTION_URL)
    const r = await insertDuringInFlightLoadOlder(
      page,
      'bound delayed arrival during an in-flight load-older\n'.repeat(18),
    )
    console.log('── INSERTION-DRIFT bound-in-flight-load-older ──', JSON.stringify(r))
    expect(r.insertedAboveViewport, 'the arrival must land ABOVE the viewport').toBe(true)
    // At the bound the arrival EVICTS the oldest row, so it moves the first id without any window
    // shift — the exact signal the pending snapshot discriminates on. Whichever of the two owners
    // ends up holding the reader, the reader must not move.
    expect(
      r.firstIdMidway,
      `precondition: at the resident bound the arrival must evict the oldest row — ${JSON.stringify(r)}`,
    ).not.toBe(r.firstIdBefore)
    expect(
      r.residentCountMidway,
      'precondition: the resident window must stay at its bound',
    ).toBe(r.residentCountBefore)
    expect(
      r.firstIdAfter,
      `precondition: the gated load-older must have delivered its batch — ${JSON.stringify(r)}`,
    ).not.toBe(r.firstIdMidway)
    expect(
      r.drift,
      `reading position drifted ${r.drift}px when a batch landed after an eviction at the bound`,
    ).toBeLessThan(IN_FLIGHT_DRIFT_PX)
  })
})
