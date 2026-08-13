/**
 * Property tests for the positioning model's command sequences.
 *
 * The oracle is docs/2026-07-23-scroll-positioning-contract.md, not the code under test. Each
 * property below restates one sentence of that contract:
 *
 *   "Entry selects exactly one provisional request."
 *   "Async work tagged with a stale generation is ignored."
 *   "A delayed result from the room just left must never reactivate it."
 *   "a generation-guarded deactivation clears the current conversation, active request, and MDS
 *    eligibility while retaining the watermark."
 *   "The request's unavailable policy preserves source-specific behavior: ... explicit targets
 *    wait ..."
 *
 * Example tests pick the interleavings someone thought of. The bugs this model has produced in
 * practice (a latch reopened by a late callback, an entry window surviving a conversation switch)
 * are interleaving bugs, so the sequence is what has to be generated.
 *
 * Phases are derived from reachability facts rather than injected, so a generated sequence walks
 * the lifecycle the client can actually produce. The two describe blocks split along that seam:
 * the first drives command sequences through the model, the second pins how a single request and
 * a single set of facts resolve to a phase.
 */
import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import {
  acceptPositionRequest,
  advancePhaseIfCurrent,
  cancelReconciliationForUserInput,
  deactivateConversation,
  initialPositioningModel,
  messageFraction,
  pixelOffset,
  resolveReachability,
  settleUserPosition,
  type PositionRequest,
  type PositioningModel,
  type PositioningPhase,
  type ReachabilityFacts,
} from './scrollPositionModel'

// A two-conversation pool maximises interleaving between visits; more ids only dilute the search.
const CONVERSATIONS = ['room-a@example.test', 'room-b@example.test'] as const

/**
 * Generations are resolved when a command is applied, not when it is generated. A literal number
 * drawn upfront would almost always be stale by the time the fold reaches it, so nearly every
 * sequence would degenerate into no-ops and never exercise acceptance.
 */
type GenMode = 'ancient' | 'stale' | 'active' | 'next' | 'jump'

/**
 * Conversations are chosen relative to the model, not as literal ids, for the same reason as
 * generations: a fixed id is wrong as soon as an entry switches the displayed conversation, and
 * every non-entry command against a non-displayed conversation is rejected. Naming the id directly
 * drove ~94% of generated commands into the rejected path, leaving the interesting states — a
 * paused live-edge request, an open MDS window, an effective settle — barely reached.
 */
type ConvMode = 'current' | 'other'

/**
 * Reachability facts are paired with the request that asked for them. An executor resolving a
 * live-edge request is handed `global-live-edge` facts; one resolving an anchor or message target is
 * handed a per-row index or an absence. The client cannot produce the crossed pairings, and feeding
 * them in would populate the search with impossible states — a message target reported as
 * `global-live-edge` resolves to `unavailable`, which would defeat the "explicit targets wait" rule
 * for a reason that cannot happen.
 */
const EDGE_SHAPES = [
  'empty-window',
  'edge-resident-mounted',
  'edge-resident-unmounted',
  'edge-recenter-available',
  'edge-recentering',
  'edge-unavailable',
] as const

const TARGET_SHAPES = [
  'empty-window',
  'absent-load-available',
  'absent-loading',
  'absent-exhausted',
  'available-mounted',
  'available-unmounted',
  'available-abandoned',
] as const

type FactsShape = (typeof EDGE_SHAPES)[number] | (typeof TARGET_SHAPES)[number]

const ALL_SHAPES: readonly FactsShape[] = [
  ...new Set<FactsShape>([...EDGE_SHAPES, ...TARGET_SHAPES]),
]

