import { describe, expect, it } from 'vitest'
import {
  RECENT_INTENT_WINDOW_MS,
  TRAVEL_AWAY_THRESHOLD,
  decideMarkerClear,
  isMarkerAboveViewport,
  planScrollEvent,
  planWheelEvent,
  type MarkerClearFacts,
  type ScrollEventFacts,
  type WheelEventFacts,
} from './scrollEventDecisions'

const AT_BOTTOM = 300
const LOAD_NEWER = 4

const scrollFacts = (
  overrides: Partial<ScrollEventFacts> = {},
): ScrollEventFacts => ({
  scrollTop: 2_000,
  distanceFromBottom: 1_000,
  controllerOwnsPixels: false,
  growthDrivenDuringControllerScroll: false,
  genuineUserScroll: false,
  staticMode: false,
  hasTravelledAwayFromTop: true,
  atBottomThreshold: AT_BOTTOM,
  loadNewerThreshold: LOAD_NEWER,
  ...overrides,
})

describe('planScrollEvent: measured live-edge evidence', () => {
  it('records the measurement for an ordinary event', () => {
    const plan = planScrollEvent(scrollFacts({ distanceFromBottom: 10 }))
    expect(plan.recordMeasuredAtBottom).toBe(true)
    expect(plan.atBottom).toBe(true)
  })

  it('refuses to record a growth-driven event under a running loop', () => {
    // Believing this flips the at-bottom flag false, the pin loop bails, and a send is stranded
    // below the fold — the WebKitGTK send-stick defect.
    const plan = planScrollEvent(
      scrollFacts({
        distanceFromBottom: 900,
        controllerOwnsPixels: true,
        growthDrivenDuringControllerScroll: true,
      }),
    )
    expect(plan.recordMeasuredAtBottom).toBe(false)
  })

  it('still records a genuine scroll-up during a loop, which leaves the height alone', () => {
    // Paired with the case above: a loop is running, but this is not growth-driven.
    const plan = planScrollEvent(
      scrollFacts({
        distanceFromBottom: 900,
        controllerOwnsPixels: true,
        growthDrivenDuringControllerScroll: false,
      }),
    )
    expect(plan.recordMeasuredAtBottom).toBe(true)
    expect(plan.atBottom).toBe(false)
  })

  it('reads at-bottom off the supplied threshold, exclusive', () => {
    expect(planScrollEvent(scrollFacts({ distanceFromBottom: 299 })).atBottom).toBe(true)
    expect(planScrollEvent(scrollFacts({ distanceFromBottom: 300 })).atBottom).toBe(false)
  })
})

describe('planScrollEvent: reader attribution', () => {
  it('tracks the bottom-visible message only for a reader-owned scroll', () => {
    expect(planScrollEvent(scrollFacts()).trackBottomVisibleMessage).toBe(true)
    expect(
      planScrollEvent(scrollFacts({ controllerOwnsPixels: true }))
        .trackBottomVisibleMessage,
    ).toBe(false)
  })

  it('observes input only on the session verdict, not merely a non-programmatic event', () => {
    // Distinct facts: a measurement-settle frame is non-programmatic yet not a genuine move.
    expect(planScrollEvent(scrollFacts()).observeGenuineInput).toBe(false)
    expect(
      planScrollEvent(scrollFacts({ genuineUserScroll: true })).observeGenuineInput,
    ).toBe(true)
  })
})

