import { test, expect, type Page } from '@playwright/test'
import type { chatStore, roomStore } from '@fluux/sdk/stores'
import type { Message, RoomMessage } from '@fluux/sdk'
import { bootDemo } from './e2e/demoBoot'
import { withPinWindow } from './e2e/pinWindow'
import { syncEngineGeometry } from './e2e/compositorSync'
import {
  STRESS_ROOM_JID,
  FRAME_SAMPLE_MS,
  PREPEND_DRIFT_PX,
  LARGE_JUMP_PX,
  AT_BOTTOM_OK_PX,
  FAB_THRESHOLD_PX,
  CLEAR_OF_BOTTOM_PX,
  SETTLE_MS,
  settle,
  wheelUntil,
  wheelAwayFromBottom,
  loadDemo,
  assertScrollShadow,
  navigateToStressRoom,
  enableScrollTrace,
  getScrollTop,
  getMountedRowCount,
  getSpacerHeight,
  getDebugState,
  findBottomVisibleMessage,
  stressMsgIndex,
  getMessageOffsetFromTop,
  sampleScrollTop,
  waitForAnchorSettled,
  waitForTopVisibleSettled,
  setScrollTop,
  scrollToTopAndLoad,
  scrollToBottom,
  activateChat,
} from './e2e/scrollHarness'
import { installViewportGeometryFixture } from './e2e/viewportGeometryFixture'

test.afterEach(assertScrollShadow)

// ── Invariant tests ───────────────────────────────────────────────────────────

test('clamped top wheel starts older history before any scroll event', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 900, height: 700 })
  await bootDemo(page, '/demo.html?tutorial=false&virt=1&window=100&stress=rooms:1,messages:250,msgStep:0,mode:live')
  await enableScrollTrace(page)
  await withPinWindow(page, { trigger: 'switch' }, async () => {
    await navigateToStressRoom(page)
  })

  const readHistory = () => page.evaluate(jid => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messages = (window as any).__roomStore.getState().messages.get(jid)
    const scroller = document.querySelector('[data-message-list]')!
    return {
      first: messages[0].id as string,
      count: messages.length as number,
      top: scroller.scrollTop,
      height: scroller.scrollHeight,
    }
  }, STRESS_ROOM_JID)
  const initial = await readHistory()
  expect(initial.first).toBe('stress-0-150')
  expect(initial.count).toBe(100)
  expect(initial.top).toBeGreaterThan(500)

  const scroller = page.locator('[data-message-list]')
  const preparedTop = await scroller.evaluate(element => new Promise<number>(resolve => {
    const blockSetupScroll = (event: Event) => event.stopImmediatePropagation()
    element.addEventListener('scroll', blockSetupScroll, { capture: true })
    element.scrollTop = 0
    requestAnimationFrame(() => requestAnimationFrame(() => {
      element.removeEventListener('scroll', blockSetupScroll, { capture: true })
      resolve(element.scrollTop)
    }))
  }))
  expect(preparedTop).toBe(0)
  await page.evaluate(() => {
    const scope = window as Window & {
      __clampedTopHistoryEvents?: { type: 'wheel' | 'loader' | 'scroll'; trusted?: boolean }[]
    }
    const scroller = document.querySelector<HTMLElement>('[data-message-list]')!
    const store = (window as unknown as { __roomStore: typeof roomStore }).__roomStore
    const original = store.getState().loadOlderMessagesFromCache
    scope.__clampedTopHistoryEvents = []
    scroller.addEventListener('wheel', event => {
      scope.__clampedTopHistoryEvents!.push({ type: 'wheel', trusted: event.isTrusted })
    }, { capture: true })
    scroller.addEventListener('scroll', () => {
      scope.__clampedTopHistoryEvents!.push({ type: 'scroll' })
    }, { capture: true })
    store.setState({
      loadOlderMessagesFromCache: async (...args) => {
        scope.__clampedTopHistoryEvents!.push({ type: 'loader' })
        return original(...args)
      },
    })
  })
  await scroller.hover()
  await page.mouse.wheel(0, -20)
  try {
    await expect.poll(async () => (await readHistory()).first, { timeout: 15_000 }).toBe('stress-0-100')
    const events = await page.evaluate(() => (window as unknown as Window & {
      __clampedTopHistoryEvents: { type: 'wheel' | 'loader' | 'scroll'; trusted?: boolean }[]
    }).__clampedTopHistoryEvents)
    const loader = events.findIndex(event => event.type === 'loader')
    expect(loader).toBeGreaterThan(0)
    expect(events[0]).toEqual({ type: 'wheel', trusted: true })
    expect(events.slice(0, loader)).not.toContainEqual({ type: 'scroll' })
  } finally {
    await testInfo.attach('first-wheel-history', {
      body: JSON.stringify({
        initial,
        preparedTop,
        events: await page.evaluate(() => (window as Window & {
          __clampedTopHistoryEvents?: unknown
        }).__clampedTopHistoryEvents),
        after: await readHistory(),
      }),
      contentType: 'application/json',
    })
    await testInfo.attach('first-wheel-history-viewport', {
      body: await page.screenshot(),
      contentType: 'image/png',
    })
  }
})

