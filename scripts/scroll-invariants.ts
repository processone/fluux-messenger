/**
 * Playwright scroll-invariant harness for the message-list virtualization path.
 *
 * PHASE 0 GOAL: Encode the 6 acceptance invariants as assertions that go RED
 * against the buggy virtualized path, proving the harness catches the real bugs.
 * They become the acceptance gate for the Phase 1 rework.
 *
 * Run:
 *   npx playwright test --config=playwright.scroll.config.ts --project=chromium
 *   npx playwright test --config=playwright.scroll.config.ts --project=webkit
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

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * URL: virt=1 sets the flag AFTER demo.tsx clears localStorage (the seam added in P0.1).
 * stress: seed 1 room with 200 messages (> ~60 window) instantly (msgStep:0).
 * tutorial=false: skip the guided tour so the chat layout is immediately visible.
 */
const DEMO_URL = '/demo.html?tutorial=false&virt=1&stress=rooms:1,messages:200,msgStep:0'

/** The stress room JID (stress-0@conference.<domain>). Domain from src/demo/constants.ts. */
const STRESS_ROOM_JID = 'stress-0@conference.fluux.chat'

const SETTLE_MS = 700          // time to let scroll + measurement settle after an action
const FRAME_SAMPLE_MS = 500   // window for scrollTop stability sampling after prepend settle
const PREPEND_DRIFT_PX = 2    // acceptable anchor-position drift after prepend (px)
const LARGE_JUMP_PX = 150     // frame-to-frame jump threshold signalling instability

// ── Shared setup ─────────────────────────────────────────────────────────────

/** Load demo, wait for demo to be fully ready (sidebar + stores populated). */
async function loadDemo(page: Page): Promise<void> {
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' })
  // Sidebar nav proves React mounted
  await page.waitForSelector('[data-nav="messages"]', { timeout: 20_000 })
  // Extra wait for the setTimeout(0) stress seeding to complete
  await page.waitForTimeout(1200)
}

