// Intent: FLM-229's accepted interaction anchor must outlive every ambient positioning stimulus.
import { describe, expect, it, vi } from 'vitest'
import { PositioningController, type AnchorPreservationExecutor, type LiveEdgeExecutor, type ExplicitTargetExecutor } from './positioningController'
import { messageFraction, pixelOffset } from './scrollPositionModel'
import { AnchorPreservationBrowserAdapter } from './anchorPreservationBrowserAdapter'
import { BottomFractionAnchorBrowserAdapter } from './bottomFractionAnchorBrowserAdapter'
import { ViewportSession } from './viewportSession'

const conversationId = 'emma@fluux.chat'
// Baseline capture: the target top was 552px in a scroller beginning at 95px.
const desired = { kind: 'anchor' as const, messageId: 'interaction-target', placement: { kind: 'top-offset' as const, offsetPx: pixelOffset(552 - 95) } }
function live(position: () => void = vi.fn()): LiveEdgeExecutor {
  return {
    reachability: () => ({ kind: 'global-live-edge', state: { kind: 'resident-tail', index: 35, mounted: true } }),
    beginLoop: () => null,
    positionFrame: () => { position(); return { kind: 'positioned', scrollTop: 552, atLiveEdge: true, wrote: true, reassert: false } },
    complete: () => {},
  }
}
function anchor(position: () => void = vi.fn()): AnchorPreservationExecutor {
  return {
    reachability: () => ({ kind: 'available', index: 35, mounted: true, placement: 'viable' }),
    observeGeometry: () => {}, beginLoop: () => null,
    positionFrame: () => { position(); return { kind: 'positioned', scrollTop: 552, reassert: false } },
    complete: () => {},
  }
}
function setup(close: () => void = vi.fn()) {
  const ownership = vi.fn()
  const controller = new PositioningController(ownership, undefined, undefined, close)
  controller.beginLiveEdgeEntry({ conversationId, entryFacts: { syncedLiveEdge: false }, executor: live() })
  return { controller, ownership, close }
}

