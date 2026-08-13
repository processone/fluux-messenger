/**
 * Conformance across the seven positioning executors.
 *
 * The controller runs seven near-identical executor state machines — saved position, unread marker,
 * explicit target, resident top, live edge, anchor preservation, directional history — and nothing
 * makes them agree. Their guards are byte-identical modulo the field name, their cancel paths are
 * written in three different shapes, and an eighth intent would be written by copying whichever one
 * the author happened to open.
 *
 * What they genuinely share is the lease: every executor receives one through `beginLoop`, and every
 * frame it runs is authorised by that lease. So the lease is where conformance can be stated. Each
 * case below starts one executor through its public entry point and captures the lease its own
 * `beginLoop` was handed; the assertions are then written once and run against all seven.
 *
 * This deliberately does not compare frame-positioning behaviour. Resident top drives with a one-shot
 * `start` and the others with a per-frame `positionFrame`, which is a real difference in what they
 * do, not drift. The lease contract is the part that must not diverge.
 *
 * SCOPE, established by mutation rather than assumed. These tests pin the OUTCOME — a lease stops
 * authorising work once its execution is gone — not HOW each executor decides it. Each lease guard
 * is a conjunction of three conditions:
 *
 *     !signal.aborted && this.<slot> === execution && execution.operation === operation
 *
 * (four of the seven also re-check the request's conversation and generation). Those conditions are
 * MUTUALLY REDUNDANT under every publicly reachable scenario: invalidating a lease clears the slot,
 * advances the model generation and aborts the signal all at once, so each condition alone is enough
 * and no single-condition mutation is detectable. Removing the abort check, the slot check or the
 * model-generation check from one executor each leaves every test here green; neutralising a whole
 * guard fails exactly that executor's three behavioural cases, which is the floor these tests hold.
 *
 * The conditions would separate if an execution began a SECOND operation while staying in its slot,
 * but no public entry point does that. `refreshLiveEdge` and `refreshExplicitTarget` look like the
 * path and are not: they re-drive only when `!execution.loop`, and with no loop there is no earlier
 * lease to invalidate. So the extra conditions are defensive depth against a state the public
 * surface cannot produce — worth knowing before the seven are consolidated, since unifying guards
 * that are already over-determined cannot change reachable behaviour.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PositioningController,
  type AnchorPreservationExecutor,
  type DirectionalHistoryExecutor,
  type ExplicitTargetExecutor,
  type LiveEdgeExecutor,
  type PositionExecutionLease,
  type PositionFrameLoop,
  type ResidentTopExecutor,
  type SavedPositionExecutor,
  type UnreadMarkerExecutor,
} from './positioningController'
import {
  messageFraction,
  pixelOffset,
  type BottomFractionAnchorPosition,
  type EntryPositionFacts,
  type ReachabilityFacts,
  type TopOffsetAnchorPosition,
} from './scrollPositionModel'

const conversationId = 'room@example.test'

const mountedRow: ReachabilityFacts = {
  kind: 'available',
  index: 4,
  mounted: true,
  placement: 'viable',
}

const residentTail: ReachabilityFacts = {
  kind: 'global-live-edge',
  state: { kind: 'resident-tail', index: 9, mounted: true },
}

const savedAnchor: BottomFractionAnchorPosition = {
  kind: 'anchor',
  messageId: 'saved-row',
  placement: { kind: 'bottom-fraction', fraction: messageFraction(0.5) },
}

const topAnchor: TopOffsetAnchorPosition = {
  kind: 'anchor',
  messageId: 'top-row',
  placement: { kind: 'top-offset', offsetPx: pixelOffset(24) },
}

/** Entry facts that make selectEntryPosition choose each of the three entry sources. */
const entryFacts = {
  saved: { syncedLiveEdge: false, savedAnchor } satisfies EntryPositionFacts,
  unread: {
    syncedLiveEdge: false,
    firstUnreadMessageId: 'first-unread',
    unreadMarkerAlign: 'start',
  } satisfies EntryPositionFacts,
  live: { syncedLiveEdge: false } satisfies EntryPositionFacts,
}

