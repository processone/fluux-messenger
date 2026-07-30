import { expect, test, type Page } from '@playwright/test'

const DEMO_ROOM_JID = 'team@conference.fluux.chat'

/**
 * Open a room in demo mode.
 *
 * Activated through the store before the hash flips, mirroring the scroll suite: the
 * rooms sidebar auto-selects, and a click races that. Waiting for a mounted row is
 * what proves the list is live, which the sampler needs.
 */
async function openDemoRoom(page: Page): Promise<void> {
  await page.evaluate(
    (jid) =>
      (window as unknown as { __roomStore?: { getState(): { activateRoom(j: string): unknown } } })
        .__roomStore?.getState()
        .activateRoom(jid),
    DEMO_ROOM_JID,
  )
  await page.waitForFunction(
    (jid) =>
      (window as unknown as { __roomStore?: { getState(): { activeRoomJid?: string } } })
        .__roomStore?.getState().activeRoomJid === jid,
    DEMO_ROOM_JID,
    { timeout: 15_000 },
  )
  await page.evaluate((jid) => {
    window.location.hash = '#/rooms/' + encodeURIComponent(jid)
  }, DEMO_ROOM_JID)
  await page.waitForSelector('[data-index], .message-row', { timeout: 15_000 })
}

/**
 * The bundle checks prove the anomaly code is PRESENT in a Dev build. They cannot
 * prove it RUNS — a module that ships but never installs would satisfy both of
 * them. This is the only gate that exercises the runtime end to end.
 *
 * Chromium only, deliberately: the assertions read a JavaScript global and are
 * engine-independent, so a second engine would double the cost for no signal. The
 * scroll and composer suites run on both because they measure layout, which is
 * exactly where the engines differ.
 */
