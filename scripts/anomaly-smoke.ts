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
 * Give the page the focus transitions a headless browser never gets.
 *
 * The app marks the active view read on the focus TRANSITION
 * (`useWindowVisibility.ts`, gated on the viewport being at the bottom), and a headless
 * page starts already focused, so that transition never happens on its own. Without it
 * the demo sits on a permanently unread room and `unread-survives-focus` reports
 * correctly on a state no real user would be in.
 *
 * Driven from INSIDE the page, on a timer armed before the app boots, rather than by an
 * `evaluate` from the test. That is the whole point, not a style choice:
 * `unread-survives-focus` fires when a count outlives 2s of the user looking at the
 * newest message, and its clock starts when the room settles at the live edge — which
 * the demo's sidebar does on its own, while the test is still awaiting `activateRoom`.
 * Every step the test takes between those two moments is a CDP round trip, so a
 * test-driven transition races the detector on exactly the axis that separates a
 * developer's machine from a loaded 2-core runner. This one is one page timer away from
 * the settle no matter how slow the harness is. The original fixed 2s settle wait lost
 * that race in CI (`heldMs: 2753`, then `unread-focus-cleared` a second later — the
 * detector watching a healthy app clear its badge slightly too slowly for the test's own
 * choreography).
 *
 * `handleFocusChange` reads `document.hasFocus()` rather than the event type, so a bare
 * synthetic blur changes nothing — the transition has to be driven through that reading.
 * Both overrides are applied and undone inside one synchronous block, so no detector
 * tick can observe the window as unfocused.
 *
 * Idle while nothing is unread, so a healthy session is left alone: the transition costs
 * two store writes and is skipped entirely unless the active entity actually has a count
 * to clear. Self-re-arming for the same reason — a demo message arriving later is
 * cleared the same way rather than being left to trip the detector mid-test.
 */