/** Collects the lease each executor is handed, and keeps the loop inert so no frame ever runs. */
function leaseCollector() {
  const leases: PositionExecutionLease[] = []
  const loop: PositionFrameLoop = {
    schedule: () => {},
    recordFrame: () => {},
    finish: () => {},
  }
  return {
    leases,
    beginLoop: (lease: PositionExecutionLease) => {
      leases.push(lease)
      return loop
    },
  }
}

interface Started {
  lease: PositionExecutionLease
  generation: number
}

/**
 * One entry per executor. `start` drives the controller through that executor's public entry point
 * and returns the lease it issued, so every assertion below is written against the same shape.
 */
const EXECUTORS: Array<{ name: string; start: (c: PositioningController) => Started }> = [
  {
    name: 'saved position',
    start: (controller) => {
      const collector = leaseCollector()
      const executor: SavedPositionExecutor = {
        reachability: () => mountedRow,
        liveEdge: liveEdgeExecutor(leaseCollector()),
        beginLoop: collector.beginLoop,
        positionFrame: () => ({ kind: 'positioned', scrollTop: 400, reassert: true }),
        complete: vi.fn(),
      }
      const request = controller.beginSavedPositionEntry({
        conversationId,
        entryFacts: entryFacts.saved,
        executor,
      })
      return started(request, collector)
    },
  },
  {
    name: 'unread marker',
    start: (controller) => {
      const collector = leaseCollector()
      const executor: UnreadMarkerExecutor = {
        reachability: () => mountedRow,
        beginLoop: collector.beginLoop,
        readScrollTop: () => 0,
        positionFrame: () => ({ kind: 'positioned', scrollTop: 400, atLiveEdge: false }),
        liveEdge: liveEdgeExecutor(leaseCollector()),
      }
      const request = controller.beginUnreadMarkerEntry({
        conversationId,
        entryFacts: entryFacts.unread,
        executor,
      })
      return started(request, collector)
    },
  },
  {
    name: 'live edge',
    start: (controller) => {
      const collector = leaseCollector()
      const request = controller.beginLiveEdgeEntry({
        conversationId,
        entryFacts: entryFacts.live,
        executor: liveEdgeExecutor(collector),
      })
      return started(request, collector)
    },
  },
  {
    name: 'explicit target',
    start: (controller) => {
      enterConversation(controller)
      const collector = leaseCollector()
      const executor: ExplicitTargetExecutor = {
        reachability: () => mountedRow,
        beginLoop: collector.beginLoop,
        readScrollTop: () => 0,
        positionFrame: () => ({ kind: 'positioned', scrollTop: 400, wrote: true }),
        complete: vi.fn(),
      }
      const request = controller.beginExplicitTarget({
        conversationId,
        messageId: 'target-row',
        executor,
      })
      return started(request, collector)
    },
  },
  {
    name: 'resident top',
    start: (controller) => {
      enterConversation(controller)
      const collector = leaseCollector()
      const executor: ResidentTopExecutor = {
        reachability: () => mountedRow,
        beginLoop: collector.beginLoop,
        start: () => ({ kind: 'started' }),
        readScrollTop: () => 640,
        complete: vi.fn(),
      }
      const request = controller.beginResidentTopNavigation({ conversationId, executor })
      return started(request, collector)
    },
  },
  {
    name: 'anchor preservation',
    start: (controller) => {
      enterConversation(controller)
      const collector = leaseCollector()
      const executor: AnchorPreservationExecutor = {
        reachability: () => mountedRow,
        beginLoop: collector.beginLoop,
        positionFrame: () => ({ kind: 'positioned', scrollTop: 400, reassert: true }),
        complete: vi.fn(),
      }
      const request = controller.beginMediaPreservation({
        conversationId,
        desired: savedAnchor,
        executor,
      })
      return started(request, collector)
    },
  },
  {
    name: 'directional history',
    start: (controller) => {
      enterConversation(controller)
      const collector = leaseCollector()
      const executor: DirectionalHistoryExecutor = {
        reachability: () => mountedRow,
        beginLoop: collector.beginLoop,
        positionFrame: () => ({ kind: 'positioned', scrollTop: 400, wrote: true, reassert: true }),
        complete: vi.fn(),
      }
      // Unlike the others, a window shift parks in pending until the batch lands; the position —
      // and so the lease — only exists once reconciliation runs.
      const request = controller.beginDirectionalHistory({
        conversationId,
        desired: topAnchor,
        distanceFromBottom: pixelOffset(320),
        executor,
      })
      expect(request, 'the window shift must be accepted').not.toBeNull()
      controller.reconcileDirectionalHistory({
        conversationId,
        generation: request!.generation,
        executor,
      })
      return started(request, collector)
    },
  },
]