function factsFor(desired: PositionRequest['desired'], shape: FactsShape): ReachabilityFacts {
  const wantsEdge = desired.kind === 'live-edge'
  const family: readonly FactsShape[] = wantsEdge ? EDGE_SHAPES : TARGET_SHAPES
  // A shape drawn for the other family is remapped by position rather than dropped, so every draw
  // still lands somewhere useful instead of collapsing onto one fact.
  const picked = family.includes(shape)
    ? shape
    : family[Math.max(0, ALL_SHAPES.indexOf(shape)) % family.length]

  switch (picked) {
    case 'empty-window':
      return { kind: 'empty-window' }
    case 'absent-load-available':
      return { kind: 'target-absent', loadAround: 'available' }
    case 'absent-loading':
      return { kind: 'target-absent', loadAround: 'loading' }
    case 'absent-exhausted':
      return { kind: 'target-absent', loadAround: 'exhausted' }
    case 'available-mounted':
      return { kind: 'available', index: 12, mounted: true, placement: 'viable' }
    case 'available-unmounted':
      return { kind: 'available', index: 12, mounted: false, placement: 'viable' }
    case 'available-abandoned':
      return { kind: 'available', index: 12, mounted: true, placement: 'use-unavailable-policy' }
    case 'edge-resident-mounted':
      return { kind: 'global-live-edge', state: { kind: 'resident-tail', index: 42, mounted: true } }
    case 'edge-resident-unmounted':
      return { kind: 'global-live-edge', state: { kind: 'resident-tail', index: 42, mounted: false } }
    case 'edge-recenter-available':
      return { kind: 'global-live-edge', state: { kind: 'recenter-available' } }
    case 'edge-recentering':
      return { kind: 'global-live-edge', state: { kind: 'recentering' } }
    case 'edge-unavailable':
      return { kind: 'global-live-edge', state: { kind: 'unavailable' } }
  }
}

function resolveConversation(model: PositioningModel, mode: ConvMode): string {
  const current = model.currentConversationId ?? CONVERSATIONS[0]
  if (mode === 'current') return current
  return CONVERSATIONS.find((c) => c !== current) ?? CONVERSATIONS[1]
}

type Cmd =
  | { t: 'entry'; conv: ConvMode; reason: EntryReason; gen: GenMode }
  | { t: 'userNav'; conv: ConvMode; reason: UserNavReason; gen: GenMode }
  | { t: 'liveUpdate'; conv: ConvMode; gen: GenMode }
  | { t: 'lateMds'; conv: ConvMode; gen: GenMode }
  | { t: 'layoutPreservation'; conv: ConvMode; gen: GenMode }
  | { t: 'historyPreservation'; conv: ConvMode; gen: GenMode }
  // Phases are derived, never invented. The controller only ever sets a phase from
  // resolveReachability, from position-applied, from the directional-history window shift, or from
  // settling an explicit target. Injecting arbitrary phases would generate sequences the client
  // cannot produce (settled -> mounting) while missing the ones it does.
  | { t: 'resolve'; conv: ConvMode; gen: GenMode; facts: FactsShape }
  | { t: 'markApplied'; conv: ConvMode; gen: GenMode }
  | { t: 'windowShift'; conv: ConvMode; gen: GenMode }
  | { t: 'settleExplicit'; conv: ConvMode; gen: GenMode }
  | { t: 'cancelInput'; conv: ConvMode; gen: GenMode }
  | { t: 'settle'; conv: ConvMode; atLiveEdge: boolean; rearm: boolean; gen: GenMode }
  | { t: 'deactivate'; conv: ConvMode; gen: GenMode }

type EntryReason = 'saved-position' | 'unread-marker' | 'live-edge' | 'synced-live-edge'
type UserNavReason = 'message-target' | 'unread-marker' | 'live-edge' | 'resident-top'

const LIVE_EDGE = { kind: 'live-edge', follow: true } as const

function resolveGeneration(model: PositioningModel, mode: GenMode): number {
  switch (mode) {
    // A generation the model has long since passed, as an async completion from an earlier visit.
    case 'ancient':
      return 1
    // Strictly behind the watermark: the boundary the "stale work is ignored" rule is written for.
    case 'stale':
      return Math.max(1, model.watermark - 1)
    // Exactly the watermark: a duplicate, which acceptance must also refuse.
    case 'active':
      return model.active?.request.generation ?? Math.max(1, model.watermark)
    case 'next':
      return model.watermark + 1
    case 'jump':
      return model.watermark + 3
  }
}

function entryRequest(conv: string, generation: number, reason: EntryReason): PositionRequest {
  switch (reason) {
    case 'saved-position':
      return {
        generation,
        conversationId: conv,
        source: { kind: 'entry', reason: 'saved-position' },
        desired: {
          kind: 'anchor',
          messageId: 'saved-msg',
          placement: { kind: 'bottom-fraction', fraction: messageFraction(1) },
        },
        onUnavailable: { kind: 'live-edge' },
      }
    case 'unread-marker':
      return {
        generation,
        conversationId: conv,
        source: { kind: 'entry', reason: 'unread-marker' },
        desired: { kind: 'message', messageId: 'first-unread', align: 'start' },
        onUnavailable: { kind: 'live-edge' },
      }
    case 'live-edge':
      return {
        generation,
        conversationId: conv,
        source: { kind: 'entry', reason: 'live-edge' },
        desired: LIVE_EDGE,
      }
    case 'synced-live-edge':
      return {
        generation,
        conversationId: conv,
        source: { kind: 'entry', reason: 'synced-live-edge' },
        desired: LIVE_EDGE,
      }
  }
}

