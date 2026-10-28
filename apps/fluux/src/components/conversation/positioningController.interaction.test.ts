// Intent: FLM-229's accepted interaction anchor must outlive every ambient positioning stimulus.
import { describe, expect, it, vi } from 'vitest'
import { PositioningController, type AnchorPreservationExecutor, type LiveEdgeExecutor } from './positioningController'
import { messageFraction, pixelOffset } from './scrollPositionModel'

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
  it('manual input ends the interaction without automatic release-resume or geometry rearm', () => {
    const { controller, close } = setup()
    controller.beginInteractionHold({ conversationId, desired, executor: anchor() })
    controller.observeUserInput(conversationId)
    expect(close).toHaveBeenCalledOnce()
    const position = vi.fn()
    controller.releaseInteractionHold({ conversationId, resume: true, liveEdge: live(position) })
    expect(controller.reconcileLiveEdge({ conversationId, executor: live(position), rearmEligibleFromGeometry: true })).toBe(false)
    expect(position).not.toHaveBeenCalled()
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