function liveEdgeExecutor(collector: ReturnType<typeof leaseCollector>): LiveEdgeExecutor {
  return {
    reachability: () => residentTail,
    beginLoop: collector.beginLoop,
    positionFrame: () => ({ kind: 'positioned', scrollTop: 1000, atLiveEdge: true, wrote: true, reassert: true }),
    complete: vi.fn(),
  }
}

/** A live-edge entry, so non-entry requests have a displayed conversation to attach to. */
function enterConversation(controller: PositioningController) {
  controller.beginLiveEdgeEntry({
    conversationId,
    entryFacts: entryFacts.live,
    executor: liveEdgeExecutor(leaseCollector()),
  })
}

function started(
  request: { generation: number } | null,
  collector: ReturnType<typeof leaseCollector>,
): Started {
  expect(request, 'the executor must accept its own entry point').not.toBeNull()
  const lease = collector.leases.at(-1)
  expect(lease, 'every executor must be handed a lease through beginLoop').toBeDefined()
  return { lease: lease!, generation: request!.generation }
}

describe.each(EXECUTORS)('$name lease', ({ start }) => {
  it('describes the request that issued it', () => {
    const controller = new PositioningController()
    const { lease, generation } = start(controller)

    expect(lease.conversationId).toBe(conversationId)
    expect(lease.generation).toBe(generation)
    expect(lease.signal.aborted).toBe(false)
  })

  it('is current while it owns the position', () => {
    const controller = new PositioningController()
    const { lease } = start(controller)

    expect(lease.isCurrent()).toBe(true)
  })

  it('stops being current once the conversation is deactivated', () => {
    const controller = new PositioningController()
    const { lease, generation } = start(controller)

    controller.deactivate(conversationId, generation)

    expect(lease.isCurrent()).toBe(false)
  })

  it('stops being current once a newer request supersedes it', () => {
    const controller = new PositioningController()
    const { lease } = start(controller)

    // An explicit target is user navigation: it supersedes whatever holds the position.
    const collector = leaseCollector()
    controller.beginExplicitTarget({
      conversationId,
      messageId: 'a-newer-target',
      executor: {
        reachability: () => mountedRow,
        beginLoop: collector.beginLoop,
        readScrollTop: () => 0,
        positionFrame: () => ({ kind: 'positioned', scrollTop: 400, wrote: true }),
        complete: vi.fn(),
      },
    })

    expect(lease.isCurrent()).toBe(false)
  })

  it('refuses to advance the phase once it is no longer current', () => {
    // The lease is the authority a frame checks before writing. A superseded one that still
    // reported success would let a finished executor move the phase of its successor.
    const controller = new PositioningController()
    const { lease, generation } = start(controller)
    controller.deactivate(conversationId, generation)
    const before = controller.snapshot()

    expect(lease.markApplied()).toBe(false)
    expect(lease.settle()).toBe(false)
    expect(controller.snapshot()).toEqual(before)
  })
})