function userNavRequest(conv: string, generation: number, reason: UserNavReason): PositionRequest {
  switch (reason) {
    case 'message-target':
      return {
        generation,
        conversationId: conv,
        source: { kind: 'user-navigation', reason: 'message-target' },
        desired: { kind: 'message', messageId: 'target', align: 'center' },
        onUnavailable: { kind: 'wait' },
      }
    case 'unread-marker':
      return {
        generation,
        conversationId: conv,
        source: { kind: 'user-navigation', reason: 'unread-marker' },
        desired: { kind: 'message', messageId: 'first-unread', align: 'top-third' },
        onUnavailable: { kind: 'live-edge' },
      }
    case 'live-edge':
      return {
        generation,
        conversationId: conv,
        source: { kind: 'user-navigation', reason: 'live-edge' },
        desired: LIVE_EDGE,
      }
    case 'resident-top':
      return {
        generation,
        conversationId: conv,
        source: { kind: 'user-navigation', reason: 'resident-top' },
        desired: { kind: 'resident-top' },
      }
  }
}

function liveEdgeRearm(conv: string, generation: number) {
  return {
    generation,
    conversationId: conv,
    source: { kind: 'user-navigation', reason: 'live-edge' },
    desired: LIVE_EDGE,
  } as Extract<PositionRequest, { source: { kind: 'user-navigation'; reason: 'live-edge' } }>
}

function apply(model: PositioningModel, cmd: Cmd): PositioningModel {
  const generation = resolveGeneration(model, cmd.gen)
  const conv = resolveConversation(model, cmd.conv)
  switch (cmd.t) {
    case 'entry':
      return acceptPositionRequest(model, entryRequest(conv, generation, cmd.reason))
    case 'userNav':
      return acceptPositionRequest(model, userNavRequest(conv, generation, cmd.reason))
    case 'liveUpdate':
      return acceptPositionRequest(model, {
        generation,
        conversationId: conv,
        source: { kind: 'live-update', reason: 'outgoing-message' },
        desired: LIVE_EDGE,
      })
    case 'lateMds':
      return acceptPositionRequest(model, {
        generation,
        conversationId: conv,
        source: { kind: 'late-mds-supersession', reason: 'read-pointer-at-live-edge' },
        desired: LIVE_EDGE,
      })
    case 'layoutPreservation':
      return acceptPositionRequest(model, {
        generation,
        conversationId: conv,
        source: { kind: 'layout-preservation', reason: 'divider-mutation' },
        desired: {
          kind: 'anchor',
          messageId: 'anchor-row',
          placement: { kind: 'bottom-fraction', fraction: messageFraction(0.5) },
        },
        onUnavailable: { kind: 'warn-and-stop' },
      })
    case 'historyPreservation':
      return acceptPositionRequest(model, {
        generation,
        conversationId: conv,
        source: { kind: 'history-preservation', reason: 'window-shift' },
        desired: {
          kind: 'anchor',
          messageId: 'anchor-row',
          placement: { kind: 'top-offset', offsetPx: pixelOffset(12) },
        },
        onUnavailable: { kind: 'distance-from-bottom', distancePx: pixelOffset(200) },
      })
    case 'resolve': {
      // An executor resolves reachability for the request it owns, then tries to apply the result.
      // A stale generation is rejected by advancePhaseIfCurrent, exactly as in the controller.
      const active = model.active
      if (!active) return model
      const phase = resolveReachability(active.request, factsFor(active.request.desired, cmd.facts))
      return advancePhaseIfCurrent(model, conv, generation, phase)
    }
    case 'markApplied':
      return advancePhaseIfCurrent(model, conv, generation, { kind: 'position-applied' })
    case 'windowShift':
      return advancePhaseIfCurrent(model, conv, generation, { kind: 'pending', reason: 'window-shift' })
    case 'settleExplicit':
      return advancePhaseIfCurrent(model, conv, generation, { kind: 'settled' })
    case 'cancelInput':
      return cancelReconciliationForUserInput(model, conv, generation)
    case 'settle':
      return settleUserPosition(
        model,
        conv,
        generation,
        cmd.atLiveEdge,
        // The rearm carries a generation of its own, always newer than the watermark.
        cmd.rearm ? liveEdgeRearm(conv, model.watermark + 1) : undefined,
      )
    case 'deactivate':
      return deactivateConversation(model, conv, generation)
  }
}