describe('planScrollEvent: travel latches', () => {
  it('arms the top latch past the threshold, but never for a controller-owned move', () => {
    expect(
      planScrollEvent(scrollFacts({ scrollTop: TRAVEL_AWAY_THRESHOLD + 1 }))
        .markTravelAwayFromTop,
    ).toBe(true)
    expect(
      planScrollEvent(scrollFacts({ scrollTop: TRAVEL_AWAY_THRESHOLD }))
        .markTravelAwayFromTop,
    ).toBe(false)
    // Home's smooth trip from the bottom crosses this threshold and must not look like pagination.
    expect(
      planScrollEvent(
        scrollFacts({ scrollTop: 2_000, controllerOwnsPixels: true }),
      ).markTravelAwayFromTop,
    ).toBe(false)
  })

  it('arms the bottom latch even under the controller, unlike the top latch', () => {
    // Deliberate asymmetry: content growth alone moves this edge.
    expect(
      planScrollEvent(
        scrollFacts({ distanceFromBottom: 1_000, controllerOwnsPixels: true }),
      ).markTravelAwayFromBottom,
    ).toBe(true)
    expect(
      planScrollEvent(
        scrollFacts({ distanceFromBottom: TRAVEL_AWAY_THRESHOLD }),
      ).markTravelAwayFromBottom,
    ).toBe(false)
  })
})

describe('planScrollEvent: boundary loads', () => {
  it('loads older only at the very top after genuine travel', () => {
    expect(planScrollEvent(scrollFacts({ scrollTop: 0 })).loadOlder).toBe(true)
    expect(planScrollEvent(scrollFacts({ scrollTop: 1 })).loadOlder).toBe(false)
  })

  it('refuses the entry transient at scrollTop 0 before the reader ever travelled', () => {
    // Loading here prepends a batch and clears bottom-stick for the next arrival.
    expect(
      planScrollEvent(
        scrollFacts({ scrollTop: 0, hasTravelledAwayFromTop: false }),
      ).loadOlder,
    ).toBe(false)
  })

  it('loads newer at or inside the resident-bottom threshold', () => {
    expect(
      planScrollEvent(scrollFacts({ distanceFromBottom: LOAD_NEWER })).loadNewer,
    ).toBe(true)
    expect(
      planScrollEvent(scrollFacts({ distanceFromBottom: LOAD_NEWER + 1 })).loadNewer,
    ).toBe(false)
  })

  it('never loads in a static preview, which starts at scrollTop 0', () => {
    const preview = planScrollEvent(
      scrollFacts({ scrollTop: 0, distanceFromBottom: 0, staticMode: true }),
    )
    expect(preview.loadOlder).toBe(false)
    expect(preview.loadNewer).toBe(false)
  })
})

describe('planWheelEvent', () => {
  const wheel = (overrides: Partial<WheelEventFacts> = {}): WheelEventFacts => ({
    scrollTop: 0,
    distanceFromBottom: 5_000,
    deltaY: -10,
    staticMode: false,
    loadNewerThreshold: LOAD_NEWER,
    ...overrides,
  })

  it('loads older on a wheel-up pinned at the top, with no travel requirement', () => {
    // A wheel is explicit intent, unlike the passive scroll path.
    expect(planWheelEvent(wheel()).loadOlder).toBe(true)
  })

  it('does not load older when wheeling down, or away from the top', () => {
    expect(planWheelEvent(wheel({ deltaY: 10 })).loadOlder).toBe(false)
    expect(planWheelEvent(wheel({ scrollTop: 5 })).loadOlder).toBe(false)
  })

  it('loads newer on a wheel-down pinned at the resident bottom, where no scroll event fires', () => {
    expect(
      planWheelEvent(wheel({ distanceFromBottom: 0, deltaY: 10 })).loadNewer,
    ).toBe(true)
    expect(
      planWheelEvent(wheel({ distanceFromBottom: 0, deltaY: -10 })).loadNewer,
    ).toBe(false)
  })

  it('arms each travel latch on the direction that leaves that edge', () => {
    expect(planWheelEvent(wheel({ deltaY: 10 })).markTravelAwayFromTop).toBe(true)
    expect(planWheelEvent(wheel({ deltaY: -10 })).markTravelAwayFromTop).toBe(false)
    expect(
      planWheelEvent(wheel({ distanceFromBottom: 1_000, deltaY: -10 }))
        .markTravelAwayFromBottom,
    ).toBe(true)
    expect(
      planWheelEvent(wheel({ distanceFromBottom: 1_000, deltaY: 10 }))
        .markTravelAwayFromBottom,
    ).toBe(false)
  })

  it('never loads in a static preview', () => {
    expect(planWheelEvent(wheel({ staticMode: true })).loadOlder).toBe(false)
    expect(
      planWheelEvent(wheel({ distanceFromBottom: 0, deltaY: 10, staticMode: true }))
        .loadNewer,
    ).toBe(false)
  })
})