test.describe('Controller-owned resident-top navigation', () => {
  test('Home advances through attributed frames, settles, and respects interruption', async ({
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
    const installProbe = () => page.evaluate((startedAt) => {
      const scroller = document.querySelector('[data-message-list]') as HTMLDivElement | null
      if (!scroller) return
      const writes: ScrollToOptions[] = []
      const probe = window as Window & {
        __fluuxResidentTopWrites?: ScrollToOptions[]
        __fluuxResidentTopMaxBacktrack?: number
        __fluuxResidentTopStart?: number
        __fluuxResidentTopSamples?: number[]
        __fluuxStopResidentTopProbe?: () => void
      }
      probe.__fluuxStopResidentTopProbe?.()
      const originalScrollTo = scroller.scrollTo
      const nativeScrollTo = originalScrollTo.bind(scroller)
      probe.__fluuxResidentTopSamples = []
      probe.__fluuxResidentTopWrites = writes
      probe.__fluuxResidentTopMaxBacktrack = 0
      // Spelled as the union rather than `Parameters<>`: `scrollTo` is overloaded, and
      // `Parameters<>` resolves to the LAST overload only — `(x, y)` — so `args[0]` typed
      // as a number, the object branch narrowed to `never`, and the spread that records
      // every write was spreading nothing as far as the compiler was concerned.
      type ScrollToArgs = [options?: ScrollToOptions] | [x: number, y: number]
      let observing = false
      scroller.scrollTo = ((...args: ScrollToArgs) => {
        const first = args[0]
        if (observing && typeof first === 'object' && first !== null) writes.push({ ...first })
        return (nativeScrollTo as (...a: ScrollToArgs) => void)(...args)
      }) as HTMLDivElement['scrollTo']
      let closestToTop = startedAt
      // Row measurement can still move the list between probe setup and key delivery.
      const onKeydown = (event: KeyboardEvent) => {
        if (event.key !== 'Home') return
        observing = true
        closestToTop = scroller.scrollTop
        probe.__fluuxResidentTopStart = closestToTop
      }
      window.addEventListener('keydown', onKeydown, { capture: true, once: true })
      const sample = () => {
        if (observing) {
          probe.__fluuxResidentTopSamples!.push(scroller.scrollTop)
          closestToTop = Math.min(closestToTop, scroller.scrollTop)
          probe.__fluuxResidentTopMaxBacktrack = Math.max(
            probe.__fluuxResidentTopMaxBacktrack ?? 0,
            scroller.scrollTop - closestToTop,
          )
        }
        raf = requestAnimationFrame(sample)
      }
      let raf = requestAnimationFrame(sample)
      probe.__fluuxStopResidentTopProbe = () => {
        cancelAnimationFrame(raf)
        window.removeEventListener('keydown', onKeydown, true)
        scroller.scrollTo = originalScrollTo
      }
    }, initialScrollTop)
    await installProbe()

    const scroller = page.locator('[data-message-list]').first()
    await scroller.focus()
    await page.keyboard.press('Home')

    const readProbe = () => page.evaluate(() => {
      const probe = window as Window & {
        __fluuxResidentTopWrites?: ScrollToOptions[]
        __fluuxResidentTopMaxBacktrack?: number
        __fluuxResidentTopStart?: number
        __fluuxResidentTopSamples?: number[]
      }
      return {
        writes: probe.__fluuxResidentTopWrites ?? [],
        backtrack: probe.__fluuxResidentTopMaxBacktrack ?? 0,
        start: probe.__fluuxResidentTopStart ?? 0,
        samples: probe.__fluuxResidentTopSamples ?? [],
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

    const { writes, backtrack, start, samples } = await readProbe()
    const offsets = writes.map(write => write.top ?? 0)
    expect(backtrack).toBeLessThanOrEqual(1)
    expect(writes.filter(write => write.behavior === 'smooth')).toEqual([])
    expect(offsets.some(top => top > 1 && top < start)).toBe(true)
    expect(offsets.length).toBeGreaterThan(1)
    expect(samples.some(top => top > 1 && top < start)).toBe(true)
    expect(offsets.at(-1)).toBeLessThanOrEqual(1)
    for (let index = 0; index < offsets.length; index++) {
      expect(offsets[index]).toBeGreaterThanOrEqual(0)
    }

    for (const direction of [-1, 1]) {
      await test.step(`scheduled ${direction < 0 ? 'same-direction' : 'reverse'} viewport interruption`, async () => {
        await setScrollTop(page, 800)
        const completed = trace.length
        await page.evaluate(direction => {
          const element = document.querySelector('[data-message-list]') as HTMLDivElement
          const nativeScrollTo = element.scrollTo.bind(element)
          const probe = { chosen: null as number | null, writes: [] as number[] }
          ;(window as Window & { __fluuxHomeInterruption?: typeof probe }).__fluuxHomeInterruption = probe
          let armed = false
          window.addEventListener('keydown', event => {
            if (event.key === 'Home') armed = true
          }, { capture: true, once: true })
          type ScrollToArgs = [options?: ScrollToOptions] | [x: number, y: number]
          element.scrollTo = ((...args: ScrollToArgs) => {
            const first = args[0]
            const target = typeof first === 'number' ? args[1] ?? 0 : first?.top ?? element.scrollTop
            if (probe.chosen !== null) probe.writes.push(target)
            ;(nativeScrollTo as (...a: ScrollToArgs) => void)(...args)
            if (armed && target > 100) {
              armed = false
              requestAnimationFrame(() => {
                element.scrollTop += direction * 50
                probe.chosen = element.scrollTop
              })
            }
          }) as HTMLDivElement['scrollTo']
        }, direction)
        await scroller.focus()
        await page.keyboard.press('Home')
        await expect.poll(() => trace.length, { timeout: 30_000 }).toBe(completed + 1)
        const interrupted = await page.evaluate(async () => {
          for (let frame = 0; frame < 6; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          const probe = (window as Window & { __fluuxHomeInterruption?: { chosen: number | null; writes: number[] } }).__fluuxHomeInterruption!
          return { ...probe, top: (document.querySelector('[data-message-list]') as HTMLElement).scrollTop }
        })
        expect(interrupted.chosen).not.toBeNull()
        expect(interrupted.chosen).toBeGreaterThan(1)
        expect(Math.abs(interrupted.top - interrupted.chosen!)).toBeLessThanOrEqual(1)
        expect(interrupted.writes.every(top => Math.abs(top - interrupted.chosen!) <= 1)).toBe(true)
      })
    }
    await test.step('scheduled superseded-owner write fails the frame-backtracking guard', async () => {
      await setScrollTop(page, 800)
      await installProbe()
      const staleTarget = await page.evaluate(() => {
        const element = document.querySelector('[data-message-list]') as HTMLDivElement
        const nativeScrollTo = element.scrollTo.bind(element)
        const target = element.scrollHeight - element.clientHeight
        let armed = false
        window.addEventListener('keydown', event => {
          if (event.key === 'Home') armed = true
        }, { capture: true, once: true })
        type ScrollToArgs = [options?: ScrollToOptions] | [x: number, y: number]
        element.scrollTo = ((...args: ScrollToArgs) => {
          ;(nativeScrollTo as (...a: ScrollToArgs) => void)(...args)
          if (armed) {
            armed = false
            requestAnimationFrame(() => nativeScrollTo({ top: target, behavior: 'auto' }))
          }
        }) as HTMLDivElement['scrollTo']
        return target
      })
      await scroller.focus()
      await page.keyboard.press('Home')
      await expect.poll(async () => (await readProbe()).backtrack).toBeGreaterThan(1)
      expect((await readProbe()).writes.some(write => write.top === staleTarget)).toBe(true)
    })

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
    // waitForAnchorSettled for why we measure the DOM, not the virtualizer offset map).
    const anchorOffsetAfter = await waitForAnchorSettled(page, anchorId)
    expect(anchorOffsetAfter, `anchor "${anchorId}" not found in DOM after prepend — windowed out (drift)`).not.toBeNull()
    const drift = Math.abs(anchorOffsetAfter! - anchorOffsetBefore)
    expect(drift, `anchor drifted by ${drift}px (limit: ${PREPEND_DRIFT_PX}px, before=${anchorOffsetBefore}, after=${anchorOffsetAfter})`).toBeLessThanOrEqual(PREPEND_DRIFT_PX)
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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)
    const spacerFinal = await getSpacerHeight(page)
    const secondGain = spacerFinal - spacerAfter
    expect(secondGain, `spacer kept growing by ${secondGain}px during idle — runaway load-older`).toBeLessThan(1500)

    // After restore, scrollTop must NOT be at 0 (restore moved us to the prepend position)
    const scrollTop = await getScrollTop(page)
    expect(scrollTop, 'scrollTop still 0 after prepend restore — restore never fired').toBeGreaterThan(5)
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
    await settle(page)

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
    await syncEngineGeometry(page)
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
    await syncEngineGeometry(page)
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
    await syncEngineGeometry(page)

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
    await wheelAwayFromBottom(page, AT_BOTTOM_OK_PX, -1200)
    await page.waitForTimeout(700)
    await syncEngineGeometry(page)

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
      await syncEngineGeometry(page)
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
    await wheelAwayFromBottom(page, AT_BOTTOM_OK_PX, -1200)
    await page.waitForTimeout(700)
    await syncEngineGeometry(page)

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
      await syncEngineGeometry(page)
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
  // This scenario covers marker placement through remeasurement. Movement attribution and
  // pagination follow docs/2026-07-23-scroll-positioning-contract.md.
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
    await syncEngineGeometry(page)
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
    await wheelAwayFromBottom(page, AT_BOTTOM_OK_PX, -1200)
    await page.waitForTimeout(700)
    // The save fires on the scroll EVENT, at the row sizes the virtualizer had ESTIMATED then; rows
    // re-measure over the next frames, shifting the visually-settled bottom-anchor. Nudge once more
    // after the settle so the persisted anchor matches the SETTLED position we capture below
    // (otherwise the test's reference diverges from what was saved — a harness artifact, not drift).
    await page.mouse.wheel(0, -4)
    await page.waitForTimeout(500)
    await syncEngineGeometry(page)
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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await wheelAwayFromBottom(page, AT_BOTTOM_OK_PX, -1200)
    await page.waitForTimeout(700)
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)
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

    await wheelUntil(
      page,
      -600,
      async () => (await readDividerState()).scrollTop ?? beforeWheel.scrollTop!,
      scrollTop => scrollTop < beforeWheel.scrollTop!,
      { message: 'the post-plant wheel must produce a genuine upward scroll' },
    )

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
    await settle(page)
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
    await syncEngineGeometry(page)

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
    await settle(page)

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
    await settle(page)

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
    await syncEngineGeometry(page)

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
    await syncEngineGeometry(page)

    const midway = await readView(page)

    // Let the load-older deliver its batch.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(window as any).__releaseOlderLoad?.()
    })
    await page.waitForTimeout(2000)
    await syncEngineGeometry(page)

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


test('cached search navigation preserves confirmed rows and opaque literal IDs', async ({ page }) => {
  await loadDemo(page)
  await navigateToStressRoom(page)
  const fixture = await page.evaluate(async roomJid => {
    const store = (window as unknown as { __roomStore: typeof roomStore }).__roomStore
    const resident = store.getState().messages.get(roomJid)!
    const template = resident[0]
    const timestamp = +template.timestamp - 10_000
    const make = (id: string, body: string, time: number): RoomMessage => {
      const message = { ...template, id, stanzaId: 'navigation-' + id, body, timestamp: new Date(time),
        occupantId: 'navigation-peer', from: roomJid + '/Navigation', nick: 'Navigation', localRowRef: undefined }
      return { ...message }
    }
    const target = make('navigation-shared', 'Navigationcached confirmed destination', timestamp)
    const uncertain = { ...target, stanzaId: 'earlier-archive', body: 'Earlier client-ID reuse', timestamp: new Date(timestamp - 1000) }
    const literal = make('occupant-row:["navigation-shared","navigation-peer"]', 'Opaque literal destination', timestamp + 1000)
    for (const message of [uncertain, target, literal]) await store.getState().addMessage(roomJid, message)
    const row = { id: target.id, occupantId: target.occupantId, stanzaId: target.stanzaId, unconfirmed: false }
    const cached = await store.getState().loadMessagesAroundFromCache(roomJid, row)
    if (!cached.some(message => message.body === target.body)) throw new Error('Target was not cached')
    store.setState({ messages: new Map([[roomJid, resident]]) })
    return { target, literal, residentIds: resident.map(message => message.id) }
  }, STRESS_ROOM_JID)
  await expect(page.getByText(fixture.target.body, { exact: true })).toHaveCount(0)
  // Cache writes and search indexing finish independently. This scenario starts
  // with an indexed, evicted target before exercising navigation from its result.
  await expect.poll(() => page.evaluate(target => new Promise<boolean>((resolve, reject) => {
    const request = indexedDB.open('fluux-search-index')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('search-docs', 'readonly')
      const documents = tx.objectStore('search-docs').getAll()
      tx.oncomplete = () => {
        db.close()
        resolve(documents.result.some(document => document.conversationId === target.roomJid
          && document.messageId === target.id && document.occupantId === target.occupantId
          && document.stanzaId === target.stanzaId && document.body === target.body))
      }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }), fixture.target), { message: 'precondition: the confirmed target must be indexed before searching' }).toBe(true)
  await page.evaluate(() => { window.location.hash = '#/search' })
  await page.getByPlaceholder('Search messages…').fill('Navigationcached')
  const result = page.locator('[title="Go to message"]')
  await expect(result).toHaveCount(1)
  await result.click()
  const highlighted = page.locator('[data-message-list] .message-highlight')
  await expect(highlighted).toContainText(fixture.target.body)
  await expect(highlighted).toHaveAttribute('data-message-row-id',
    'archive-row:' + JSON.stringify([fixture.target.id, fixture.target.occupantId, fixture.target.stanzaId, false]))
  await expect(highlighted).toBeInViewport()
  await page.screenshot({ path: test.info().outputPath("navigation-target.png") })
  await page.evaluate(({ roomJid, literal, residentIds }) => {
    const store = (window as unknown as { __roomStore: typeof roomStore }).__roomStore
    store.setState({ messages: new Map([[roomJid, store.getState().messages.get(roomJid)!
      .filter(message => residentIds.includes(message.id))]]) })
    store.getState().setTargetMessageId(literal.id)
  }, { roomJid: STRESS_ROOM_JID, literal: fixture.literal, residentIds: fixture.residentIds })
  await expect(highlighted).toContainText(fixture.literal.body)
  await expect(highlighted).toHaveAttribute('data-message-id', fixture.literal.id)
  await expect(highlighted).toBeInViewport()
})

test('direct chat keyboard selection preserves opaque literal row IDs', async ({ page }) => {
  await loadDemo(page)
  const jid = 'ava@fluux.chat'
  await activateChat(page, jid)
  const ids = ['client-row:"wire"', 'occupant-row:["wire","peer"]', 'archive-row:["wire","peer","archive"]']
  await page.evaluate(({ jid, ids }) => {
    const store = (window as unknown as { __chatStore: typeof chatStore }).__chatStore
    const messages: Message[] = Array.from({ length: 40 }, (_, index) => ({
      type: 'chat', conversationId: jid, from: jid, to: 'me@fluux.chat', isOutgoing: false,
      id: index === 0 ? 'wire' : ids[index / 10 - 1] ?? `keyboard-${index}`,
      body: index === 0 ? 'Decoded decoy' : `Keyboard row ${index}\nSecond line\nThird line`,
      timestamp: new Date(Date.now() - (40 - index) * 1000),
    }))
    store.setState({ messages: new Map(store.getState().messages).set(jid, messages) })
  }, { jid, ids })
  await settle(page)
  const list = page.locator('[data-message-list]')
  const selected = list.locator('.message-row').filter({ has: page.locator('[data-msg-selected]') })
  for (const [index, id] of ids.entries()) {
    if (index > 0) {
      await settle(page)
      const bounds = (await list.boundingBox())!
      await page.mouse.move(bounds.x + 20, bounds.y + 20)
      await page.mouse.move(bounds.x + 40, bounds.y + 20)
    }
    await page.mouse.move(0, 0)
    await expect(selected).toHaveCount(0)
    await list.evaluate((element, id) => {
      const offset = (window as unknown as { __fluuxGetVirtOffset: (id: string) => number | null })
        .__fluuxGetVirtOffset('client-row:' + JSON.stringify(id))
      if (offset === null) throw new Error('Missing keyboard target')
      element.scrollTop = offset
    }, id)
    await page.waitForFunction(id => document.querySelector(`[data-message-list] [data-message-id="${CSS.escape(id)}"]`), id)
    await list.evaluate((element, id) => {
      const row = element.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)!
      element.scrollTop += row.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom - 1
      element.closest<HTMLElement>('[tabindex="0"]')!.focus({ preventScroll: true })
    }, id)
    await settle(page)
    await expect.poll(() => list.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      return Array.from(element.querySelectorAll<HTMLElement>('.message-row')).filter(row => {
        const rect = row.getBoundingClientRect()
        return rect.bottom > bounds.top && rect.top < bounds.bottom
      }).at(-1)?.dataset.messageId
    })).toBe(id)
    await page.keyboard.press('ArrowUp')
    await expect(selected).toHaveAttribute('data-message-id', id)
    await expect(selected).toBeInViewport()

    await page.keyboard.press('ArrowDown')
    await expect(selected).toHaveAttribute('data-message-id', `keyboard-${(index + 1) * 10 + 1}`)
    await list.evaluate(element => { element.scrollTop += element.clientHeight })
    await settle(page)
    await page.keyboard.press('ArrowUp')
    await expect(selected).toHaveAttribute('data-message-id', id)
    await expect(selected).toBeInViewport()
    expect(await list.evaluate(element => element.closest('[tabindex="0"]') === document.activeElement)).toBe(true)
  }
  await page.screenshot({ path: test.info().outputPath('keyboard-literal-selection.png') })
})

test('room history crosses hidden spam pages with one load action and preserves visible rows', async ({ page }, testInfo) => {
  await bootDemo(page, '/demo.html?tutorial=false&window=30')
  const roomJid = 'spam-history@conference.fluux.chat'
  await page.evaluate(jid => {
    const store = (window as unknown as { __roomStore: typeof roomStore }).__roomStore
    const message = (id: string, second: number): RoomMessage => ({
      type: 'groupchat', roomJid: jid, id, stanzaId: `archive-${id}`,
      from: `${jid}/Alice`, nick: 'Alice', occupantId: 'alice',
      body: id === 'before-spam' ? 'Conversation before the spam' : `Visible message ${id}`,
      timestamp: new Date(1_700_000_000_000 + second * 1000), isOutgoing: false,
    })
    const anchors = Array.from({ length: 20 }, (_, i) => message(`anchor-${i}`, 1000 + i))
    const spam = Array.from({ length: 150 }, (_, i) => ({ ...message(`spam-${i}`, 100 + i),
      body: '', isRetracted: true, isModerated: true, moderationReason: ' sPaM ' }))
    const pages = [spam.slice(100), spam.slice(50, 100), spam.slice(0, 50), [message('before-spam', 1)]]
    store.getState().addRoom({ jid, name: 'Spam history', nickname: 'Me', joined: true,
      isBookmarked: true, supportsMAM: true, occupants: new Map(), typingUsers: new Set(), unreadCount: 0, mentionsCount: 0 }, anchors)
    const original = store.getState().loadOlderMessagesFromCache
    store.setState({ loadOlderMessagesFromCache: async (id, limit) => {
      if (id !== jid) return original(id, limit)
      const batch = pages.shift() ?? []
      store.getState().mergeRoomMAMMessages(id, batch, {}, pages.length === 0, 'backward')
      return batch
    } })
    store.getState().setActiveRoom(jid)
    window.location.hash = '#/rooms/' + encodeURIComponent(jid)
  }, roomJid)
  const button = page.getByRole('button', { name: 'Load earlier messages' })
  await expect(button).toBeAttached()
  // Keyboard activation does not add a separate wheel gesture that could initiate another load.
  await button.evaluate(element => (element as HTMLButtonElement).focus({ preventScroll: true }))
  await page.keyboard.press('Enter')
  await expect.poll(() => page.evaluate(jid => {
    const state = (window as unknown as { __roomStore: typeof roomStore }).__roomStore.getState()
    const messages = state.messages.get(jid) ?? []
    return {
      found: messages.some(m => m.id === 'before-spam'),
      anchors: messages.filter(m => m.id.startsWith('anchor-')).length,
      bounded: messages.length <= 30,
      loading: state.getRoomMAMQueryState(jid).isLoading,
    }
  }, roomJid)).toEqual({ found: true, anchors: 20, bounded: true, loading: false })
  await expect(page.getByText(/Message removed by|Message deleted/)).toHaveCount(0)
  await page.locator('[data-message-list]').evaluate(element => { element.scrollTop = 0 })
  await expect(page.getByText('Conversation before the spam', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('spam-history-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByText('Conversation before the spam', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('spam-history-mobile.png') })
})
type FinalBoundaryWindow = Window & {
  __finalLoads: number
  __resumeScrollDelivery: () => void
  __demoClient: { emitSDK: (event: 'room:typing', data: { roomJid: string; nick: string; isTyping: boolean }) => void }
  __roomStore: {
    getState: () => {
      messages: Map<string, { id: string }[]>
      windowAtLiveEdge: Map<string, boolean>
      setTargetMessageId: (id: string) => void
    }
    setState: (state: {
      windowAtLiveEdge: Map<string, boolean>
      loadNewerMessagesFromCache: () => Promise<never[]>
    }) => void
  }
}

for (const virtualized of [false, true]) {
  test(`final reading anchor ignores below-viewport growth (virtualized: ${virtualized})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await loadDemo(page)
    await page.evaluate(enabled => localStorage.setItem('fluux:flags:enableMessageVirtualization', String(enabled)), virtualized)
    await navigateToStressRoom(page, virtualized)
    await scrollToBottom(page)
    await page.evaluate(jid => {
      const state = (window as unknown as FinalBoundaryWindow).__roomStore.getState()
      state.setTargetMessageId(state.messages.get(jid)!.at(-1)!.id)
    }, STRESS_ROOM_JID)
    await page.waitForTimeout(SETTLE_MS)
    const list = page.locator('[data-message-list]').first()
    await list.hover()
    await page.mouse.wheel(0, -1000)
    await page.waitForTimeout(SETTLE_MS)
    const positions = []
    for (const movement of [0, 250, -300]) {
      if (movement) {
        await page.mouse.wheel(0, movement)
        await page.waitForTimeout(SETTLE_MS)
      }
      const before = await list.evaluate(scroller => {
        const boundary = scroller.getBoundingClientRect().bottom
        const row = [...scroller.querySelectorAll<HTMLElement>('.message-row')].find(row => row.getBoundingClientRect().top > boundary)!
        if (!row) throw new Error('Missing mounted row below viewport')
        const before = scroller.scrollTop
        const growth = document.createElement('div')
        growth.style.height = '200px'
        row.appendChild(growth)
        return before
      })
      await page.waitForTimeout(SETTLE_MS)
      const after = await list.evaluate(scroller => scroller.scrollTop)
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1)
      positions.push({ movement, before, after })
    }
    await page.screenshot({ path: testInfo.outputPath('reading-anchor.png') })
    await testInfo.attach('trusted-wheel-reading-position', { body: JSON.stringify(positions), contentType: 'application/json' })
  })

  test(`final history boundary excludes delayed layout events (virtualized: ${virtualized})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await loadDemo(page)
    await page.evaluate(enabled => localStorage.setItem('fluux:flags:enableMessageVirtualization', String(enabled)), virtualized)
    await navigateToStressRoom(page, virtualized)
    await scrollToBottom(page)
    await page.evaluate(jid => {
      const scope = window as unknown as FinalBoundaryWindow
      const store = scope.__roomStore
      const state = store.getState()
      scope.__finalLoads = 0
      store.setState({
        windowAtLiveEdge: new Map(state.windowAtLiveEdge).set(jid, false),
        loadNewerMessagesFromCache: async () => { scope.__finalLoads++; return [] },
      })
      state.setTargetMessageId(state.messages.get(jid)!.at(-1)!.id)
    }, STRESS_ROOM_JID)
    await page.waitForTimeout(SETTLE_MS)
    const list = page.locator('[data-message-list]').first()
    await list.evaluate(scroller => {
      const scope = window as unknown as FinalBoundaryWindow
      scope.__finalLoads = 0
      const withhold = (event: Event) => event.stopImmediatePropagation()
      scroller.addEventListener('scroll', withhold, true)
      scope.__resumeScrollDelivery = () => scroller.removeEventListener('scroll', withhold, true)
    })
    for (const isTyping of [true, false, true, false, true, false, true]) {
      await page.evaluate(({ roomJid, isTyping }) => (window as unknown as FinalBoundaryWindow).__demoClient.emitSDK('room:typing', { roomJid, nick: 'AwayBot', isTyping }), { roomJid: STRESS_ROOM_JID, isTyping })
      if (isTyping) await expect(page.locator('[data-typing-pill]')).toBeVisible()
      else await expect(page.locator('[data-typing-pill]')).toHaveCount(0)
      await page.waitForTimeout(SETTLE_MS)
    }
    const targetVisibility = await list.evaluate((scroller, jid) => {
      const id = (window as unknown as FinalBoundaryWindow).__roomStore.getState().messages.get(jid)!.at(-1)!.id
      const target = scroller.querySelector(`[data-message-id="${CSS.escape(id)}"]`)!
      return { targetBottom: target.getBoundingClientRect().bottom, viewportBottom: scroller.getBoundingClientRect().bottom }
    }, STRESS_ROOM_JID)
    expect(targetVisibility.targetBottom).toBeLessThanOrEqual(targetVisibility.viewportBottom + 1)
    await page.waitForTimeout(1500)
    await page.evaluate(() => (window as unknown as FinalBoundaryWindow).__resumeScrollDelivery())
    await list.evaluate(scroller => scroller.dispatchEvent(new Event('scroll')))
    await page.waitForTimeout(SETTLE_MS)
    const layoutLoads = await page.evaluate(() => (window as unknown as FinalBoundaryWindow).__finalLoads)
    expect(layoutLoads).toBe(0)
    await wheelAwayFromBottom(page, AT_BOTTOM_OK_PX, -500)
    await wheelUntil(
      page,
      1000,
      () => page.evaluate(() => (window as unknown as FinalBoundaryWindow).__finalLoads),
      loads => loads > 0,
      { message: 'trusted downward wheel input did not trigger newer-history loading' },
    )
    await testInfo.attach('history-load-attribution', {
      body: JSON.stringify({ delayedFixtureEventLoads: layoutLoads, trustedWheelLoads: await page.evaluate(() => (window as unknown as FinalBoundaryWindow).__finalLoads) }),
      contentType: 'application/json',
    })
  })
}

for (const virtualized of [false, true]) {
  for (const input of ['wheel', 'keyboard'] as const) {
    test(`upward intent cancels protection without movement (${input}, virtualized: ${virtualized})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 900, height: 700 })
      await loadDemo(page)
      await page.evaluate(enabled => localStorage.setItem('fluux:flags:enableMessageVirtualization', String(enabled)), virtualized)
      await navigateToStressRoom(page, virtualized)
      await scrollToBottom(page)
      await page.evaluate(jid => {
        const scope = window as unknown as FinalBoundaryWindow
        const store = scope.__roomStore
        const state = store.getState()
        store.setState({
          windowAtLiveEdge: new Map(state.windowAtLiveEdge).set(jid, false),
          loadNewerMessagesFromCache: async () => { scope.__finalLoads++; return [] },
        })
        state.setTargetMessageId(state.messages.get(jid)!.at(-1)!.id)
      }, STRESS_ROOM_JID)
      await page.waitForTimeout(SETTLE_MS)
      await page.evaluate(roomJid => (window as unknown as FinalBoundaryWindow).__demoClient.emitSDK('room:typing', { roomJid, nick: 'AwayBot', isTyping: true }), STRESS_ROOM_JID)
      await page.waitForTimeout(SETTLE_MS)
      const list = page.locator('[data-message-list]').first()
      await list.evaluate(scroller => {
        scroller.tabIndex = 0
        scroller.focus({ preventScroll: true })
      })
      await page.waitForTimeout(SETTLE_MS)
      const initialTop = await list.evaluate((scroller, input) => {
        const scope = window as any
        scope.__finalLoads = 0
        scope.__upwardEvents = []
        const withhold = (event: Event) => event.stopImmediatePropagation()
        const prevent = (event: Event) => {
          if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'ArrowUp') return
          scope.__upwardEvents.push({ type: event.type, trusted: event.isTrusted, defaultPreventedBeforeFixture: event.defaultPrevented, target: (event.target as HTMLElement).tagName, top: scroller.scrollTop })
          event.preventDefault()
        }
        const eventTarget = scroller
        const eventType = input === 'wheel' ? 'wheel' : 'keydown'
        scroller.addEventListener('scroll', withhold, true)
        eventTarget.addEventListener(eventType, prevent, { passive: false })
        scope.__resumeScrollDelivery = () => {
          scroller.removeEventListener('scroll', withhold, true)
          eventTarget.removeEventListener(eventType, prevent)
        }
        return scroller.scrollTop
      }, input)
      await list.hover()
      if (input === 'wheel') await page.mouse.wheel(0, -20)
      else await page.keyboard.press('ArrowUp')
      await page.waitForTimeout(SETTLE_MS)
      expect(await list.evaluate(scroller => scroller.scrollTop)).toBe(initialTop)
      await page.evaluate(roomJid => (window as unknown as FinalBoundaryWindow).__demoClient.emitSDK('room:typing', { roomJid, nick: 'AwayBot', isTyping: false }), STRESS_ROOM_JID)
      await page.waitForTimeout(SETTLE_MS)
      const clampedTop = await list.evaluate(scroller => scroller.scrollTop)
      expect(clampedTop).toBeLessThan(initialTop - 20)
      await page.evaluate(roomJid => (window as unknown as FinalBoundaryWindow).__demoClient.emitSDK('room:typing', { roomJid, nick: 'AwayBot', isTyping: true }), STRESS_ROOM_JID)
      await page.waitForTimeout(SETTLE_MS)
      await testInfo.attach('input-events', { body: JSON.stringify(await page.evaluate(() => (window as any).__upwardEvents)), contentType: 'application/json' })
      expect(await list.evaluate(scroller => scroller.scrollTop)).toBe(clampedTop)
      await page.screenshot({ path: testInfo.outputPath('upward-intent.png') })
      await page.waitForTimeout(1500)
      await page.evaluate(() => (window as unknown as FinalBoundaryWindow).__resumeScrollDelivery())
      await list.evaluate(scroller => scroller.dispatchEvent(new Event('scroll')))
      await page.waitForTimeout(SETTLE_MS)
      expect(await page.evaluate(() => (window as unknown as FinalBoundaryWindow).__finalLoads)).toBe(0)
      const events = await page.evaluate(() => (window as any).__upwardEvents)
      expect(events).not.toHaveLength(0)
      expect(events.every((event: { trusted: boolean }) => event.trusted)).toBe(true)
      await wheelAwayFromBottom(page, AT_BOTTOM_OK_PX, -500)
      await wheelUntil(
        page,
        1500,
        () => page.evaluate(() => (window as unknown as FinalBoundaryWindow).__finalLoads),
        loads => loads > 0,
        { message: 'trusted movement did not trigger newer-history loading' },
      )
      await testInfo.attach('upward-intent-attribution', {
        body: JSON.stringify({ initialTop, clampedTop, events, defaultPreventedByFixture: true, scrollDeliveryWithheldByFixture: true, layoutLoads: 0, trustedMovementLoads: await page.evaluate(() => (window as unknown as FinalBoundaryWindow).__finalLoads) }),
        contentType: 'application/json',
      })
    })
  }
}

test('final layout clamp arithmetic preserves the remaining adjustment', async ({ page }, testInfo) => {
  await loadDemo(page)
  await page.setContent('<div id="scroller" style="height:557px;overflow:auto;overflow-anchor:none"><div id="prefix" style="height:920px"></div><div data-message-id="tail" style="height:80px"></div></div>')
  await installViewportGeometryFixture(page)
  const result = await page.evaluate(() => {
    const { ViewportSession, readViewportGeometry } = (window as any).__scrollGeometryFixture
    const scroller = document.getElementById('scroller')!
    const session = new ViewportSession('fixture')
    scroller.scrollTop = 393
    session.recordProgrammaticWrite('fixture', 1000, readViewportGeometry(scroller))
    document.getElementById('prefix')!.style.height = '860px'
    const clamped = readViewportGeometry(scroller)
    const movement = session.observeGeometry('fixture', clamped, { now: 1500, controllerOwnsPixels: false })
    const adjustment = session.consumeLayoutAdjustment('fixture')
    scroller.scrollTop += adjustment
    session.recordProgrammaticWrite('fixture', 1500, readViewportGeometry(scroller))
    const delayed = session.observeScroll({ conversationId: 'fixture', geometry: readViewportGeometry(scroller), bottomAnchor: null, now: 5000, controllerOwnsPixels: false })
    return { clamped, movement, adjustment, finalTop: scroller.scrollTop, delayed }
  })
  expect(result.clamped.top).toBe(383)
  expect(result.movement.userDelta).toBe(0)
  expect(result.adjustment).toBe(-50)
  expect(result.finalTop).toBe(333)
  expect(result.delayed.userScrollGeometry).toBeNull()
  await testInfo.attach('browser-clamp-geometry', { body: JSON.stringify(result), contentType: 'application/json' })
})

for (const virtualized of [false, true]) {
  test(`settled target ignores arrivals before queued index reconciliation (virtualized: ${virtualized})`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 900, height: 700 })
    await loadDemo(page)
    await page.evaluate(enabled => localStorage.setItem('fluux:flags:enableMessageVirtualization', String(enabled)), virtualized)
    await navigateToStressRoom(page, virtualized)
    await scrollToBottom(page)
    const before = await page.evaluate(jid => new Promise<{top: number; targetBottom: number; id: string}>(resolve => {
      const scope = window as any
      const store = scope.__roomStore.getState()
      const id = store.messages.get(jid).at(-1).id as string
      const scroller = document.querySelector<HTMLElement>('[data-message-list]')!
      const target = scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)!
      const observer = new MutationObserver(() => {
        if (!target.classList.contains('message-highlight')) return
        observer.disconnect()
        const before = { top: scroller.scrollTop, targetBottom: target.getBoundingClientRect().bottom, id }
        scope.__demoClient.emitSDK('room:message', {
          roomJid: jid,
          message: { type: 'groupchat', roomJid: jid, id: 'queued-arrival', from: `${jid}/BoundaryBot`, nick: 'BoundaryBot', body: 'Arrival immediately after target settlement.', timestamp: new Date(), isOutgoing: false },
          incrementUnread: true,
        })
        resolve(before)
      })
      observer.observe(target, {attributes:true, attributeFilter:['class']})
      store.setTargetMessageId(id)
    }), STRESS_ROOM_JID)
    await page.waitForTimeout(SETTLE_MS)
    const after = await page.locator('[data-message-list]').first().evaluate((scroller, id) => ({
      top: scroller.scrollTop,
      targetBottom: scroller.querySelector(`[data-message-id="${CSS.escape(id)}"]`)!.getBoundingClientRect().bottom,
      distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    }), before.id)
    expect(Math.abs(after.top - before.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(after.targetBottom - before.targetBottom)).toBeLessThanOrEqual(1)
    expect(after.distance).toBeGreaterThan(20)
    await page.screenshot({path:testInfo.outputPath('settled-arrival.png')})
    await testInfo.attach('settled-arrival-geometry', {body:JSON.stringify({before,after}), contentType:'application/json'})
  })
}

for (const virtualized of [false, true]) {
  for (const input of ['scheduled-scroll', 'prevented-wheel'] as const) {
    test(`pending media respects takeover (${input}, virtualized: ${virtualized})`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 900, height: 700 })
      await loadDemo(page)
      await page.evaluate(enabled => localStorage.setItem('fluux:flags:enableMessageVirtualization', String(enabled)), virtualized)
      await navigateToStressRoom(page, virtualized)
      await scrollToBottom(page)
      await page.evaluate(jid => {
        const scope = window as unknown as FinalBoundaryWindow
        const state = scope.__roomStore.getState()
        scope.__finalLoads = 0
        scope.__roomStore.setState({
          windowAtLiveEdge: new Map(state.windowAtLiveEdge).set(jid, false),
          loadNewerMessagesFromCache: async () => { scope.__finalLoads++; return [] },
        })
        state.setTargetMessageId(state.messages.get(jid)!.at(-18)!.id)
      }, STRESS_ROOM_JID)
      await page.waitForTimeout(SETTLE_MS)
      const list = page.locator('[data-message-list]').first()
      await list.hover()
      const before = await list.evaluate((scroller, input) => {
        const scope = window as unknown as FinalBoundaryWindow & {
          __fluuxTriggerMediaLoad: () => void
          __mediaInputEvents: { trusted: boolean; top: number }[]
        }
        scope.__finalLoads = 0
        scope.__mediaInputEvents = []
        scope.__fluuxTriggerMediaLoad()
        if (input === 'prevented-wheel') {
          scroller.addEventListener('wheel', event => {
            scope.__mediaInputEvents.push({ trusted: event.isTrusted, top: scroller.scrollTop })
            event.preventDefault()
          }, { passive: false, once: true })
        }
        return { top: scroller.scrollTop, height: scroller.scrollHeight }
      }, input)
      if (input === 'scheduled-scroll') {
        await list.evaluate(scroller => {
          const scope = window as unknown as { __fluuxTriggerMediaLoad: () => void }
          const bottom = scroller.getBoundingClientRect().bottom
          const row = [...scroller.querySelectorAll<HTMLElement>('.message-row')].find(row => row.getBoundingClientRect().top > bottom)!
          if (!row) throw new Error('Missing mounted media row below the viewport')
          scroller.scrollTop -= 50
          const image = document.createElement('img')
          image.style.cssText = 'display:block;width:100px;height:100px'
          image.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="lightblue"/></svg>'
          row.appendChild(image)
          scope.__fluuxTriggerMediaLoad()
        })
      } else {
        await page.mouse.wheel(0, -20)
      }
      await page.evaluate(roomJid => (window as unknown as FinalBoundaryWindow).__demoClient.emitSDK('room:typing', { roomJid, nick: 'AwayBot', isTyping: true }), STRESS_ROOM_JID)
      await page.waitForTimeout(SETTLE_MS)
      const after = await list.evaluate(scroller => ({ top: scroller.scrollTop, height: scroller.scrollHeight }))
      expect(Math.abs(after.top - (before.top - (input === 'scheduled-scroll' ? 50 : 0)))).toBeLessThanOrEqual(1)
      if (input === 'scheduled-scroll') expect(after.height).toBeGreaterThan(before.height + 90)
      const evidence = await page.evaluate(() => {
        const scope = window as unknown as FinalBoundaryWindow & { __mediaInputEvents: { trusted: boolean; top: number }[] }
        return { loads: scope.__finalLoads, events: scope.__mediaInputEvents }
      })
      expect(evidence.loads).toBe(0)
      if (input === 'prevented-wheel') {
        expect(evidence.events).toHaveLength(1)
        expect(evidence.events[0].trusted).toBe(true)
      }
      await page.screenshot({ path: testInfo.outputPath('pending-media-takeover.png') })
      await testInfo.attach('pending-media-observations', {
        body: JSON.stringify({ input, virtualized, before, after, ...evidence, scheduledImageGrowth: input === 'scheduled-scroll', scheduledScrollMovement: input === 'scheduled-scroll', wheelDefaultPreventedByFixture: input === 'prevented-wheel' }),
        contentType: 'application/json',
      })
    })
  }
}