/** Navigate to the stress room via hash route and wait for virtual rows to appear. */
async function navigateToStressRoom(page: Page): Promise<void> {
  await page.evaluate((jid) => {
    window.location.hash = '#/rooms/' + encodeURIComponent(jid)
  }, STRESS_ROOM_JID)
  // Wait for at least one virtualized row to mount ([data-index] exists)
  await page.waitForSelector('[data-index]', { timeout: 15_000 })
  await page.waitForTimeout(SETTLE_MS)
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

/** Get the set of visible message IDs (message-row elements in the DOM). */
async function getMessageIdCount(page: Page): Promise<number> {
  return page.evaluate(() =>
    new Set(Array.from(document.querySelectorAll('[data-message-id]'))
      .map((el) => (el as HTMLElement).dataset.messageId)
      .filter(Boolean)
    ).size
  )
}

/**
 * Find the top-most message row whose top edge is at or below the scroller's top edge.
 * Returns {id, offsetFromTop} or null.
 */
async function findTopVisibleMessage(page: Page): Promise<{ id: string; offsetFromTop: number } | null> {
  return page.evaluate(() => {
    const scroller = document.querySelector('[data-message-list]') as HTMLElement | null
    if (!scroller) return null
    const scrollerRect = scroller.getBoundingClientRect()
    const rows = Array.from(scroller.querySelectorAll('[data-message-id]')) as HTMLElement[]
    for (const row of rows) {
      const rect = row.getBoundingClientRect()
      const offsetFromTop = rect.top - scrollerRect.top
      if (offsetFromTop >= -rect.height / 2) {
        return { id: row.dataset.messageId!, offsetFromTop }
      }
    }
    return rows.length > 0
      ? { id: rows[0].dataset.messageId!, offsetFromTop: rows[0].getBoundingClientRect().top - scrollerRect.top }
      : null
  })
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

// ── Invariant tests ───────────────────────────────────────────────────────────

test.describe('Virtualization scroll invariants', () => {

  // ── 1: Prepend holds position ──────────────────────────────────────────────

  test('invariant-1: prepend holds anchor position within 2px, no large per-frame jumps', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Scroll to ~30% from top so there are messages above and below the anchor
    const scrollHeight = await page.evaluate(() => {
      const s = document.querySelector('[data-message-list]') as HTMLElement
      return s ? s.scrollHeight : 0
    })
    await setScrollTop(page, Math.floor(scrollHeight * 0.3))
    await page.waitForTimeout(300)

    // Record the top-visible message before load-older
    const before = await findTopVisibleMessage(page)
    expect(before, 'must find a top-visible anchor message before prepend').not.toBeNull()
    const anchorId = before!.id
    const anchorOffsetBefore = before!.offsetFromTop

    // Trigger load-older (scroll to top)
    await scrollToTopAndLoad(page)

    // Sample scrollTop for FRAME_SAMPLE_MS immediately after restore
    // (the 80ms network delay + react re-render + useLayoutEffect restore all happen here)
    await page.waitForTimeout(200) // let the restore fire
    const samples = await sampleScrollTop(page, FRAME_SAMPLE_MS)
    await page.waitForTimeout(200) // let the 15-frame re-assert finish

    // Assertion A: no large frame-to-frame jump during the stable period
    // (Skipping the first few frames where the initial scroll-to-top and restore are expected)
    let maxJump = 0
    for (let i = 5; i < samples.length; i++) {
      const jump = Math.abs(samples[i] - samples[i - 1])
      if (jump > maxJump) maxJump = jump
    }
    expect(maxJump, `max frame-to-frame scrollTop jump ${maxJump}px > ${LARGE_JUMP_PX}px (oscillation detected)`).toBeLessThanOrEqual(LARGE_JUMP_PX)

    // Assertion B: anchor message is within PREPEND_DRIFT_PX of its original viewport offset
    const anchorOffsetAfter = await getMessageOffsetFromTop(page, anchorId)
    expect(anchorOffsetAfter, `anchor "${anchorId}" not found in DOM after prepend — it was windowed out`).not.toBeNull()
    const drift = Math.abs(anchorOffsetAfter! - anchorOffsetBefore)
    expect(drift, `anchor drifted by ${drift}px (limit: ${PREPEND_DRIFT_PX}px)`).toBeLessThanOrEqual(PREPEND_DRIFT_PX)
  })

  // ── 2: No runaway pagination ───────────────────────────────────────────────

  test('invariant-2: one load-older trigger loads exactly one batch, viewport not stuck at top', async ({ page }) => {
    await loadDemo(page)
    await navigateToStressRoom(page)

    // Scroll to middle first (so we have a non-zero scrollTop reference)
    await setScrollTop(page, 2000)
    await page.waitForTimeout(200)

    const countBefore = await getMessageIdCount(page)

    // Trigger exactly one load-older by scrolling to top
    await scrollToTopAndLoad(page)

    // Wait for the 80ms network round-trip + render + restore (generously)
    await page.waitForTimeout(1200)

    const countAfter = await getMessageIdCount(page)
    const added = countAfter - countBefore

    // The batch is BATCH=50 from demoLoadOlder.ts. Allow ±5 for dedup / header items.
    expect(added, `added ${added} messages — expected 1 batch (~50). Zero means load never fired.`).toBeGreaterThanOrEqual(40)
    expect(added, `added ${added} messages — possible runaway (> 2 batches of 50)`).toBeLessThanOrEqual(110)

    // Wait another second to confirm count is stable (no runaway re-trigger)
    await page.waitForTimeout(1500)
    const countFinal = await getMessageIdCount(page)
    const secondBatch = countFinal - countAfter
    expect(secondBatch, `count kept growing by ${secondBatch} during idle — runaway pagination`).toBeLessThan(30)

    // Assert scrollTop is NOT 0 (the restore must have moved us away from the top)
    const scrollTop = await getScrollTop(page)
    expect(scrollTop, 'scrollTop still 0 after prepend restore — restore never fired or was overridden').toBeGreaterThan(5)
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
      // Accept a bottom gap of 120px (FAB / padding / typing indicator overlap)
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

    // Wait for React to render + @tanstack to re-window + rows to measure
    await page.waitForTimeout(500)

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

})