async function driveFocusRegainInPage(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Meta {
      unreadCount: number
    }
    const w = window as unknown as {
      __roomStore?: { getState(): { activeRoomJid?: string; roomMeta: Map<string, Meta> } }
      __chatStore?: {
        getState(): { activeConversationId?: string; conversationMeta: Map<string, Meta> }
      }
    }

    const hasUnread = (): boolean => {
      const rooms = w.__roomStore?.getState()
      if (rooms?.activeRoomJid) {
        if ((rooms.roomMeta.get(rooms.activeRoomJid)?.unreadCount ?? 0) > 0) return true
      }
      const chats = w.__chatStore?.getState()
      if (chats?.activeConversationId) {
        if ((chats.conversationMeta.get(chats.activeConversationId)?.unreadCount ?? 0) > 0)
          return true
      }
      return false
    }

    setInterval(() => {
      if (!hasUnread()) return
      const real = document.hasFocus.bind(document)
      Object.defineProperty(document, 'hasFocus', { value: () => false, configurable: true })
      window.dispatchEvent(new Event('blur'))
      Object.defineProperty(document, 'hasFocus', { value: real, configurable: true })
      window.dispatchEvent(new Event('focus'))
    }, 250)
  })
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

    // Armed BEFORE the app boots, because the demo's sidebar auto-selects a room and
    // settles it at the live edge on its own — the detector's clock can start before the
    // test has issued its first command. See the helper for why this cannot be an
    // `evaluate` from here.
    await driveFocusRegainInPage(page)
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

    const outboundApplicationStanzas = await page.evaluate(async () => {
      interface DemoClientLike {
        onApplicationStanzaOut(handler: () => void): () => void
        server: { queryInfo(jid: string): Promise<unknown> }
      }
      const client = (window as unknown as { __demoClient: DemoClientLike }).__demoClient
      let observed = 0
      const off = client.onApplicationStanzaOut(() => {
        observed++
      })
      try {
        await client.server.queryInfo(`anomaly-smoke-${Date.now()}.invalid`)
      } finally {
        off()
      }
      return observed
    })
    expect(
      outboundApplicationStanzas,
      'demo mode emitted no outbound application stanza — the traffic control is vacuous',
    ).toBe(1)

    // Open a room so the sampler has something to look at.
    await openDemoRoom(page)

    // Prove the mark-read actually landed. Otherwise a future change to that gate would
    // turn this control test into an assertion that nothing was watching — and the
    // driver above would be dispatching focus events into a void.
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
        'recorder/entity-warm-failing',
        'read-state/unread-survives-focus',
        'scroll/fab-at-live-edge',
        'scroll/live-edge-pin-short',
        'scroll/jump-target-miss',
        'xmpp-traffic/redundant-query',
        'xmpp-traffic/iq-unanswered',
        'xmpp-traffic/mam-write-failed',
        'read-state/pointer-regression',
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

  test('a sustained entity-warm failure reaches the anomaly log', async ({ page }) => {
    // Entity warming can fail in production only when WebCrypto itself rejects.
    // Override that one operation before the app boots so the real detector,
    // installer, recorder, serializer, and memory sink all remain in the path.
    await page.addInitScript(() => {
      const realSign = crypto.subtle.sign.bind(crypto.subtle)
      Object.defineProperty(window, '__forcedHmacSignCalls', {
        configurable: true,
        value: 0,
        writable: true,
      })
      Object.defineProperty(crypto.subtle, 'sign', {
        configurable: true,
        value(
          algorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams,
          key: CryptoKey,
          data: BufferSource,
        ) {
          const name = typeof algorithm === 'string' ? algorithm : algorithm.name
          if (name === 'HMAC') {
            ;(window as unknown as { __forcedHmacSignCalls: number }).__forcedHmacSignCalls++
            return Promise.reject(new Error('forced HMAC sign failure'))
          }
          return realSign(algorithm, key, data)
        },
      })
    })

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

    await expect
      .poll(
        async () =>
          page.evaluate(
            () =>
              (window as unknown as { __forcedHmacSignCalls: number }).__forcedHmacSignCalls,
          ),
        {
          timeout: 15_000,
          message: 'the browser never attempted three forced HMAC warm failures',
        },
      )
      .toBeGreaterThanOrEqual(3)

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
              .map((line) => JSON.parse(line) as { id?: string })
              .some((record) => record.id === 'recorder/entity-warm-failing'),
          ),
        {
          timeout: 15_000,
          message: 'the sustained warm failure never reached the anomaly log',
        },
      )
      .toBe(true)

    const record = await page.evaluate(
      () =>
        (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((candidate) => candidate.id === 'recorder/entity-warm-failing')!,
    )

    expect(record).toMatchObject({
      kind: 'anomaly',
      id: 'recorder/entity-warm-failing',
      sev: 'suspect',
      expected: 0,
      observed: 3,
      ctx: {},
    })
    expect(record.tokenKeyId).toMatch(/^[0-9a-f]{8}$/)
    expect(record.sid).toBeTruthy()
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

  /**
   * The read-state counterpart to the FAB proof above.
   *
   * `unread-survives-focus` is what the read-state half of stage 3 rests on, and every
   * other test here can only prove it SILENT. Silence is also what a detector wired to
   * a dead reading produces, so the healthy-session control was vacuous for this signal
   * in exactly the way it was for the FAB before the test above existed.
   *
   * It is the READING that needs proving, not the verdict logic —
   * `unreadSurvivesFocus.test.ts` already covers that as a pure function. So four of
   * the five conditions come from the real app and only the count is forced:
   *
   * - `focused` — the page genuinely is
   * - `viewportAtBottom` — `isViewportAtBottom`, a registry the views populate via
   *   `registerViewportBottomRef` and `useMessageListScroll` maintains. That is a
   *   DIFFERENT registry from the scroller one the FAB test exercises, so nothing else
   *   in this suite covers it.
   * - `windowAtLiveEdge` — read from the SDK store
   * - `active` — read from the room store
   *
   * Forcing any of those would make this hollow: it would then pass with every one of
   * those couplings broken. Pinning the count in the STORE rather than in the tick's
   * adapter keeps `readUnreadCount`'s own path — right store, right map, right field —
   * inside the assertion too.
   *
   * `driveFocusRegainInPage` is deliberately NOT installed: it exists to keep a healthy
   * session's badge clear, which is precisely what this test needs to prevent.
   */
  test('a badge stuck at the live edge reaches the anomaly log', async ({ page }) => {
    // Distinctive on purpose, and load-bearing rather than decorative. Without
    // `driveFocusRegainInPage` the demo sits on a room it never marks read, so it trips
    // this detector on its own — confirmed by disabling the pin below, which still
    // produced a record, just with the demo's own count. The poll alone would therefore
    // be satisfiable by ambient state; matching `observed` against a value the demo
    // never reaches is what ties the record to THIS forced episode, and what keeps the
    // test from silently changing meaning when the demo seed data does.
    const PINNED_UNREAD = 7

    await page.addInitScript((pinned) => {
      interface Meta {
        unreadCount: number
      }
      const w = window as unknown as {
        __roomStore?: { getState(): { activeRoomJid?: string; roomMeta: Map<string, Meta> } }
        __pinnedUnreadMetas: number
      }
      Object.defineProperty(window, '__pinnedUnreadMetas', {
        configurable: true,
        writable: true,
        value: 0,
      })

      // An accessor, re-applied whenever the store hands out a new meta OBJECT. Both
      // halves are load-bearing: the app clears the count as soon as the room is read
      // at the bottom, so a plain write is undone well before the 2s hold elapses, and
      // a recount replaces the object outright, so one accessor stops being consulted.
      // The setter SWALLOWS the app's clear rather than rejecting it — assigning to a
      // getter-only property throws in module strict mode, which would take the app
      // down instead of the badge.
      let pinnedMeta: Meta | null = null
      setInterval(() => {
        const state = w.__roomStore?.getState()
        const jid = state?.activeRoomJid
        if (!jid) return
        const meta = state.roomMeta.get(jid)
        if (!meta || meta === pinnedMeta) return
        try {
          Object.defineProperty(meta, 'unreadCount', {
            configurable: true,
            get: () => pinned,
            set: () => {},
          })
          pinnedMeta = meta
          w.__pinnedUnreadMetas++
        } catch {
          // A frozen meta cannot be pinned. The count assertion below reports that as
          // itself rather than letting it read as a blind detector.
        }
      }, 25)
    }, PINNED_UNREAD)

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

    // Prove the forcing took BEFORE asserting its consequence, so a failure separates
    // "the pin never applied" from "the detector never saw it".
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => (window as unknown as { __pinnedUnreadMetas: number }).__pinnedUnreadMetas,
          ),
        {
          timeout: 15_000,
          message: 'the unread count was never pinned — the active room had no meta, or it was frozen',
        },
      )
      .toBeGreaterThan(0)

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
              .map((line) => JSON.parse(line) as { id?: string })
              .some((record) => record.id === 'read-state/unread-survives-focus'),
          ),
        {
          timeout: 20_000,
          message:
            'a badge held at the live edge never reached the anomaly log — the read-state sampler is blind',
        },
      )
      .toBe(true)

    const record = await page.evaluate(
      () =>
        (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((candidate) => candidate.id === 'read-state/unread-survives-focus')!,
    )

    expect(record).toMatchObject({
      kind: 'anomaly',
      id: 'read-state/unread-survives-focus',
      sev: 'suspect',
      expected: 0,
      observed: PINNED_UNREAD,
    })

    const ctx = record.ctx as { room?: string; heldMs?: number }
    // A RESOLVED room token, never `c:unresolved`: the entity was warmed in the room
    // namespace, so the record can be correlated rather than merely counted.
    expect(ctx.room).toMatch(/^c:[0-9a-f]{16}$/)
    // Past the 2s hold by construction. Proves the verdict came from a sustained
    // observation rather than a single lucky sample.
    expect(ctx.heldMs).toBeGreaterThanOrEqual(2000)
    expect(record.tokenKeyId).toMatch(/^[0-9a-f]{8}$/)
  })

  /**
   * The rates, end to end, in a real browser.
   *
   * Every layer below this has its own unit test, and all of them would still pass
   * if the render counter never fired: the seam is a null check when nothing
   * registers, and a digest with no rates is a legal digest. Only a real render
   * reaching a real digest proves the chain — component body, neutral seam, handler,
   * registry constant, recorder, serializer — is actually connected.
   */
  test('a real render reaches the digest as a rate', async ({ page }) => {
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

    // Digests are on a five-minute timer, which no test can wait for. Hiding the
    // document flushes one — the same path a real session takes when it is
    // backgrounded, so this exercises production behaviour rather than a test hook.
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        value: 'hidden',
        configurable: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
    })

    await expect
      .poll(
        async () =>
          page.evaluate(() =>
            (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
              .map((line) => JSON.parse(line) as { kind?: string })
              .some((record) => record.kind === 'digest'),
          ),
        { timeout: 15_000, message: 'hiding the document flushed no digest' },
      )
      .toBe(true)

    const digest = await page.evaluate(
      () =>
        (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
          .map((line) => JSON.parse(line) as Record<string, unknown>)
          .find((record) => record.kind === 'digest')!,
    )

    // Opening a room renders the list, so the numerator cannot legitimately be zero,
    // and activating one IS the denominator — a switch.
    const rates = digest.rates as Record<string, { n: number; d: number }>
    expect(Object.keys(rates)).toContain('render.MessageList/roomSwitch')
    expect(rates['render.MessageList/roomSwitch'].n).toBeGreaterThan(0)
    expect(rates['render.MessageList/roomSwitch'].d).toBeGreaterThan(0)

    // Environment travels with it, or the rate cannot be compared with anything.
    const env = digest.env as Record<string, unknown>
    expect(env.engine).toBe('blink')
    expect(env.platform).toBeTruthy()
    expect(typeof env.foreground).toBe('number')
  })

  /**
   * Crumbs, end to end.
   *
   * The ring, the width cap and the shedding order all had unit tests, and every one
   * of them passed while nothing in the app ever called `crumb()` — so every record
   * in the field arrived with an empty ring. That is why a main-thread stall
   * recurring for two months could not be attributed to anything. Only a real record
   * carrying real crumbs proves the chain is connected.
   */
  test('an anomaly record carries the events that preceded it', async ({ page }) => {
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

    const stallsBefore = await page.evaluate(
      () =>
        (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
          .map((line) => JSON.parse(line) as { id?: string })
          .filter((record) => record.id === 'perf/main-thread-stall').length,
    )

    await page.evaluate(() => {
      performance.measure('fluux:persist', { start: 0, duration: 1234 })
      const signal = (
        window as unknown as {
          __fluuxAnomalyProbeSignal?: (input: {
            name: 'perf/main-thread-stall'
            blockedMs: number
            thresholdMs: number
          }) => void
        }
      ).__fluuxAnomalyProbeSignal
      if (!signal) {
        throw new Error('the anomaly signal probe is unavailable')
      }
      signal({ name: 'perf/main-thread-stall', blockedMs: 2500, thresholdMs: 1000 })
    })

    await expect
      .poll(
        async () =>
          page.evaluate(
            (before) =>
              (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
                .map((l) => JSON.parse(l) as { id?: string })
                .filter((r) => r.id === 'perf/main-thread-stall').length > before,
            stallsBefore,
          ),
        { timeout: 15_000, message: 'the forced stall never reached the log' },
      )
      .toBe(true)

    const record = await page.evaluate(
      () =>
        (window as unknown as { __fluuxAnomalies: string[] }).__fluuxAnomalies
          .map((l) => JSON.parse(l) as Record<string, unknown>)
          .filter((r) => r.id === 'perf/main-thread-stall')
          .at(-1)!,
    )

    const crumbs = record.crumbs as unknown[][]
    expect(Array.isArray(crumbs)).toBe(true)
    expect(crumbs.length).toBeGreaterThan(0)

    // Activating the room is the transition the test itself performed, so it must be
    // among them, and it must name the room in the TOKEN namespace rather than by JID.
    //
    // The namespace, not a resolved digest. This session activates the room exactly
    // once, and a first activation is necessarily written before the entity has ever
    // been warmed, so it carries the sentinel. That is the worst case rather than the
    // normal one — every later activation of a room resolves — and the resolved path
    // is pinned in `denominators.test.ts`, where warming can be driven directly.
    const activate = crumbs.find((c) => c[1] === 'activate')
    expect(activate, `no activate crumb in ${JSON.stringify(crumbs)}`).toBeTruthy()
    expect(typeof activate![0]).toBe('number')
    expect(String(activate![2])).toMatch(/^c:(unresolved|[0-9a-f]{16})$/)

    // No crumb may carry a raw JID: the ring is written to the same file as
    // everything else and is bound by the same rule.
    expect(JSON.stringify(crumbs)).not.toContain('@')

    // The SDK's own timing reached the ring, so a stall record will carry the store
    // operation that ran before it and how long it took.
    const persist = crumbs.find((c) => c[1] === 'perf:persist')
    expect(persist, `no perf crumb in ${JSON.stringify(crumbs)}`).toBeTruthy()
    expect(typeof persist![0]).toBe('number')
    expect(persist![2]).toBe(1234)
  })
})