// ---------------------------------------------------------------- generators

/**
 * Both of these are weighted, not uniform. A uniform draw spends most of its budget on commands the
 * model rejects outright, which tests the guards but never reaches the states behind them. The
 * weights keep the stale and cross-conversation paths well represented while making the accepted
 * path the common case, so sequences get deep enough to pause, settle, and correct.
 */
const conv = fc.oneof(
  { weight: 4, arbitrary: fc.constant<ConvMode>('current') },
  { weight: 1, arbitrary: fc.constant<ConvMode>('other') },
)
const gen = fc.oneof(
  { weight: 5, arbitrary: fc.constant<GenMode>('next') },
  { weight: 2, arbitrary: fc.constant<GenMode>('jump') },
  { weight: 2, arbitrary: fc.constant<GenMode>('stale') },
  { weight: 1, arbitrary: fc.constant<GenMode>('active') },
  { weight: 1, arbitrary: fc.constant<GenMode>('ancient') },
)

/**
 * Phase advances mostly carry the active generation, since a real completion belongs to the request
 * that issued it; the stale modes above still exercise the reject path.
 */
const advanceGen = fc.oneof(
  { weight: 6, arbitrary: fc.constant<GenMode>('active') },
  { weight: 2, arbitrary: fc.constant<GenMode>('stale') },
  { weight: 1, arbitrary: fc.constant<GenMode>('ancient') },
  { weight: 1, arbitrary: fc.constant<GenMode>('next') },
)

const factsShape = fc.constantFrom<FactsShape>(...ALL_SHAPES)

const entryCmd: fc.Arbitrary<Cmd> = fc.record({
  t: fc.constant('entry' as const),
  conv,
  reason: fc.constantFrom<EntryReason>('saved-position', 'unread-marker', 'live-edge', 'synced-live-edge'),
  gen,
})

const nonEntryCmd: fc.Arbitrary<Cmd> = fc.oneof(
  // Reachability resolution is weighted up: it is what an executor does most, and the only command
  // that walks a request through the pending / loading / mounting part of the lifecycle.
  {
    weight: 5,
    arbitrary: fc.record({ t: fc.constant('resolve' as const), conv, gen: advanceGen, facts: factsShape }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('userNav' as const),
      conv,
      reason: fc.constantFrom<UserNavReason>('message-target', 'unread-marker', 'live-edge', 'resident-top'),
      gen,
    }),
  },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('markApplied' as const), conv, gen: advanceGen }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('cancelInput' as const), conv, gen: advanceGen }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('settle' as const),
      conv,
      atLiveEdge: fc.boolean(),
      rearm: fc.boolean(),
      gen: advanceGen,
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('liveUpdate' as const), conv, gen }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('lateMds' as const), conv, gen }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('layoutPreservation' as const), conv, gen }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('historyPreservation' as const), conv, gen }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('windowShift' as const), conv, gen: advanceGen }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('settleExplicit' as const), conv, gen: advanceGen }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('deactivate' as const), conv, gen: advanceGen }) },
)

const anyCmd: fc.Arbitrary<Cmd> = fc.oneof({ weight: 1, arbitrary: entryCmd }, { weight: 3, arbitrary: nonEntryCmd })
const script = fc.array(anyCmd, { maxLength: 40 })

/** Fold a script, checking every structural invariant after each step. */
function run(commands: Cmd[], check: (next: PositioningModel, prev: PositioningModel, cmd: Cmd, i: number) => void) {
  let model = initialPositioningModel()
  commands.forEach((cmd, i) => {
    const prev = model
    model = apply(model, cmd)
    check(model, prev, cmd, i)
  })
  return model
}

// ---------------------------------------------------------------- properties

