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
 *
 * Example tests pick the interleavings someone thought of. The bugs this model has produced in
 * practice (a latch reopened by a late callback, an entry window surviving a conversation switch)
 * are interleaving bugs, so the sequence is what has to be generated.
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
  settleUserPosition,
  type PositionRequest,
  type PositioningModel,
  type PositioningPhase,
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
  | { t: 'advance'; conv: ConvMode; gen: GenMode; phase: PositioningPhase }
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
    case 'advance':
      return advancePhaseIfCurrent(model, conv, generation, cmd.phase)
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

const phase = fc.oneof(
  fc.constant<PositioningPhase>({ kind: 'resolving' }),
  fc.constant<PositioningPhase>({ kind: 'reconciling' }),
  fc.constant<PositioningPhase>({ kind: 'position-applied' }),
  fc.constant<PositioningPhase>({ kind: 'settled' }),
  fc.constant<PositioningPhase>({ kind: 'recentering-live-edge' }),
  fc.constant<PositioningPhase>({ kind: 'paused-user-input' }),
  fc.record({ kind: fc.constant('mounting' as const), index: fc.nat({ max: 50 }) }),
  fc.record({ kind: fc.constant('loading-around' as const), messageId: fc.constant('m-1') }),
  fc.record({
    kind: fc.constant('pending' as const),
    reason: fc.constantFrom('empty-window', 'around-load', 'live-edge-recenter', 'target-not-indexed', 'window-shift'),
  }) as fc.Arbitrary<PositioningPhase>,
)

const entryCmd: fc.Arbitrary<Cmd> = fc.record({
  t: fc.constant('entry' as const),
  conv,
  reason: fc.constantFrom<EntryReason>('saved-position', 'unread-marker', 'live-edge', 'synced-live-edge'),
  gen,
})

const nonEntryCmd: fc.Arbitrary<Cmd> = fc.oneof(
  fc.record({
    t: fc.constant('userNav' as const),
    conv,
    reason: fc.constantFrom<UserNavReason>('message-target', 'unread-marker', 'live-edge', 'resident-top'),
    gen,
  }),
  fc.record({ t: fc.constant('liveUpdate' as const), conv, gen }),
  fc.record({ t: fc.constant('lateMds' as const), conv, gen }),
  fc.record({ t: fc.constant('layoutPreservation' as const), conv, gen }),
  fc.record({ t: fc.constant('historyPreservation' as const), conv, gen }),
  fc.record({ t: fc.constant('advance' as const), conv, gen: advanceGen, phase }),
  fc.record({ t: fc.constant('cancelInput' as const), conv, gen: advanceGen }),
  fc.record({
    t: fc.constant('settle' as const),
    conv,
    atLiveEdge: fc.boolean(),
    rearm: fc.boolean(),
    gen: advanceGen,
  }),
  fc.record({ t: fc.constant('deactivate' as const), conv, gen: advanceGen }),
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
      fc.property(script, conv, phase, (commands, staleConv, stalePhase) => {
        const model = run(commands, () => {})
        if (!model.active) return
        const staleGen = model.watermark - 1
        if (staleGen < 1) return

        expect(advancePhaseIfCurrent(model, staleConv, staleGen, stalePhase)).toEqual(model)
        expect(cancelReconciliationForUserInput(model, staleConv, staleGen)).toEqual(model)
        expect(deactivateConversation(model, staleConv, staleGen)).toEqual(model)
        expect(settleUserPosition(model, staleConv, staleGen, true)).toEqual(model)
        expect(settleUserPosition(model, staleConv, staleGen, false)).toEqual(model)
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