describe('interaction position ownership', () => {
  it('rejects arrival, geometry rearm, media, divider and late-MDS replacement after settling', () => {
    const { controller } = setup()
    const request = controller.beginInteractionHold({ conversationId, desired, executor: anchor() })!
    expect(controller.snapshot().active?.phase.kind).toBe('settled')
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: true })).toBe(false)
    const ambient = { conversationId, desired: { kind: 'anchor' as const, messageId: desired.messageId, placement: { kind: 'bottom-fraction' as const, fraction: messageFraction(1) } }, executor: anchor() }
    expect(controller.beginMediaPreservation(ambient)).toBeNull()
    expect(controller.beginLayoutPreservation({ ...ambient, reason: 'divider-mutation' })).toBeNull()
    expect(controller.beginLiveEdgeRequest({ conversationId, source: { kind: 'late-mds-supersession', reason: 'divider-cleared' }, executor: live() })).toBeNull()
    expect(controller.snapshot().active?.request.generation).toBe(request.generation)
    expect(controller.snapshot().active?.request.desired).toEqual(desired)
  })
  it('reopens the same anchor generation for a later layout mutation', () => {
    const { controller } = setup()
    const request = controller.beginInteractionHold({ conversationId, desired, executor: anchor() })!
    const position = vi.fn()
    expect(controller.reconcileInteractionHold({ conversationId, executor: anchor(position) })).toBe(true)
    expect(position).toHaveBeenCalledOnce()
    expect(controller.snapshot().active?.request.generation).toBe(request.generation)
  })
  it('corrects a new layout before paint even while the previous operation is still settling', () => {
    const { controller } = setup()
    const position = vi.fn()
    const frames: (() => void)[] = []
    const finish = vi.fn()
    const executor = anchor(position)
    executor.positionFrame = () => { position(); return { kind: 'positioned', scrollTop: 552, reassert: true } }
    executor.beginLoop = () => ({ schedule: callback => frames.push(callback), recordFrame: () => {}, finish })
    const request = controller.beginInteractionHold({ conversationId, desired, executor })!
    expect(position).toHaveBeenCalledTimes(1)
    controller.reconcileInteractionHold({ conversationId, executor })
    expect(position).toHaveBeenCalledTimes(2)
    expect(finish).toHaveBeenCalledOnce()
    expect(controller.snapshot().active?.request.generation).toBe(request.generation)
    frames.shift()!() // A stale callback from the first operation cannot write.
    expect(position).toHaveBeenCalledTimes(2)
  })

  it('resumes a previously live reader only after deliberate disengagement', () => {
    const { controller, close } = setup()
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    const position = vi.fn()
    controller.releaseInteractionHold({ conversationId, resume: true, liveEdge: live(position) })
    expect(close).toHaveBeenCalledOnce()
    expect(position).toHaveBeenCalledOnce()
    expect(controller.snapshot().active?.request.source).toEqual({ kind: 'ambient-live-edge', reason: 'interaction-release' })
  })
  it('keeps history reading intent on release, even if geometry is near the bottom', () => {
    const { controller } = setup()
    const generation = controller.observeUserInput(conversationId)
    controller.observeSettledUserGeometry({ conversationId, generation, atLiveEdge: false })
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    const position = vi.fn()
    controller.releaseInteractionHold({ conversationId, resume: true, liveEdge: live(position) })
    expect(position).not.toHaveBeenCalled()
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(position), rearmEligibleFromGeometry: true })).toBe(false)
    expect(controller.snapshot().active?.request.desired).toEqual(desired)
  })
  it('closes menus before explicit navigation or an outgoing send writes pixels', () => {
    for (const source of [
      { kind: 'user-navigation' as const, reason: 'live-edge' as const },
      { kind: 'live-update' as const, reason: 'outgoing-message' as const },
    ]) {
      const order: string[] = []
      const { controller } = setup(() => order.push('close'))
      controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
      controller.beginLiveEdgeRequest({ conversationId, source, executor: live(() => order.push('position')) })
      expect(order).toEqual(['close', 'position'])
      expect(controller.hasInteractionHold()).toBe(false)
    }
  })
  it('does not let pointer intent take ownership from an ongoing deliberate scroll gesture', () => {
    const { controller } = setup()
    controller.holdInput(conversationId)
    controller.observeUserInput(conversationId)
    expect(controller.beginInteractionHold({ conversationId, desired, executor: anchor() })).toBeNull()
    controller.observeUserInputEnd(conversationId)
    expect(controller.beginInteractionHold({ conversationId, desired, executor: anchor() })).not.toBeNull()
  })

  // FLM-229/J4: actual movement while a hold is active preserves reading, even inside the band.
  it.each([
    { name: 'unobserved', input: undefined },
    { name: 'wheel', input: { deltaY: -100, geometry: { top: 3434, height: 4046, client: 612 } } },
  ])('manual $name input ends the interaction without automatic release-resume or geometry rearm', ({ input }) => {
    const { controller, close } = setup()
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.observeUserInput(conversationId, input)
    expect(close).toHaveBeenCalledOnce()
    const position = vi.fn()
    controller.releaseInteractionHold({ conversationId, resume: true, liveEdge: live(position) })
    controller.observeUserScroll(conversationId, -100, false)
    controller.observeUserInputEnd(conversationId, false)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(position), rearmEligibleFromGeometry: true })).toBe(false)
    expect(position).not.toHaveBeenCalled()
  })
  // FLM-245 J1: captured room boundary (3434 + 612 = 4046). No scroll event
  // follows downward input there, so input-end must restore follow before a later arrival.
  it.each([
    { name: 'wheel', deltaY: 120, source: undefined },
    { name: 'scroll key', deltaY: 1, source: 'keyboard' as const },
  ])('settles a released hold at the unchanged bottom after $name input', ({ deltaY, source }) => {
    const { controller, close } = setup()
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.holdInput(conversationId)
    controller.observeUserInput(conversationId, { deltaY, source, geometry: { top: 3434, height: 4046, client: 612 } })
    expect(close).toHaveBeenCalledOnce()
    controller.observeUserInputEnd(conversationId, true)
    const position = vi.fn()
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(position), rearmEligibleFromGeometry: false })).toBe(true)
    expect(position).toHaveBeenCalledOnce()
  })

  // FLM-245 F3/J1: the kept WebKit trace ends PageUp at 2424 before native motion
  // starts 20ms later. Keyup at the old bottom must not turn following back on.
  it.each([
    { name: 'wheel', deltaY: -120, source: undefined },
    { name: 'PageUp', deltaY: -1, source: 'keyboard' as const },
  ])('does not rearm at the old bottom before delayed $name movement', ({ deltaY, source }) => {
    const { controller } = setup()
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.holdInput(conversationId)
    controller.observeUserInput(conversationId, { deltaY, source, geometry: { top: 2424, height: 2956, client: 532 } })
    controller.observeUserInputEnd(conversationId, true)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: false })).toBe(false)
    controller.observeUserScroll(conversationId, -1, true)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: true })).toBe(false)
  })

  it('keeps native upward takeover even when its first pixel is inside the bottom tolerance', () => {
    const { controller, close } = setup()
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.observeUserScroll(conversationId, -1, true)
    expect(close).toHaveBeenCalledOnce()
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: true })).toBe(false)
  })

  // "Hold during interaction": downward input can finish before its delayed growth compensation.
  // Captured Chromium geometry: input lands at 9172/9694/472; compensation lands at 9222/9694/472.
  const growthInput = { top: 9122, height: 9644, client: 472 }
  const growthInputEnd = { top: 9172, height: 9694, client: 472 }
  const growthCompensated = { ...growthInputEnd, top: 9222 }
  const downwardDelta = growthInputEnd.top - growthInput.top
  function downwardAfterHold(controller: PositioningController, end = true) {
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.holdInput(conversationId)
    controller.observeUserInput(conversationId, { deltaY: downwardDelta, geometry: growthInput })
    controller.observeUserScroll(conversationId, downwardDelta, false)
    if (end) controller.observeUserInputEnd(conversationId, false)
  }
  const compensationReachesBottom = () =>
    growthCompensated.height - growthCompensated.top - growthCompensated.client === 0

  it('settles downward intent when delayed reading compensation reaches the true bottom', () => {
    const { controller } = setup()
    downwardAfterHold(controller)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: true })).toBe(false)
    expect(controller.preserveReadingLayout(conversationId, compensationReachesBottom)).toBe(true)
    const position = vi.fn()
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(position), rearmEligibleFromGeometry: false })).toBe(true)
    expect(position).toHaveBeenCalledOnce()
  })

  it('does not settle the compensation while the downward gesture is still held', () => {
    const { controller } = setup()
    downwardAfterHold(controller, false)
    controller.preserveReadingLayout(conversationId, compensationReachesBottom)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: false })).toBe(false)
    controller.observeUserInputEnd(conversationId, true)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: false })).toBe(true)
  })

  it('keeps upward reading when compensation alone reaches the bottom', () => {
    const { controller } = setup()
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.holdInput(conversationId)
    controller.observeUserInput(conversationId, { deltaY: -downwardDelta, geometry: growthInputEnd })
    controller.observeUserScroll(conversationId, -downwardDelta, false)
    controller.observeUserInputEnd(conversationId, false)
    controller.preserveReadingLayout(conversationId, compensationReachesBottom)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: true })).toBe(false)
  })

  it('invalidates delayed downward settlement when newer upward movement wins', () => {
    const { controller } = setup()
    downwardAfterHold(controller)
    controller.observeUserScroll(conversationId, -1, false)
    controller.preserveReadingLayout(conversationId, compensationReachesBottom)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: true })).toBe(false)
  })

  it('does not let layout alone settle a released interaction with no directed input', () => {
    const { controller } = setup()
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.releaseInteractionHold({ conversationId, resume: false, liveEdge: live() })
    controller.preserveReadingLayout(conversationId, compensationReachesBottom)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: true })).toBe(false)
  })

  it('does not carry delayed downward eligibility into a new interaction generation', () => {
    const { controller } = setup()
    downwardAfterHold(controller)
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.releaseInteractionHold({ conversationId, resume: false, liveEdge: live() })
    controller.preserveReadingLayout(conversationId, compensationReachesBottom)
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(), rearmEligibleFromGeometry: true })).toBe(false)
  })

  // Explicit destinations retain priority until their completion, then normal interaction resumes.
  it('keeps an in-flight explicit target ahead of a hold and completes it once', () => {
    const { controller } = setup()
    const frames: (() => void)[] = []
    const complete = vi.fn()
    const executor: ExplicitTargetExecutor = {
      reachability: () => ({ kind: 'available', index: 80, mounted: true, placement: 'viable' }),
      observeGeometry: () => {},
      beginLoop: () => ({ schedule: callback => frames.push(callback), recordFrame: () => {}, finish: () => {} }),
      positionFrame: () => ({ kind: 'positioned', scrollTop: 9172, wrote: true }),
      complete,
    }
    controller.beginExplicitTarget({ conversationId, messageId: 'after-target-resize', executor })
    expect(controller.hasPendingMessageNavigation(conversationId)).toBe(true)
    expect(controller.beginInteractionHold({ conversationId, desired, executor: anchor() })).toBeNull()
    while (frames.length) frames.shift()!()
    expect(complete).toHaveBeenCalledOnce()
    expect(complete).toHaveBeenCalledWith(expect.anything(), 'settled', true)
    expect(controller.beginInteractionHold({ conversationId, desired, executor: anchor() })).not.toBeNull()
  })

  it('ignores a stale release after leaving the conversation', () => {
    const { controller } = setup()
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.beginLiveEdgeEntry({ conversationId: 'team@conference.fluux.chat', entryFacts: { syncedLiveEdge: false }, executor: live() })
    const current = controller.snapshot()
    controller.releaseInteractionHold({ conversationId, resume: true, liveEdge: live() })
    expect(controller.snapshot()).toBe(current)
  })
})

