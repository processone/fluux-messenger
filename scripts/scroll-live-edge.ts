import { test, expect, type Page } from '@playwright/test'
import { withPinWindow, type PinGrowthStep } from './e2e/pinWindow'
import { syncEngineGeometry } from './e2e/compositorSync'
import {
  STRESS_ROOM_JID,
  AT_BOTTOM_OK_PX,
  CLEAR_OF_BOTTOM_PX,
  settle,
  loadDemo,
  assertScrollShadow,
  navigateToStressRoom,
  enableScrollTrace,
  getScrollTop,
  getMountedRowCount,
  setScrollTop,
  scrollToBottom,
  activateChat,
} from './e2e/scrollHarness'

test.afterEach(assertScrollShadow)

test.describe('Virtualization scroll invariants', () => {

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
    await settle(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await settle(page)
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
    await settle(page)

    await setTyping(page, true)
    await page.waitForSelector('[data-typing-pill]', { timeout: 5_000 })
    await settle(page)

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
    await settle(page)
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
    await syncEngineGeometry(page)

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
    await settle(page)
    const before = await readGeometry(page)
    expect(
      before.distFromBottom,
      'precondition: the reader is off the edge but still inside the at-bottom band',
    ).toBeGreaterThan(PIN_TOLERANCE_PX)
    expect(before.distFromBottom, 'precondition: inside the band').toBeLessThan(AT_BOTTOM_OK_PX)

    await setTyping(page, true)
    await page.waitForSelector('[data-typing-pill]', { timeout: 5_000 })
    await settle(page)

    expect(
      (await readGeometry(page)).distFromBottom,
      'a reader inside the band must be re-pinned, exactly as an armed follow already is',
    ).toBeLessThanOrEqual(PIN_TOLERANCE_PX)
  })

  test('never re-pins a reader who deliberately scrolled up', async ({ page }) => {
    await enterAtBottom(page)

    await page.mouse.wheel(0, -2500)
    await settle(page)
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
    await settle(page)

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
    await settle(page)

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
    await settle(page)

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
    await settle(page)

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
    await settle(page)

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
      await settle(page)
    }

    const twoLines =
      'This draft is long enough to wrap the composer onto a second line, which shrinks the ' +
      'message viewport under a pill that does not move with it.'

    const anchored = await probeBottomAnchor(page)
    expect(anchored.tailRowId, 'precondition: the newest message must be the tail row').toBe(tailId)
    expect(anchored.distFromBottom, 'precondition: must start at the bottom').toBeLessThanOrEqual(GLUED_TOLERANCE_PX)

    // ── Composer GROWS ──────────────────────────────────────────────────────
    // The next resize must exercise a fresh reconciliation; a still-active growth pin can
    // absorb it without starting either of the shrink-direction triggers asserted below.
    await withPinWindow(page, { trigger: 'container-shrink' }, () => setDraft(twoLines))

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
    await settle(page)

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
    await settle(page)
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
    await settle(page)

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
    await settle(page)

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
    await settle(page)

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
    await settle(page)

    const lastId = await reactToNewest(page, AVA)
    await settle(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await settle(page)

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
    await settle(page)

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
    await settle(page)

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
    await settle(page)

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
    await settle(page)

    const before = await bottomState(page, id)
    expect(before.distFromBottom, 'precondition: must start stuck to the bottom').toBeLessThan(AT_BOTTOM_OK_PX)

    await fastenPreview(page, AVA, id, url)
    // Wait for the REAL card to be in the DOM — this is the growth the scroll layer must absorb.
    await page.waitForSelector(`a[href="${url}"]`, { timeout: 5_000 })
    await page.waitForTimeout(600)
    await syncEngineGeometry(page)

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
    await settle(page)

    await setScrollTop(page, 200)
    await settle(page)
    const before = await getScrollTop(page)

    await fastenPreview(page, AVA, id, url)
    await page.waitForSelector(`a[href="${url}"]`, { timeout: 5_000 })
    await page.waitForTimeout(600)
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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

// A batch can remove the entire visible tail; retain the live edge and the
// ordinary moderation notice while the archive identities stay in the store.
test('Spam moderation removes rows without leaving an empty tail', async ({ page }) => {
  await loadDemo(page)
  await navigateToStressRoom(page)
  const batch = await page.evaluate((roomJid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const store = (window as any).__roomStore
    const messages = store.getState().messages.get(roomJid) as Array<{ id: string; stanzaId: string }>
    const targets = messages.slice(-6)
    for (const [index, message] of targets.entries()) {
      store.getState().updateMessage(roomJid, message.stanzaId, {
        isRetracted: true, isModerated: true, moderationReason: index === 0 ? 'Off topic' : 'Spam',
      })
    }
    return { count: messages.length, kept: targets[0].id, hidden: targets.slice(1).map(message => message.id) }
  }, STRESS_ROOM_JID)
  for (const id of batch.hidden) {
    await expect(page.locator(`[data-message-id="${id}"]`)).toHaveCount(0)
  }
  await expect(page.locator(`.message-row[data-message-id="${batch.kept}"]`)).toBeVisible()
  await expect.poll(() => page.evaluate(() => {
    const list = document.querySelector('[data-message-list]') as HTMLElement
    return Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop)
  })).toBeLessThan(8)
  expect(await page.evaluate((roomJid) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (window as any).__roomStore.getState().messages.get(roomJid).length
  }, STRESS_ROOM_JID)).toBe(batch.count)
})
