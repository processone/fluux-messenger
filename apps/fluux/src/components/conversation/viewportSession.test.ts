import { describe, expect, it } from 'vitest'
import { planScrollEvent } from './scrollEventDecisions'
import { scrollDeltaBeyondClamp, ViewportSession, type ViewportGeometry } from './viewportSession'

const geometry = (
  top: number,
  height = 2_000,
  client = 500,
): ViewportGeometry => ({ top, height, client })

describe('movement beyond viewport clamping', () => {
  it.each([
    { top: 393, height: 1_060, client: 557, delta: -50 },
    { top: 400, height: 1_000, client: 600, delta: 0 },
    { top: 350, height: 1_000, client: 600, delta: -50 },
    { top: 463, height: 1_060, client: 557, delta: 20 },
  ])('reports $delta pixels of movement for $top/$height/$client', ({ top, height, client, delta }) => {
    expect(scrollDeltaBeyondClamp(geometry(443, 1_000, 557), geometry(top, height, client))).toBe(delta)
  })
})

describe('ViewportSession', () => {
  it('subtracts completed clamping from the remaining layout adjustment', () => {
    const session = new ViewportSession('room')
    session.recordProgrammaticWrite('room', 1000, {
      top: 393, height: 1000, client: 557, anchor: { rowId: 'selected', top: 920 },
    })
    expect(session.observeGeometry('room', {
      top: 383, height: 940, client: 557, anchor: { rowId: 'selected', top: 860 },
    }, { now: 1500, controllerOwnsPixels: false })?.userDelta).toBe(0)
    expect(session.consumeLayoutAdjustment('room')).toBe(-50)
  })
  it.each([0, 20])('attributes %i pixels separately from application layout adjustment', (userDelta) => {
    const session = new ViewportSession('room')
    const before = { top: 393, height: 1000, client: 557, anchor: { rowId: 'selected', top: 920 }, visibleAnchor: { rowId: 'selected', top: 920 } }
    session.recordProgrammaticWrite('room', 1000, before)
    session.recordUserInput('room', 1500)
    session.observeGeometry('room', before, { now: 1500, controllerOwnsPixels: false, input: { source: 'gesture', deltaY: 20 } })
    const after = { ...before, top: 393 + userDelta, height: 980, anchor: { rowId: 'selected', top: 900 }, visibleAnchor: { rowId: 'selected', top: 900 } }
    expect(session.observeGeometry('room', after, { now: 1520, controllerOwnsPixels: false })?.userDelta).toBe(userDelta)
    const adjustment = session.consumeLayoutAdjustment('room')
    expect(adjustment).toBe(-20)
    const adjusted = { ...after, top: after.top + adjustment }
    session.recordProgrammaticWrite('room', 1520, adjusted)
    expect(session.observeGeometry('room', adjusted, { now: 1540, controllerOwnsPixels: false })?.userDelta).toBe(0)
    expect(session.consumeLayoutAdjustment('room')).toBe(0)
  })
  it('preserves delayed ArrowDown movement amid matching row growth', () => {
    const session = new ViewportSession('room-a')
    const before = { ...geometry(393, 1000, 557), anchor: { rowId: 'selected', top: 920 } }
    session.recordProgrammaticWrite('room-a', 1000, before)
    session.recordUserInput('room-a', 1500)
    const input = { deltaY: 1, source: 'keyboard' as const }
    expect(session.observeGeometry('room-a', before, {
      now: 1500, controllerOwnsPixels: false, input,
    })?.userDelta).toBe(0)
    expect(session.observeGeometry('room-a', before, {
      now: 1520, controllerOwnsPixels: false,
    })?.userDelta).toBe(0)
    expect(session.observeGeometry('room-a', {
      ...geometry(413, 1020, 557), anchor: { rowId: 'selected', top: 940 },
    }, { now: 1560, controllerOwnsPixels: false })?.userDelta).toBe(20)
  })

  it('preserves the next native ArrowDown movement after keyup without a time limit', () => {
    const session = new ViewportSession('room-a')
    const before = { ...geometry(393, 1000, 557), anchor: { rowId: 'selected', top: 920 } }
    session.recordProgrammaticWrite('room-a', 1000, before)
    session.observeGeometry('room-a', before, {
      now: 1500,
      controllerOwnsPixels: false,
      input: { deltaY: 1, source: 'keyboard' },
    })
    session.endUserInput('room-a')
    expect(session.observeScroll({
      conversationId: 'room-a',
      geometry: { ...geometry(413, 1020, 557), anchor: { rowId: 'selected', top: 940 } },
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_000_000,
    })?.userDelta).toBe(20)
  })

  it('retires released keyboard attribution when layout changes before native movement', () => {
    const session = new ViewportSession('room-a')
    const before = { ...geometry(393, 1000, 557), anchor: { rowId: 'selected', top: 920 } }
    session.recordProgrammaticWrite('room-a', 1000, before)
    session.observeGeometry('room-a', before, {
      now: 1500,
      controllerOwnsPixels: false,
      input: { deltaY: 1, source: 'keyboard' },
    })
    session.endUserInput('room-a')
    expect(session.observeGeometry('room-a', {
      ...geometry(413, 1020, 557), anchor: { rowId: 'selected', top: 940 },
    }, { now: 1_000_000, controllerOwnsPixels: false })?.userDelta).toBe(0)
    expect(session.observeScroll({
      conversationId: 'room-a',
      geometry: { ...geometry(413, 1020, 557), anchor: { rowId: 'selected', top: 940 } },
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_000_001,
    })?.userDelta).toBe(0)
  })

  it('keeps delayed trusted movement distinct from browser layout anchoring', () => {
    const session = new ViewportSession('room-a')
    const before = { ...geometry(1_700, 2_000, 300), anchor: { rowId: 'selected', top: 1_800 } }
    session.recordProgrammaticWrite('room-a', 1_000, before)

    const layoutOnly = session.observeScroll({
      conversationId: 'room-a',
      geometry: { ...geometry(1_900, 2_200, 300), anchor: { rowId: 'selected', top: 2_000 } },
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_010,
    })
    expect(layoutOnly).toMatchObject({ delta: 200, userDelta: 0, genuineUserScroll: false, userScrollGeometry: null })
    expect(session.consumeLayoutAdjustment('room-a')).toBe(0)
    expect(planScrollEvent({
      scrollTop: 1_900,
      distanceFromBottom: 0,
      controllerOwnsPixels: false,
      growthDrivenDuringControllerScroll: false,
      genuineUserScroll: layoutOnly!.genuineUserScroll,
      userScrollGeometry: layoutOnly!.userScrollGeometry,
      staticMode: false,
      atBottomThreshold: 300,
      loadNewerThreshold: 4,
    }).loadNewer).toBe(false)

    session.recordProgrammaticWrite('room-a', 1_015, before)
    session.observeGeometry('room-a', before, {
      now: 1_015, controllerOwnsPixels: false, input: { deltaY: 20 },
    })
    session.endUserInput('room-a')
    expect(session.observeScroll({
      conversationId: 'room-a',
      geometry: { ...geometry(1_900, 2_200, 300), anchor: { rowId: 'selected', top: 2_000 } },
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_016,
    })).toMatchObject({ userDelta: 0, genuineUserScroll: false, userScrollGeometry: null })

    for (const input of [
      { deltaY: 20 },
      { deltaY: 20, source: 'gesture' as const },
      { deltaY: 1, source: 'keyboard' as const },
    ]) {
      session.recordProgrammaticWrite('room-a', 1_020, before)
      session.observeGeometry('room-a', before, { now: 1_020, controllerOwnsPixels: false, input })
      expect(session.observeScroll({
        conversationId: 'room-a',
        geometry: { ...geometry(1_720, 2_020, 300), anchor: { rowId: 'selected', top: 1_820 } },
        bottomAnchor: null,
        controllerOwnsPixels: false,
        now: 1_040,
      })).toMatchObject({ userDelta: 20, genuineUserScroll: true })
    }
  })

  it.each([undefined, 'gesture', 'keyboard'] as const)(
    'does not infer movement from stationary growth with %s input', (source) => {
      const session = new ViewportSession('room-a')
      const before = { ...geometry(393, 1000, 557), anchor: { rowId: 'selected', top: 920 } }
      session.recordProgrammaticWrite('room-a', 1000, before)
      session.recordUserInput('room-a', 1500)
      session.observeGeometry('room-a', before, {
        now: 1500, controllerOwnsPixels: false, input: { deltaY: -100, source },
      })
      expect(session.observeGeometry('room-a', {
        ...geometry(393, 1100, 557), anchor: { rowId: 'selected', top: 1020 },
      }, { now: 1560, controllerOwnsPixels: false })?.userDelta).toBe(0)
    },
  )

  it('does not infer scrolling from multiple stationary wheel inputs', () => {
    const session = new ViewportSession('room-a')
    const before = { ...geometry(393, 1000, 557), anchor: { rowId: 'selected', top: 920 } }
    session.recordProgrammaticWrite('room-a', 1000, before)
    session.observeGeometry('room-a', before, {
      now: 1500, controllerOwnsPixels: false, input: { deltaY: -100 },
    })
    session.observeGeometry('room-a', before, {
      now: 1550, controllerOwnsPixels: false, input: { deltaY: -20 },
    })
    expect(session.observeGeometry('room-a', {
      ...geometry(393, 1100, 557), anchor: { rowId: 'selected', top: 1020 },
    }, { now: 1560, controllerOwnsPixels: false })?.userDelta).toBe(0)
  })

  it.each([
    { deltaY: 50 },
    { deltaY: 1, source: 'keyboard' as const },
    { deltaY: 50, source: 'gesture' as const },
  ])('preserves genuine movement equal to retained-row displacement with $source input', (input) => {
    const session = new ViewportSession('room-a')
    const before = { ...geometry(393, 1000, 557), anchor: { rowId: 'selected', top: 920 } }
    session.recordProgrammaticWrite('room-a', 1000, before)
    session.observeGeometry('room-a', before, { now: 1500, controllerOwnsPixels: false, input })
    expect(session.observeGeometry('room-a', {
      ...geometry(443, 1050, 557), anchor: { rowId: 'selected', top: 970 },
    }, { now: 1510, controllerOwnsPixels: false })?.userDelta).toBe(50)
  })

  it.each([false, true])('preserves a real move after recorded layout writes with input=%s', input => {
    const session = new ViewportSession('room-a')
    session.recordProgrammaticWrite('room-a', 1000, geometry(900, 1500, 600))
    session.recordProgrammaticWrite('room-a', 1050, geometry(1500, 2100, 600))
    if (input) session.recordUserInput('room-a', 1060)
    expect(session.observeGeometry('room-a', geometry(1100, 2100, 600), {
      now: 1070, controllerOwnsPixels: true,
    })?.userDelta).toBe(-400)
  })

  it.each([-20, 0])('classifies %i pixels independently of retained-row movement with application layout ownership', (movement) => {
    const session = new ViewportSession('room-a')
    session.recordProgrammaticWrite('room-a', 1000, {
      top: 400, height: 1100, client: 600, anchor: { rowId: 'selected', top: 920 },
    })
    session.recordUserInput('room-a', 1500)
    expect(session.observeGeometry('room-a', {
      top: 400 + movement, height: 1080, client: 600, anchor: { rowId: 'selected', top: 900 },
    }, { now: 1500, controllerOwnsPixels: false, input: { deltaY: -20, source: 'gesture' } })?.userDelta).toBe(movement)
  })

  it('uses observed pixels under application layout ownership', () => {
    const session = new ViewportSession('room-a')
    const before = { top: 443, height: 1000, client: 557, anchor: { rowId: 'selected', top: 920 } }
    session.recordProgrammaticWrite('room-a', 1000, before)
    const context = { now: 1500, controllerOwnsPixels: false }
    session.observeGeometry('room-a', before, { ...context, input: { deltaY: -3 } })
    expect(session.observeGeometry('room-a', {
      top: 383, height: 1060, client: 557, anchor: { rowId: 'selected', top: 980 },
    }, context)?.userDelta).toBe(-60)
  })

  it('owns the current geometry, bottom anchor, measured edge, and genuine-input evidence', () => {
    const session = new ViewportSession('room-a')

    expect(
      session.recordViewport(
        'room-a',
        geometry(320),
        { messageId: 'message-12', fraction: 0.75 },
      ),
    ).toBe(true)
    expect(session.recordMeasuredLiveEdge('room-a', false)).toBe(true)
    expect(session.recordUserInput('room-a', 1_000)).toBe(true)
    expect(session.hasGenuineInput('room-a')).toBe(true)
    expect(session.lastUserIntentAt('room-a')).toBe(1_000)

    expect(session.snapshotFor('room-a')).toEqual({
      conversationId: 'room-a',
      geometry: geometry(320),
      bottomAnchor: { messageId: 'message-12', fraction: 0.75 },
      measuredAtLiveEdge: false,
      hasGenuineInput: true,
      previousScrollHeight: null,
      lastProgrammaticScrollAt: 0,
      lastUserIntentAt: 1_000,
      travelledAwayFromTop: false,
      travelledAwayFromBottom: false,
    })
  })

  it('attributes each recorded measurement write without a settle heuristic', () => {
    const session = new ViewportSession('room-a')
    session.recordProgrammaticWrite('room-a', 1_000, geometry(250, 2_000))

    const first = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(250, 2_000),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_300,
    })
    session.recordProgrammaticWrite('room-a', 1_600, geometry(240, 2_100))
    const changed = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(240, 2_100),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_600,
    })
    session.recordProgrammaticWrite('room-a', 1_700, geometry(230, 2_100))
    const settling = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(230, 2_100),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_700,
    })
    const genuine = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(220, 2_100),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_850,
    })

    expect(first?.genuineUserScroll).toBe(false)
    expect(changed).toMatchObject({
      previousScrollHeight: 2_000,
      heightChanged: true,
      genuineUserScroll: false,
    })
    expect(settling?.genuineUserScroll).toBe(false)
    expect(genuine?.genuineUserScroll).toBe(true)
    expect(session.snapshotFor('room-a')).toMatchObject({
      lastProgrammaticScrollAt: 1_700,
      hasGenuineInput: true,
      previousScrollHeight: 2_100,
    })
  })

  it('classifies viewport clamps and their settle events as geometry changes', () => {
    const session = new ViewportSession('room-a')
    const observe = (top: number, client: number, now: number) => session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(top, 1_000, client),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now,
    })
    observe(443, 557, 1_000)
    session.recordViewport('room-a', geometry(400, 1_000, 600), null)
    expect(observe(400, 600, 1_300)).toMatchObject({
      heightChanged: false,
      viewportClamped: true,
      genuineUserScroll: false,
    })
    expect(observe(400, 600, 1_400)?.genuineUserScroll).toBe(false)
    expect(session.hasGenuineInput('room-a')).toBe(false)
    expect(observe(350, 600, 1_600)?.genuineUserScroll).toBe(true)
    session.enterConversation('room-a')
    expect(observe(443, 557, 2_000)?.viewportClamped).toBe(false)
  })

  it('uses recorded writes when native events are withheld before a viewport clamp', () => {
    const session = new ViewportSession('room-a')
    session.observeScroll({
      conversationId: 'room-a', geometry: geometry(400, 1_000, 600),
      bottomAnchor: null, controllerOwnsPixels: false, now: 1_000,
    })
    session.recordProgrammaticWrite('room-a', 1_100, geometry(443, 1_000, 557))
    expect(session.observeScroll({
      conversationId: 'room-a', geometry: geometry(400, 1_000, 600),
      bottomAnchor: null, controllerOwnsPixels: false, now: 1_500,
    })).toMatchObject({ delta: 0, viewportClamped: true, genuineUserScroll: false })
    const context = { now: 1_500, controllerOwnsPixels: false }
    expect(session.observeGeometry('room-a', geometry(350, 1_060, 600), context)?.delta).toBe(-50)
    expect(session.observeGeometry('room-a', geometry(350, 1_060, 600), context)?.delta).toBe(0)
    session.enterConversation('room-b')
    expect(session.observeGeometry('room-a', geometry(300), context)).toBeNull()
    expect(session.observeGeometry('room-b', geometry(300), context)?.delta).toBe(0)
  })

  it('records an observed clamp without extending the actual-write timestamp', () => {
    const session = new ViewportSession('room-a')
    session.recordProgrammaticWrite('room-a', 1_000, geometry(1435, 2000, 557))
    expect(session.observeGeometry('room-a', geometry(1000, 2000, 1000), {
      now: 1_100, controllerOwnsPixels: true,
    })).toMatchObject({ delta: 0, userDelta: 0, viewportClamped: true })
    expect(session.snapshotFor('room-a')?.lastProgrammaticScrollAt).toBe(1_000)
    expect(session.observeScroll({
      conversationId: 'room-a', geometry: geometry(1000, 2000, 980),
      bottomAnchor: null, controllerOwnsPixels: false, now: 1_500,
    })).toMatchObject({ delta: 0, userDelta: 0, genuineUserScroll: false })
    expect(session.hasGenuineInput('room-a')).toBe(false)
  })

  it('separates anchoring and its settle from a fresh return to bottom', () => {
    const session = new ViewportSession('room-a')
    const observe = (top: number, height: number, now: number) => session.observeScroll({
      conversationId: 'room-a', geometry: geometry(top, height, 557),
      bottomAnchor: null, controllerOwnsPixels: false, now,
    })
    session.recordProgrammaticWrite('room-a', 1_000, geometry(443, 1000, 557))
    session.recordUserInput('room-a', 1_010)
    expect(observe(393, 1000, 1_020)).toMatchObject({ userDelta: -50, genuineUserScroll: true })
    session.recordProgrammaticWrite('room-a', 1_030, geometry(493, 1100, 557))
    expect(observe(493, 1100, 1_030)).toMatchObject({ delta: 0, userDelta: 0, genuineUserScroll: false })
    session.recordProgrammaticWrite('room-a', 1_040, geometry(498, 1100, 557))
    expect(observe(498, 1100, 1_040)).toMatchObject({ delta: 0, userDelta: 0, genuineUserScroll: false })
    session.recordUserInput('room-a', 1_050)
    expect(observe(543, 1100, 1_050)).toMatchObject({ userDelta: 45, genuineUserScroll: true })
  })

  it.each([undefined, 'gesture', 'keyboard'] as const)('does not count a clamped %s attempt as scrolling', (source) => {
    const session = new ViewportSession('room-a')
    const before = { ...geometry(443, 1000, 557), anchor: { rowId: 'selected', top: 920 } }
    const after = { ...geometry(543, 1100, 557), anchor: { rowId: 'selected', top: 1020 } }
    const context = { now: 1500, controllerOwnsPixels: false }
    session.recordProgrammaticWrite('room-a', 1000, before)
    session.recordUserInput('room-a', 1500)
    expect(session.observeGeometry('room-a', before, {
      ...context, input: { deltaY: 100, source },
    })?.userDelta).toBe(0)
    session.recordProgrammaticWrite('room-a', 1510, after)
    expect(session.observeGeometry('room-a', after, context)?.userDelta).toBe(0)
  })

  it('distinguishes bottom animation progress from reverse movement without input delivery', () => {
    const session = new ViewportSession('room-a')
    const context = { now: 1500, controllerOwnsPixels: true }
    session.recordProgrammaticWrite('room-a', 1000, geometry(1360, 2000, 500))
    session.recordProgrammaticWrite('room-a', 1400, geometry(1370, 2000, 500))
    expect(session.observeGeometry('room-a', geometry(1370, 2000, 500), context)?.userDelta).toBe(0)
    expect(session.observeGeometry('room-a', geometry(1000, 2000, 500), context)?.userDelta).toBe(-370)
  })

  it('consumes navigation input while preserving later Home takeover', () => {
    const session = new ViewportSession('room-a')
    const context = { now: 1500, controllerOwnsPixels: true }
    session.recordProgrammaticWrite('room-a', 1000, geometry(443, 1000, 557))
    session.recordUserInput('room-a', 1500)
    session.observeGeometry('room-a', geometry(443, 1000, 557), { ...context, resetInput: true })
    session.recordProgrammaticWrite('room-a', 1505, geometry(343, 1000, 557))
    expect(session.observeGeometry('room-a', geometry(343, 1000, 557), context)?.userDelta).toBe(0)
    session.recordUserInput('room-a', 1510)
    expect(session.observeGeometry('room-a', geometry(323, 1000, 557), context)?.userDelta).toBe(-20)
  })

  it('delivers sampled user geometry once without adopting a later application destination', () => {
    const session = new ViewportSession('room-a')
    const context = { now: 1500, controllerOwnsPixels: false }
    session.recordProgrammaticWrite('room-a', 1000, geometry(1400, 2000, 600))
    session.observeGeometry('room-a', geometry(400, 2000, 600), context)
    session.recordProgrammaticWrite('room-a', 1500, geometry(1400, 2000, 600))
    const event = { ...context, conversationId: 'room-a', geometry: geometry(1400, 2000, 600), bottomAnchor: null }
    expect(session.observeScroll(event)?.userScrollGeometry).toEqual(geometry(400, 2000, 600))
    expect(session.observeScroll(event)?.userScrollGeometry).toBeNull()
    session.observeGeometry('room-a', geometry(1380, 2000, 600), context)
    expect(session.observeScroll({ ...event, geometry: geometry(1380, 2000, 600) })?.userScrollGeometry).toEqual(geometry(1380, 2000, 600))
    session.observeGeometry('room-a', geometry(1300, 2000, 600), context)
    session.enterConversation('room-b')
    expect(session.observeScroll({ ...event, conversationId: 'room-b' })?.userScrollGeometry).toBeNull()
  })

  it('rebases pending displacement together with the visible reading row', () => {
    const session = new ViewportSession('room-a')
    session.recordProgrammaticWrite('room-a', 1000, { ...geometry(1400, 2000, 600), anchor: { rowId: 'tail', top: 1920 } })
    expect(session.observeGeometry('room-a', {
      ...geometry(400, 2080, 600), anchor: { rowId: 'tail', top: 2000 }, visibleAnchor: { rowId: 'visible', top: 900 },
    }, { now: 1500, controllerOwnsPixels: false })?.userDelta).toBe(-1000)
    expect(session.consumeLayoutAdjustment('room-a')).toBe(0)
    expect(session.observedRowIdFor('room-a')).toBe('visible')
    expect(session.snapshotFor('room-a')?.lastProgrammaticScrollAt).toBe(1000)
    session.observeGeometry('room-a', {
      ...geometry(400, 2280, 600), anchor: { rowId: 'visible', top: 900 }, visibleAnchor: { rowId: 'visible', top: 900 },
    }, { now: 1520, controllerOwnsPixels: false })
    expect(session.consumeLayoutAdjustment('room-a')).toBe(0)
    session.observeGeometry('room-a', {
      ...geometry(400, 2360, 600), anchor: { rowId: 'visible', top: 980 }, visibleAnchor: { rowId: 'visible', top: 980 },
    }, { now: 1540, controllerOwnsPixels: false })
    expect(session.consumeLayoutAdjustment('room-a')).toBe(80)
  })

  it('does not classify a manual move beyond the viewport clamp as geometry-driven', () => {
    const session = new ViewportSession('room-a')
    session.observeScroll({
      conversationId: 'room-a', geometry: geometry(400, 1_000, 600),
      bottomAnchor: null, controllerOwnsPixels: false, now: 1_000,
    })
    session.recordUserInput('room-a', 1_300)
    expect(session.observeScroll({
      conversationId: 'room-a', geometry: geometry(214, 1_000, 620),
      bottomAnchor: null, controllerOwnsPixels: false, now: 1_300,
    })).toMatchObject({ viewportClamped: false, genuineUserScroll: true })
  })

  it('does not turn a controller-owned stable-height scroll into user evidence', () => {
    const session = new ViewportSession('room-a')
    session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(800),
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 1_000,
    })

    session.recordProgrammaticWrite('room-a', 2_000, geometry(500))
    const controllerScroll = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(500),
      bottomAnchor: null,
      controllerOwnsPixels: true,
      now: 2_000,
    })

    expect(controllerScroll).toMatchObject({
      previousScrollHeight: 2_000,
      heightChanged: false,
      genuineUserScroll: false,
    })
    expect(session.hasGenuineInput('room-a')).toBe(false)
  })

  it('does not turn subpixel jitter during controller-owned growth into user evidence', () => {
    const session = new ViewportSession('room-a')
    const before = geometry(1_010, 1_552, 540)
    session.observeScroll({
      conversationId: 'room-a',
      geometry: before,
      bottomAnchor: null,
      controllerOwnsPixels: false,
      now: 900,
    })
    session.recordProgrammaticWrite('room-a', 1_000, before)

    const growthScroll = session.observeScroll({
      conversationId: 'room-a',
      geometry: geometry(1_008, 1_909, 540),
      bottomAnchor: null,
      controllerOwnsPixels: true,
      now: 1_020,
    })

    expect(growthScroll).toMatchObject({
      userDelta: 0,
      growthDrivenDuringControllerScroll: true,
      genuineUserScroll: false,
    })
    expect(session.hasGenuineInput('room-a')).toBe(false)
  })

  it('preserves movement beyond controller-owned growth jitter', () => {
    const session = new ViewportSession('room-a')
    const before = geometry(1_010, 1_552, 540)
    session.recordProgrammaticWrite('room-a', 1_000, before)

    expect(session.observeGeometry('room-a', geometry(1_005, 1_909, 540), {
      controllerOwnsPixels: true,
      now: 1_020,
    })?.userDelta).toBe(-5)
  })

  it('resets every conversation-scoped fact and rejects stale callbacks on entry', () => {
    const session = new ViewportSession('room-a')
    session.recordViewport(
      'room-a',
      geometry(400),
      { messageId: 'message-a', fraction: 0.5 },
    )
    session.recordMeasuredLiveEdge('room-a', true)
    session.recordUserInput('room-a', 2_000)
    session.recordProgrammaticWrite('room-a', 2_100, geometry(400))
    session.markTravelAway('room-a', 'top')
    session.markTravelAway('room-a', 'bottom')

    session.enterConversation('room-b')

    expect(
      session.recordViewport(
        'room-a',
        geometry(999),
        { messageId: 'stale', fraction: 1 },
      ),
    ).toBe(false)
    expect(session.recordMeasuredLiveEdge('room-a', false)).toBe(false)
    expect(session.recordProgrammaticWrite('room-a', 9_999, geometry(999))).toBe(false)
    expect(session.recordUserInput('room-a', 9_999)).toBe(false)
    expect(session.markTravelAway('room-a', 'bottom')).toBe(false)
    expect(session.snapshotFor('room-a')).toBeNull()
    expect(session.hasGenuineInput('room-a')).toBe(false)
    expect(session.lastUserIntentAt('room-a')).toBe(0)
    expect(session.snapshotFor('room-b')).toEqual({
      conversationId: 'room-b',
      geometry: null,
      bottomAnchor: null,
      measuredAtLiveEdge: null,
      hasGenuineInput: false,
      previousScrollHeight: null,
      lastProgrammaticScrollAt: 0,
      lastUserIntentAt: 0,
      travelledAwayFromTop: false,
      travelledAwayFromBottom: false,
    })
  })

  it('keeps top and bottom travel latches independent and explicitly clearable', () => {
    const session = new ViewportSession('room-a')

    session.markTravelAway('room-a', 'top')
    expect(session.hasTravelledAway('room-a', 'top')).toBe(true)
    expect(session.hasTravelledAway('room-a', 'bottom')).toBe(false)

    session.markTravelAway('room-a', 'bottom')
    session.clearTravel('room-a', 'top')
    expect(session.hasTravelledAway('room-a', 'top')).toBe(false)
    expect(session.hasTravelledAway('room-a', 'bottom')).toBe(true)
  })

  it.each([false, true])('attributes delayed events using recorded writes=%s', recorded => {
    const session = new ViewportSession('room-a')
    const event = { conversationId: 'room-a', geometry: geometry(1200, 4000), bottomAnchor: null, controllerOwnsPixels: false, now: 1000 }
    session.observeScroll(event)
    if (recorded) session.recordProgrammaticWrite('room-a', 1100, geometry(800, 4000))
    expect(session.observeScroll({ ...event, geometry: geometry(800, 4000), now: 5000 })?.genuineUserScroll).toBe(!recorded)
  })
})