describe('isMarkerAboveViewport', () => {
  it('is true only for a known offset above the current scrollTop', () => {
    expect(isMarkerAboveViewport(100, 200)).toBe(true)
    expect(isMarkerAboveViewport(200, 200)).toBe(false)
    expect(isMarkerAboveViewport(300, 200)).toBe(false)
  })

  it('treats an unknown offset as not above, including offset zero as a real value', () => {
    expect(isMarkerAboveViewport(null, 200)).toBe(false)
    expect(isMarkerAboveViewport(undefined, 200)).toBe(false)
    // 0 is a legitimate offset: the marker is the very first row.
    expect(isMarkerAboveViewport(0, 200)).toBe(true)
    expect(isMarkerAboveViewport(0, 0)).toBe(false)
  })
})

describe('decideMarkerClear', () => {
  const facts = (overrides: Partial<MarkerClearFacts> = {}): MarkerClearFacts => ({
    hasMarker: true,
    canClear: true,
    controllerOwnsPixels: false,
    armed: false,
    distanceFromBottom: 1_000,
    atBottomThreshold: AT_BOTTOM,
    lastUserIntentAt: 0,
    now: 10_000,
    ...overrides,
  })

  it('only arms on the first scroll, so the marker is never retired unseen', () => {
    expect(decideMarkerClear(facts())).toBe('arm')
  })

  it('clears once armed and read through to the bottom', () => {
    expect(decideMarkerClear(facts({ armed: true, distanceFromBottom: 10 }))).toBe(
      'clear',
    )
  })

  it('does not clear when armed but still up in history', () => {
    // Scrolled-past must keep the divider: the jump-to-last-read pill needs it.
    expect(decideMarkerClear(facts({ armed: true }))).toBe('none')
  })

  it('clears immediately on an at-bottom arrival that follows a recent intent', () => {
    expect(
      decideMarkerClear(
        facts({
          distanceFromBottom: 10,
          lastUserIntentAt: 10_000 - (RECENT_INTENT_WINDOW_MS - 1),
        }),
      ),
    ).toBe('clear')
  })

  it('only arms when the at-bottom arrival follows a stale intent', () => {
    // Paired with the case above: identical but for the intent age.
    expect(
      decideMarkerClear(
        facts({
          distanceFromBottom: 10,
          lastUserIntentAt: 10_000 - RECENT_INTENT_WINDOW_MS,
        }),
      ),
    ).toBe('arm')
  })

  it('treats a never-recorded intent as stale rather than recent', () => {
    expect(
      decideMarkerClear(facts({ distanceFromBottom: 10, lastUserIntentAt: 0 })),
    ).toBe('arm')
    // The sentinel must be tested as "absent", not merely subtracted: with a small clock,
    // `now - 0` falls inside the window and a bare arithmetic check would call it recent, clearing
    // the divider on the reader's very first scroll.
    expect(
      decideMarkerClear(
        facts({ distanceFromBottom: 10, lastUserIntentAt: 0, now: 100 }),
      ),
    ).toBe('arm')
  })

  it('does nothing without a marker, without a clear callback, or under the controller', () => {
    expect(decideMarkerClear(facts({ hasMarker: false }))).toBe('none')
    expect(decideMarkerClear(facts({ canClear: false }))).toBe('none')
    // A FAB jump-to-present drives a reassert loop and must not clear the divider.
    expect(
      decideMarkerClear(
        facts({ armed: true, distanceFromBottom: 10, controllerOwnsPixels: true }),
      ),
    ).toBe('none')
  })
})