// Captain FLM-245 F3: cancelling a settle loop is not a pixel write.
it('FLM-245 does not bless unobserved movement when an interaction loop is superseded', () => {
  const { controller } = setup()
  const request = controller.beginInteractionHold({ conversationId, desired, executor: anchor() })!
  const session = new ViewportSession(conversationId, true)
  const before = { top: 393, height: 1000, client: 557 }
  const moved = { ...before, top: 413 }
  session.recordProgrammaticWrite(conversationId, 1000, before)
  const scroller = document.createElement('div')
  const ports = { getScroller: () => scroller, getVirtualizer: () => undefined }
  const record = vi.fn(() => session.recordProgrammaticWrite(conversationId, 1020, moved))
  const browser = new AnchorPreservationBrowserAdapter({
    ...ports, getActiveConversationId: () => conversationId,
    getWindowFacts: () => ({ hasRows: true, windowAtLiveEdge: true }),
    anchorAdapter: new BottomFractionAnchorBrowserAdapter(ports),
    beginLoop: () => null, setAtBottom: vi.fn(), rememberScrollSnapshot: vi.fn(),
    recordProgrammaticWrite: record, observeGeometry: vi.fn(),
  })
  browser.createExecutor('interaction-anchor').complete(request, 'superseded')
  expect(record).not.toHaveBeenCalled()
  expect(session.observeGeometry(conversationId, moved, {
    now: 1040, controllerOwnsPixels: true, interactionHeld: true,
  })?.userDelta).toBe(20)
})