test.describe('anomaly runtime', () => {
  test('the Dev build emits exactly one session-start record', async ({ page }) => {
    await page.goto('/demo.html?tutorial=false')

    // The record is written only after the tokenizer resolves its key, so poll
    // rather than sampling once.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const lines = (window as unknown as { __fluuxAnomalies?: string[] })
              .__fluuxAnomalies
            if (!lines) return null
            return lines
              .map((l) => JSON.parse(l) as { id?: string })
              .filter((r) => r.id === 'recorder/session-start').length
          }),
        {
          timeout: 30_000,
          message: 'the anomaly runtime never wrote its session record',
        },
      )
      .toBe(1)

    const record = await page.evaluate(
      () =>
        (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((r) => r.id === 'recorder/session-start')!,
    )

    // `tokenKeyId` is the correlation boundary: "unknown" means the record was
    // written before the tokenizer was ready and cannot be attributed to a token
    // space, which is the failure the readiness gate exists to prevent.
    expect(record.tokenKeyId).toMatch(/^[0-9a-f]{8}$/)
    expect(record.sid).toBeTruthy()
    expect(record.v).toBe(1)
    expect(record.sev).toBe('drift')

    // The runtime sentinel — the same string the bundle grep looks for. Present
    // here proves the marker is reachable at runtime, not merely compiled in.
    const sentinel = await page.evaluate(
      () => (window as unknown as Record<string, unknown>).__fluuxAnomalyBuild,
    )
    expect(sentinel).toBe('fluux-anomaly-instrumentation-present')
  })

  test('React StrictMode produces neither a duplicate record nor a phantom suppression', async ({
    page,
  }) => {
    // The demo tree mounts under StrictMode, so every effect runs
    // install → cleanup → install. A per-attachment announcement would emit twice,
    // and the per-id cooldown would swallow the second RECORD — leaving the count
    // at one while `suppressed` gained an entry. Counting records alone therefore
    // cannot see this regression; the digest has to be inspected, which means
    // forcing a flush.
    await page.goto('/demo.html?tutorial=false')

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              ((window as unknown as { __fluuxAnomalies?: string[] }).__fluuxAnomalies ?? [])
                .length,
          ),
        { message: 'the anomaly runtime never wrote its session record' },
      )
      .toBeGreaterThan(0)

    // Drive the visibility flush the installer listens for. Playwright has no API
    // for the visibility state, so override the property the handler reads.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    const summary = await page.evaluate(() => {
      const w = window as unknown as { __fluuxAnomalies: string[] }
      const records = w.__fluuxAnomalies.map((l) => JSON.parse(l) as Record<string, never>)
      const digest = records.filter((r) => r.kind === 'digest').pop()
      return {
        starts: records.filter((r) => r.id === 'recorder/session-start').length,
        ceilings: records.filter((r) => r.id === 'recorder/ceiling-reached').length,
        digestSeen: digest !== undefined,
        suppressedSessionStart: digest
          ? (digest.suppressed as Record<string, number>)['recorder/session-start']
          : 'no-digest',
        rejected: digest
          ? (digest.counters as Record<string, number>)['recorder/rejected-value']
          : -1,
      }
    })

    // Guard the guard: without a digest the two assertions below prove nothing.
    expect(summary.digestSeen).toBe(true)
    expect(summary.suppressedSessionStart).toBeUndefined()
    expect(summary.starts).toBe(1)
    // A ceiling in a freshly loaded demo would mean the budget accounting is wrong.
    expect(summary.ceilings).toBe(0)
    expect(summary.rejected).toBe(0)
  })

  test('a healthy demo session trips none of the detectors', async ({ page }) => {
    // The system-level CONTROL. Every detector has unit tests proving it stays quiet
    // on synthetic healthy input, but only a real browser proves the SAMPLING is
    // healthy too — that the world it reads is the world it thinks it reads. A
    // detector wired to a wrong reading fires on a working app, and by the design's
    // own rule would then be deleted rather than fixed.
    await page.goto('/demo.html?tutorial=false')

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              ((window as unknown as { __fluuxAnomalies?: string[] }).__fluuxAnomalies ?? [])
                .length,
          ),
        { message: 'the anomaly runtime never installed' },
      )
      .toBeGreaterThan(0)

    // Open a room so the sampler has something to look at.
    await openDemoRoom(page)

    // Let the list settle at the live edge FIRST. The mark-read below is gated on the
    // viewport actually being at the bottom, so firing it mid-settle is skipped.
    await page.waitForTimeout(2000)

    // Then drive a real blur → focus transition. This is not test decoration: the app
    // marks the active view read on the focus TRANSITION
    // (`useWindowVisibility.ts`, gated on the viewport being at the bottom), and a
    // headless page starts already focused, so that transition never happens on its
    // own. Without it the demo sits on a permanently unread room and
    // unread-survives-focus reports correctly on a state no real user would be in.
    // `handleFocusChange` reads `document.hasFocus()` rather than the event type, so a
    // bare synthetic blur changes nothing — the transition has to be driven through
    // that reading.
    await page.evaluate(() => {
      const real = document.hasFocus.bind(document)
      Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true })
      window.dispatchEvent(new Event('blur'))
      Object.defineProperty(document, 'hasFocus', { value: real, configurable: true })
      window.dispatchEvent(new Event('focus'))
    })

    // Prove the mark-read actually landed. Otherwise a future change to that gate
    // would turn this control test into an assertion that nothing was watching.
    await expect
      .poll(
        async () =>
          page.evaluate(
            (jid) =>
              (
                window as unknown as {
                  __roomStore: { getState(): { roomMeta: Map<string, { unreadCount: number }> } }
                }
              ).__roomStore.getState().roomMeta.get(jid)?.unreadCount,
            DEMO_ROOM_JID,
          ),
        {
          timeout: 10_000,
          message: 'focus regain did not clear the room unread count — the control is unsound',
        },
      )
      .toBe(0)

    // Sit longer than the longest hold window (2s for unread-survives-focus).
    await page.waitForTimeout(4000)

    const detectorRecords = await page.evaluate(() => {
      const ids = new Set([
        'read-state/unread-survives-focus',
        'scroll/fab-at-live-edge',
        'scroll/jump-target-miss',
      ])
      return (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
        .map((l) => JSON.parse(l) as { id?: string })
        .filter((r) => r.id !== undefined && ids.has(r.id))
        .map((r) => r.id)
    })

    expect(
      detectorRecords,
      'a detector fired on a healthy demo session — it is miswired, not finding bugs',
    ).toEqual([])
  })

  test('the sampler is actually running, so the control above means something', async ({
    page,
  }) => {
    // Guard for the guard. "No detector fired" is also what a sampler that never
    // ticks produces, so the previous test passes vacuously unless the loop is
    // proven alive. Forcing a real anomaly is the only way to show it is.
    await page.goto('/demo.html?tutorial=false')

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              ((window as unknown as { __fluuxAnomalies?: string[] }).__fluuxAnomalies ?? [])
                .length,
          ),
        { message: 'the anomaly runtime never installed' },
      )
      .toBeGreaterThan(0)

    await openDemoRoom(page)

    // Let the list reach the live edge, then un-hide the REAL FAB. Its wrapper carries
    // `inert={!fabVisible}`, so clearing that is precisely the stale state the detector
    // is for: the affordance offered while there is nothing to scroll to. Forced
    // rather than provoked because the genuine race needs a WebKit timing window we
    // cannot reproduce on demand.
    await page.waitForTimeout(2000)

    // Strip `inert` and KEEP it stripped. React owns that attribute
    // (`inert={!fabVisible}`), so any re-render — a typing indicator, an animation
    // frame — puts it straight back, and the detector needs the state to hold for a
    // full second. A one-shot removal passed most runs and failed occasionally, which
    // is worse than failing every time.
    await page.evaluate(() => {
      const strip = () => {
        for (const fab of document.querySelectorAll('[data-fab="scroll-to-bottom"]')) {
          fab.closest('[inert]')?.removeAttribute('inert')
        }
      }
      strip()
      new MutationObserver(strip).observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ['inert'],
      })
    })

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
              .map((l) => JSON.parse(l) as { id?: string })
              .some((r) => r.id === 'scroll/fab-at-live-edge'),
          ),
        {
          timeout: 15_000,
          message: 'the detector sampler never fired — the control test above is vacuous',
        },
      )
      .toBe(true)

    const record = await page.evaluate(
      () =>
        (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .find((r) => r.id === 'scroll/fab-at-live-edge')!,
    )
    expect(record.sev).toBe('bug')
    expect(record.expected).toBe(0)
    // The measured distance, proving the reading came from the scroller registry
    // rather than being assumed.
    expect(typeof record.observed).toBe('number')
    expect(record.observed as number).toBeLessThanOrEqual(150)
  })
})