describe('PositioningModel command sequences (properties)', () => {
  it('holds the structural invariants after every command', () => {
    fc.assert(
      fc.property(script, (commands) => {
        run(commands, (m) => {
          // The watermark is a monotonic token; nothing may rewind it.
          expect(Number.isSafeInteger(m.watermark)).toBe(true)

          if (m.active) {
            // "Entry selects exactly one provisional request" — the one active request is always
            // the highest generation accepted so far, otherwise a stale completion could match it.
            expect(m.active.request.generation).toBe(m.watermark)
            // Nothing may position a conversation that is not the displayed one.
            expect(m.active.request.conversationId).toBe(m.currentConversationId)
          }

          // Late-MDS eligibility belongs to the displayed visit, never to a conversation left behind.
          if (m.lateMdsEligibleFor !== null) {
            expect(m.lateMdsEligibleFor).toBe(m.currentConversationId)
          }
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('never rewinds the watermark', () => {
    fc.assert(
      fc.property(script, (commands) => {
        run(commands, (m, prev) => {
          expect(m.watermark).toBeGreaterThanOrEqual(prev.watermark)
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('closes the late-MDS window for good until the next entry', () => {
    // "After takeover, explicit navigation, outgoing send, or one accepted MDS correction, the
    // late-MDS entry window closes. A delayed result from the room just left must never reactivate
    // it." Only an entry request may reopen it, so a script with no entry must never see it reopen.
    fc.assert(
      fc.property(entryCmd, fc.array(nonEntryCmd, { maxLength: 25 }), (seed, rest) => {
        let model = apply(initialPositioningModel(), seed)
        for (const cmd of rest) {
          const prev = model
          model = apply(model, cmd)
          if (prev.lateMdsEligibleFor === null) {
            expect(model.lateMdsEligibleFor).toBeNull()
          }
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('closes the late-MDS window on takeover, navigation, send, or an accepted correction', () => {
    // The other half of the latch. The property above says the window never reopens; this one says
    // it actually shuts. A latch that never closes reopens nothing and would slip past that test.
    const closingKinds = new Set(['userNav', 'liveUpdate', 'lateMds'])
    fc.assert(
      fc.property(script, (commands) => {
        run(commands, (m, prev, cmd) => {
          const accepted = m.watermark > prev.watermark
          if (closingKinds.has(cmd.t) && accepted) {
            expect(m.lateMdsEligibleFor).toBeNull()
          }
          // Genuine user input is takeover, whether or not it cancels the active request.
          if (cmd.t === 'cancelInput' && m !== prev) {
            expect(m.lateMdsEligibleFor).toBeNull()
          }
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('accepts a late-MDS correction only while its entry window is open', () => {
    // "Before genuine user takeover, an accepted MDS positioning correction is limited to the
    // currently displayed conversation and only while that provisional entry remains eligible."
    //
    // The safety direction is what matters: an ineligible correction must be an exact no-op, not
    // merely harmless. A correction that lands after the window shut is what retires a divider the
    // reader is still using.
    fc.assert(
      fc.property(script, (commands) => {
        run(commands, (m, prev, cmd) => {
          if (cmd.t === 'lateMds' && prev.lateMdsEligibleFor !== resolveConversation(prev, cmd.conv)) {
            expect(m).toEqual(prev)
          }
        })
      }),
      { numRuns: 2000 },
    )
  })

  it('ignores async work tagged with a stale generation', () => {
    // "Async work tagged with a stale generation is ignored." Every async completion must be an
    // exact no-op when it arrives late, not merely harmless. A settle carries the generation of the
    // pause it was taken for, so a settle from an earlier pause cannot cancel its successor.
    fc.assert(
      fc.property(script, conv, factsShape, (commands, staleConv, shape) => {
        const model = run(commands, () => {})
        if (!model.active) return
        const staleGen = model.watermark - 1
        if (staleGen < 1) return

        // The phase a late executor would have computed for the request it still believes is its own.
        const stalePhase: PositioningPhase = resolveReachability(
          model.active.request,
          factsFor(model.active.request.desired, shape),
        )
        const staleConvId = resolveConversation(model, staleConv)
        expect(advancePhaseIfCurrent(model, staleConvId, staleGen, stalePhase)).toEqual(model)
        expect(cancelReconciliationForUserInput(model, staleConvId, staleGen)).toEqual(model)
        expect(deactivateConversation(model, staleConvId, staleGen)).toEqual(model)
        expect(settleUserPosition(model, staleConvId, staleGen, true)).toEqual(model)
        expect(settleUserPosition(model, staleConvId, staleGen, false)).toEqual(model)
      }),
      { numRuns: 2000 },
    )
  })

  it('retains the watermark when a deactivation clears the visit', () => {
    // "a generation-guarded deactivation clears the current conversation, active request, and MDS
    // eligibility while retaining the watermark."
    fc.assert(
      fc.property(script, (commands) => {
        const model = run(commands, () => {})
        if (model.currentConversationId === null) return

        const after = deactivateConversation(model, model.currentConversationId, model.watermark)
        expect(after.currentConversationId).toBeNull()
        expect(after.active).toBeNull()
        expect(after.lateMdsEligibleFor).toBeNull()
        expect(after.watermark).toBe(model.watermark)
      }),
      { numRuns: 2000 },
    )
  })

  it('rejects every callback from a conversation that was left', () => {
    // A delayed result from the room just left must not touch the new visit.
    fc.assert(
      fc.property(script, nonEntryCmd, (commands, late) => {
        const model = run(commands, () => {})
        if (model.currentConversationId === null) return

        // 'other' resolves to whichever conversation is not the displayed one.
        const after = apply(model, { ...late, conv: 'other' })
        expect(after).toEqual(model)
      }),
      { numRuns: 2000 },
    )
  })
})

describe('reachability resolution (properties)', () => {
  // Every request kind the model can hold, paired with facts its own executor could produce.
  const anyRequest: fc.Arbitrary<PositionRequest> = fc.oneof(
    fc.constantFrom<EntryReason>('saved-position', 'unread-marker', 'live-edge', 'synced-live-edge').map((r) =>
      entryRequest(CONVERSATIONS[0], 1, r),
    ),
    fc.constantFrom<UserNavReason>('message-target', 'unread-marker', 'live-edge', 'resident-top').map((r) =>
      userNavRequest(CONVERSATIONS[0], 1, r),
    ),
  )

  const resolved = fc
    .tuple(anyRequest, factsShape)
    .map(([request, shape]) => ({
      request,
      facts: factsFor(request.desired, shape),
      phase: resolveReachability(request, factsFor(request.desired, shape)),
    }))

  it('makes an explicit target wait rather than declaring it unavailable', () => {
    // "explicit targets wait" — a request carrying the wait policy has somewhere to come back to, so
    // giving up on it would strand a reader who asked to go to a specific message.
    fc.assert(
      fc.property(resolved, ({ request, phase }) => {
        if (request.onUnavailable?.kind !== 'wait') return
        expect(phase.kind).not.toBe('unavailable')
      }),
      { numRuns: 2000 },
    )
  })

  it('gives an unavailable phase the policy its request declared', () => {
    // "The request's unavailable policy preserves source-specific behavior." A resolution may not
    // substitute a different fallback for the one the source asked for.
    fc.assert(
      fc.property(resolved, ({ request, phase }) => {
        if (phase.kind !== 'unavailable' || request.onUnavailable === undefined) return
        expect(phase.policy).toEqual(request.onUnavailable)
      }),
      { numRuns: 2000 },
    )
  })

  it('loads around the message the request actually asked for', () => {
    fc.assert(
      fc.property(resolved, ({ request, phase }) => {
        if (phase.kind !== 'loading-around') return
        const desired = request.desired
        expect(desired.kind === 'anchor' || desired.kind === 'message').toBe(true)
        if (desired.kind === 'anchor' || desired.kind === 'message') {
          expect(phase.messageId).toBe(desired.messageId)
        }
      }),
      { numRuns: 2000 },
    )
  })

  it('never sends a live-edge request to load around a message', () => {
    // Following the tail has no message to centre on; a loading-around phase here would be a
    // request waiting on a fetch that can never be issued.
    fc.assert(
      fc.property(resolved, ({ request, phase }) => {
        if (request.desired.kind !== 'live-edge') return
        expect(phase.kind).not.toBe('loading-around')
      }),
      { numRuns: 2000 },
    )
  })

  it('treats an empty window as pending for every request kind', () => {
    fc.assert(
      fc.property(anyRequest, (request) => {
        expect(resolveReachability(request, { kind: 'empty-window' })).toEqual({
          kind: 'pending',
          reason: 'empty-window',
        })
      }),
      { numRuns: 500 },
    )
  })
})
