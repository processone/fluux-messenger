import { expect, type Page } from '@playwright/test'
import { bootDemo } from './demoBoot'
import { syncEngineGeometry } from './compositorSync'

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Enable virtualization after the demo clears localStorage, seed one room with
 * 80 messages to exceed the visible window, and skip the guided tour.
 */
const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:80,msgStep:0'

/** The stress room JID (stress-0@conference.<domain>). Domain from src/demo/constants.ts. */
export const STRESS_ROOM_JID = 'stress-0@conference.fluux.chat'

const SETTLE_MS = 700          // time to let scroll + measurement settle after an action
export const FRAME_SAMPLE_MS = 500   // window for scrollTop stability sampling after prepend settle
// Drift tolerance for the virtualizer path: one final ResizeObserver callback can fire
// just after the 60-frame re-assert loop exits and shift getOffsetForMessageId by ~16px
// without the loop being able to catch it. 20px covers this measurement noise while
// still catching real regressions (e.g. oscillations produce 100px+ swings).
export const PREPEND_DRIFT_PX = 20  // acceptable anchor-position drift after prepend (px)
export const LARGE_JUMP_PX = 150     // frame-to-frame jump threshold signalling instability
export const AT_BOTTOM_OK_PX = 150   // distance-from-bottom still considered "stuck to bottom"
export const FAB_THRESHOLD_PX = 300
// Distance-from-bottom a test must reach before it can claim the reader is NOT at the bottom.
// Deliberately several times AT_BOTTOM_OK_PX: engines differ in how much of a wheel gesture they
// apply per scroll event, so a margin this wide is what makes "the reader has left the bottom" an
// engine-independent fact rather than a coin flip on event granularity.
export const CLEAR_OF_BOTTOM_PX = 800

/**
 * Wait out an action before a settled snapshot. See syncEngineGeometry in e2e/compositorSync.ts
 * for the synchronization requirement and the timing windows where it must not be used.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(SETTLE_MS)
  await syncEngineGeometry(page)
}

// ── Shared setup ─────────────────────────────────────────────────────────────

/** Load demo, wait for demo to be fully ready (sidebar + stores populated). */
export async function loadDemo(page: Page): Promise<void> {
  await bootDemo(page, DEMO_URL)
  await page.evaluate(() => {
    ;(
      window as Window & {
        __fluuxScrollShadow?: (reset?: boolean) => unknown
      }
    ).__fluuxScrollShadow?.(true)
  })
}

export async function assertScrollShadow({ page }: { page: Page }): Promise<void> {
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
}

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
export async function navigateToStressRoom(page: Page, virtualized = true): Promise<void> {
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
  await settle(page)
}

/** Turn on the shared scroll-decision trace ([Scroll] / [ScrollStateManager] console lines). */
export async function enableScrollTrace(page: Page): Promise<void> {
  await page.evaluate(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(window as any).__fluuxScrollDebug?.(true)
  })
}

/** Get the scrollTop of the message-list scroll container. */
export async function getScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const s = document.querySelector('[data-message-list]') as HTMLElement | null
    return s ? s.scrollTop : 0
  })
}

/** Get the number of mounted virtual rows (absolute-positioned wrappers). */
export async function getMountedRowCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-index]').length)
}

/**
 * Total height of the virtualizer's spacer div = getTotalSize() = N * estimateSize
 * (for unmeasured rows). Increases by ~BATCH * estimateSize on each successful load-older.
 * This is reliable regardless of which rows are currently in the virtualizer window.
 */
export async function getSpacerHeight(page: Page): Promise<number> {
  return page.evaluate(() => {
    const spacer = document.querySelector('[data-virtualizer-spacer]') as HTMLElement | null
    return spacer ? spacer.offsetHeight : 0
  })
}

/**
 * Debug snapshot: number of mounted [data-index] rows, scrollTop, spacer height, isLoading.
 * Used in invariant-2 failure context to understand why load-older might not fire.
 */
export async function getDebugState(page: Page): Promise<Record<string, unknown>> {
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
export async function findBottomVisibleMessage(page: Page): Promise<{ id: string; topInView: number } | null> {
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
export function stressMsgIndex(id: string | null): number {
  if (!id) return NaN
  const m = /-(\d+)$/.exec(id)
  return m ? Number(m[1]) : NaN
}

/** Get a message row's current viewport offset-from-top (null if not mounted). */
export async function getMessageOffsetFromTop(page: Page, messageId: string): Promise<number | null> {
  return page.evaluate((id) => {
    const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
    if (!scroller) return null
    const el = scroller.querySelector(`[data-message-id="${CSS.escape(id)}"]`) as HTMLElement | null
    if (!el) return null
    return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top
  }, messageId)
}

/** Sample scrollTop every rAF for `durationMs`, return the array. */
export async function sampleScrollTop(page: Page, durationMs: number): Promise<number[]> {
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
export async function waitForAnchorSettled(
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
export async function waitForTopVisibleSettled(
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
export async function setScrollTop(page: Page, value: number): Promise<void> {
  await page.evaluate((v) => {
    const s = document.querySelector('[data-message-list]') as HTMLElement | null
    if (s) s.scrollTop = v
  }, value)
}

/** Scroll programmatically to the top and also fire a wheel event to trigger load-older. */
export async function scrollToTopAndLoad(page: Page): Promise<void> {
  // Set scrollTop=0 — triggers handleScroll → triggerLoadOlder
  await setScrollTop(page, 0)
  await page.waitForTimeout(50)
  // Also fire a wheel-up in case scrollTop was already 0 (handleWheel path)
  const scroller = page.locator('[data-message-list]').first()
  await scroller.dispatchEvent('wheel', { deltaY: -500, bubbles: true })
  await page.waitForTimeout(50)
}

/** Scroll programmatically to the bottom of the message list. */
export async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const s = document.querySelector('[data-message-list]') as HTMLElement | null
    if (s) s.scrollTop = s.scrollHeight
  })
  await settle(page)
}

/** Activate a 1:1 conversation through the real store + route (no room auto-select race). */
export async function activateChat(page: Page, jid: string): Promise<void> {
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
  await settle(page)
}
