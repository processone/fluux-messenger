import { describe, expect, it } from 'vitest'
import {
  PositioningController,
  type AnchorPreservationExecutor,
  type AnchorPreservationFrameResult,
  type DirectionalHistoryExecutor,
  type DirectionalHistoryFrameResult,
  type ExplicitTargetExecutor,
  type ExplicitTargetFrameResult,
  type LiveEdgeExecutor,
  type LiveEdgeFrameResult,
  type PositionExecutionLease,
  type PositionFrameLoop,
  type ResidentTopExecutor,
  type SavedPositionExecutor,
  type SavedPositionFrameResult,
  type UnreadMarkerExecutor,
  type UnreadMarkerFrameResult,
} from './positioningController'
import { deriveEntryPositionFacts } from './scrollPositionFacts'
import { messageFraction, pixelOffset, type ReachabilityFacts } from './scrollPositionModel'
import { resetScrollShadowDiagnostics } from './scrollPositionShadow'

/**
 * The frame-by-frame guardrail for the seven positioning paths (saved position, unread marker,
 * message target, resident top, live edge, anchor preservation, directional history).
 *
 * Each scenario drives the real controller with scripted executors and writes down every call the
 * controller makes (reachability, loop creation, frame, record, finish, completion) together with
 * the phase it was in at that moment. The whole trace is compared with a file recorded before the
 * lifecycle was rewritten, so a rewrite that reorders a call, drops a frame or changes a budget
 * fails here with the first differing line.
 */

const room = 'room@example.test'
const NEVER = '\u0000'

type Reachability = ReachabilityFacts
type Script<T> = T[]

const mounted: Reachability = { kind: 'available', index: 4, mounted: true, placement: 'viable' }
const unmounted: Reachability = { kind: 'available', index: 4, mounted: false, placement: 'viable' }
const absent = (loadAround: 'available' | 'loading' | 'exhausted' | 'unavailable'): Reachability =>
  ({ kind: 'target-absent', loadAround })
const liveTail: Reachability = {
  kind: 'global-live-edge',
  state: { kind: 'resident-tail', index: 9, mounted: true },
}
const liveRecenter: Reachability = { kind: 'global-live-edge', state: { kind: 'recenter-available' } }
const liveUnavailable: Reachability = { kind: 'global-live-edge', state: { kind: 'unavailable' } }

function next<T>(script: Script<T>, cursor: { i: number }): T {
  const value = script[Math.min(cursor.i, script.length - 1)]
  cursor.i += 1
  return value
}

class Trace {
  readonly lines: string[] = []
  readonly callbacks: Array<() => void> = []
  readonly leases: PositionExecutionLease[] = []
  readonly controller = new PositioningController(
    (owned) => this.note(`onMessageTargetOwnership ${owned}`),
    (id) => this.note(`onUserNavigation ${id}`),
    (id) => this.note(`onUserTakeover ${id}`),
    () => this.note('onInteractionEnd'),
  )
  private readonly generations = new Map<number, number>()

  constructor(readonly title: string) {
    this.lines.push(`## ${title}`)
  }

  private ordinal(generation: number): number {
    if (!this.generations.has(generation)) this.generations.set(generation, this.generations.size + 1)
    return this.generations.get(generation)!
  }

  /** The controller's state, with generations renumbered so a global counter cannot leak in. */
  state(): string {
    const active = this.controller.snapshot().active
    if (!active) return 'idle'
    const { phase, request } = active
    const detail = phase.kind === 'pending'
      ? `:${phase.reason}`
      : phase.kind === 'loading-around'
        ? `:${phase.messageId}`
        : phase.kind === 'mounting'
          ? `:${phase.index}`
          : phase.kind === 'unavailable'
            ? `:${phase.policy.kind}`
            : ''
    const source = request.source
    const reason = 'reason' in source ? `/${source.reason}` : ''
    return `${phase.kind}${detail} ${request.desired.kind} ${source.kind}${reason} g${this.ordinal(request.generation)}`
  }

  note(text: string): void {
    this.lines.push(`${text} | ${this.controller ? this.state() : 'init'}`)
  }

  loop(name: string, options: { failSchedule?: boolean; nullLoop?: boolean } = {}) {
    return (lease: PositionExecutionLease): PositionFrameLoop | null => {
      this.leases.push(lease)
      this.note(`${name}.beginLoop budget=${lease.frameBudget} current=${lease.isCurrent()}`)
      if (options.nullLoop) return null
      return {
        schedule: (callback) => {
          this.note(`${name}.loop.schedule`)
          if (options.failSchedule) throw new Error('rAF unavailable')
          this.callbacks.push(callback)
        },
        recordFrame: (wrote) => this.note(`${name}.loop.record wrote=${wrote}`),
        finish: () => this.note(`${name}.loop.finish`),
      }
    }
  }

  /** Runs scheduled frames until none is pending, up to a cap, tracing each one. */
  drain(limit = 400): void {
    for (let n = 1; n <= limit; n += 1) {
      const callback = this.callbacks.shift()
      if (!callback) return
      this.note(`frame ${n}`)
      callback()
    }
    this.lines.push(`drain stopped at cap ${limit}, ${this.callbacks.length} frame(s) pending`)
  }

  /**
   * Runs frames to the end without tracing each one, for runs that last hundreds of frames. The
   * count of frames and the calls they made still reach the trace, and so does the ending.
   */
  drainQuiet(limit = 2000): void {
    const before = this.lines.length
    let frames = 0
    while (frames < limit) {
      const callback = this.callbacks.shift()
      if (!callback) break
      frames += 1
      callback()
    }
    const calls = this.lines.slice(before)
    const count = (needle: string) => calls.filter((line) => line.includes(needle)).length
    this.lines.length = before
    this.lines.push(
      `quiet drain: ${frames} frames, ${count('positionFrame')} position calls, ${count('loop.record')} records, ${count('loop.schedule')} schedules`,
      ...calls.filter((line) => /complete|loop\.finish|onUser|onMessage/.test(line)),
    )
  }

  /** Runs one scheduled frame, tracing it. */
  step(): void {
    const callback = this.callbacks.shift()
    this.note(callback ? 'frame' : 'no frame pending')
    callback?.()
  }

  async settleMicrotasks(): Promise<void> {
    for (let i = 0; i < 5; i += 1) await Promise.resolve()
    this.note('microtasks flushed')
  }
}

const liveFrame = (wrote: boolean, reassert: boolean, scrollTop = 1000, atLiveEdge = true): LiveEdgeFrameResult =>
  ({ kind: 'positioned', scrollTop, atLiveEdge, wrote, reassert })

function liveExecutor(
  t: Trace,
  frames: Script<LiveEdgeFrameResult | 'throw'>,
  options: {
    reachability?: Script<Reachability>
    loop?: { failSchedule?: boolean; nullLoop?: boolean }
    recenter?: Script<'requested' | 'waiting' | 'unavailable'>
    recenterVersion?: () => string | undefined
  } = {},
): LiveEdgeExecutor {
  const frameCursor = { i: 0 }
  const reachCursor = { i: 0 }
  const recenterCursor = { i: 0 }
  return {
    reachability: () => {
      const facts = next(options.reachability ?? [liveTail], reachCursor)
      t.note(`live.reachability ${facts.kind}`)
      return facts
    },
    get recenterVersion() { return options.recenterVersion?.() },
    recenter: options.recenter
      ? () => {
          const result = next(options.recenter!, recenterCursor)
          t.note(`live.recenter -> ${result}`)
          return result
        }
      : undefined,
    beginLoop: t.loop('live', options.loop),
    positionFrame: (_request, lease) => {
      const result = next(frames, frameCursor)
      t.note(`live.positionFrame current=${lease.isCurrent()} -> ${result === 'throw' ? 'throw' : JSON.stringify(result)}`)
      if (result === 'throw') throw new Error('adapter failed')
      return result
    },
    complete: (_request, outcome) => t.note(`live.complete ${outcome}`),
  }
}

const savedFacts = deriveEntryPositionFacts({
  syncedLiveEdge: false,
  savedAnchor: { messageId: 'saved-message', fraction: 0.5 },
  savedOffsetPx: 900,
})
const unreadFacts = deriveEntryPositionFacts({
  syncedLiveEdge: false,
  savedAnchor: null,
  savedOffsetPx: null,
  firstUnreadMessageId: 'first-unread',
  unreadMarkerAlign: 'start',
})
const anchorDesired = {
  kind: 'anchor' as const,
  messageId: 'message-5',
  placement: { kind: 'bottom-fraction' as const, fraction: messageFraction(0.5) },
}
const historyDesired = {
  kind: 'anchor' as const,
  messageId: 'top-visible',
  placement: { kind: 'top-offset' as const, offsetPx: pixelOffset(-12) },
}

function savedExecutor(
  t: Trace,
  frames: Script<SavedPositionFrameResult | 'throw'>,
  options: {
    reachability?: Script<Reachability>
    loop?: { failSchedule?: boolean; nullLoop?: boolean }
    loadAround?: (() => unknown) | null
    live?: LiveEdgeExecutor
    recenter?: Script<'requested' | 'waiting' | 'unavailable'>
    recenterVersion?: () => string | undefined
  } = {},
): SavedPositionExecutor {
  const frameCursor = { i: 0 }
  const reachCursor = { i: 0 }
  const recenterCursor = { i: 0 }
  return {
    reachability: (desired, loadAround) => {
      const facts = next(options.reachability ?? [mounted], reachCursor)
      t.note(`saved.reachability ${desired.kind} loadAround=${loadAround} -> ${facts.kind}`)
      return facts
    },
    loadAround: options.loadAround === null
      ? undefined
      : (id) => {
          t.note(`saved.loadAround ${id}`)
          return options.loadAround?.()
        },
    get recenterVersion() { return options.recenterVersion?.() },
    recenterLiveEdge: options.recenter
      ? () => {
          const result = next(options.recenter!, recenterCursor)
          t.note(`saved.recenterLiveEdge -> ${result}`)
          return result
        }
      : undefined,
    liveEdge: options.live ?? liveExecutor(t, [liveFrame(true, false)]),
    beginLoop: t.loop('saved', options.loop),
    positionFrame: (request, lease) => {
      const result = next(frames, frameCursor)
      t.note(`saved.positionFrame ${request.desired.kind} current=${lease.isCurrent()} -> ${result === 'throw' ? 'throw' : JSON.stringify(result)}`)
      if (result === 'throw') throw new Error('adapter failed')
      return result
    },
    complete: (_request, outcome) => t.note(`saved.complete ${outcome}`),
  }
}

function unreadExecutor(
  t: Trace,
  frames: Script<UnreadMarkerFrameResult | 'throw'>,
  options: {
    reachability?: Script<Reachability>
    loop?: { failSchedule?: boolean; nullLoop?: boolean }
    geometry?: Script<{ scrollTop: number; contentHeight: number; pendingFling?: boolean } | null> | 'follow'
    live?: LiveEdgeExecutor
    noComplete?: boolean
    follow?: () => number
  } = {},
): UnreadMarkerExecutor {
  const frameCursor = { i: 0 }
  const reachCursor = { i: 0 }
  const geometryCursor = { i: 0 }
  let lastTop = 400
  return {
    reachability: (desired) => {
      const facts = next(options.reachability ?? [mounted], reachCursor)
      t.note(`unread.reachability ${desired.kind} -> ${facts.kind}`)
      return facts
    },
    liveEdge: options.live ?? liveExecutor(t, [liveFrame(true, false)]),
    beginLoop: t.loop('unread', options.loop),
    readGeometry: () => {
      const geometry = options.geometry && options.geometry !== 'follow'
        ? next(options.geometry, geometryCursor)
        : { scrollTop: options.follow ? options.follow() : lastTop, contentHeight: 5000 }
      t.note(`unread.readGeometry -> ${JSON.stringify(geometry)}`)
      return geometry
    },
    positionFrame: (_request, lease) => {
      const result = next(frames, frameCursor)
      t.note(`unread.positionFrame current=${lease.isCurrent()} -> ${result === 'throw' ? 'throw' : JSON.stringify(result)}`)
      if (result === 'throw') throw new Error('adapter failed')
      if (result.kind === 'positioned') lastTop = result.scrollTop
      return result
    },
    complete: options.noComplete
      ? undefined
      : (_request, outcome) => t.note(`unread.complete ${outcome}`),
  }
}

function targetExecutor(
  t: Trace,
  frames: Script<ExplicitTargetFrameResult | 'throw'>,
  options: {
    reachability?: Script<Reachability>
    loop?: { failSchedule?: boolean; nullLoop?: boolean }
    loadAround?: (() => unknown) | null
  } = {},
): ExplicitTargetExecutor {
  const frameCursor = { i: 0 }
  const reachCursor = { i: 0 }
  return {
    reachability: (desired, loadAround) => {
      const facts = next(options.reachability ?? [mounted], reachCursor)
      t.note(`target.reachability ${desired.kind} loadAround=${loadAround} -> ${facts.kind}`)
      return facts
    },
    loadAround: options.loadAround === null
      ? undefined
      : (id) => {
          t.note(`target.loadAround ${id}`)
          return options.loadAround?.()
        },
    beginLoop: t.loop('target', options.loop),
    observeGeometry: (resetInput) => t.note(`target.observeGeometry reset=${resetInput}`),
    positionFrame: (_request, lease, placement) => {
      const result = next(frames, frameCursor)
      t.note(`target.positionFrame placement=${placement} current=${lease.isCurrent()} -> ${result === 'throw' ? 'throw' : JSON.stringify(result)}`)
      if (result === 'throw') throw new Error('adapter failed')
      return result
    },
    complete: (_request, outcome, applied) => t.note(`target.complete ${outcome} applied=${applied}`),
  }
}

function residentTopExecutor(
  t: Trace,
  frames: Script<number | null | 'throw'>,
  options: {
    reachability?: Script<Reachability>
    loop?: { failSchedule?: boolean; nullLoop?: boolean }
    start?: 'started' | 'unavailable'
  } = {},
): ResidentTopExecutor {
  const frameCursor = { i: 0 }
  const reachCursor = { i: 0 }
  return {
    reachability: () => {
      const facts = next(options.reachability ?? [mounted], reachCursor)
      t.note(`top.reachability -> ${facts.kind}`)
      return facts
    },
    beginLoop: t.loop('top', options.loop),
    start: (_request, lease) => {
      t.note(`top.start current=${lease.isCurrent()} -> ${options.start ?? 'started'}`)
      return { kind: options.start ?? 'started' }
    },
    positionFrame: (lease) => {
      const result = next(frames, frameCursor)
      t.note(`top.positionFrame current=${lease.isCurrent()} -> ${result}`)
      if (result === 'throw') throw new Error('adapter failed')
      return result
    },
    complete: (_request, outcome) => t.note(`top.complete ${outcome}`),
  }
}

function anchorExecutor(
  t: Trace,
  frames: Script<AnchorPreservationFrameResult | 'throw'>,
  options: {
    reachability?: Script<Reachability>
    loop?: { failSchedule?: boolean; nullLoop?: boolean }
    name?: string
  } = {},
): AnchorPreservationExecutor {
  const frameCursor = { i: 0 }
  const reachCursor = { i: 0 }
  const name = options.name ?? 'anchor'
  return {
    observeGeometry: () => t.note(`${name}.observeGeometry`),
    reachability: () => {
      const facts = next(options.reachability ?? [mounted], reachCursor)
      t.note(`${name}.reachability -> ${facts.kind}`)
      return facts
    },
    beginLoop: t.loop(name, options.loop),
    positionFrame: (_request, lease) => {
      const result = next(frames, frameCursor)
      t.note(`${name}.positionFrame current=${lease.isCurrent()} -> ${result === 'throw' ? 'throw' : JSON.stringify(result)}`)
      if (result === 'throw') throw new Error('adapter failed')
      return result
    },
    complete: (_request, outcome) => t.note(`${name}.complete ${outcome}`),
  }
}

function historyExecutor(
  t: Trace,
  frames: Script<DirectionalHistoryFrameResult | 'throw'>,
  options: {
    reachability?: Script<Reachability>
    loop?: { failSchedule?: boolean; nullLoop?: boolean }
  } = {},
): DirectionalHistoryExecutor {
  const frameCursor = { i: 0 }
  const reachCursor = { i: 0 }
  return {
    reachability: () => {
      const facts = next(options.reachability ?? [mounted], reachCursor)
      t.note(`history.reachability -> ${facts.kind}`)
      return facts
    },
    beginLoop: t.loop('history', options.loop),
    positionFrame: (_request, lease) => {
      const result = next(frames, frameCursor)
      t.note(`history.positionFrame current=${lease.isCurrent()} -> ${result === 'throw' ? 'throw' : JSON.stringify(result)}`)
      if (result === 'throw') throw new Error('adapter failed')
      return result
    },
    complete: (_request, outcome) => t.note(`history.complete ${outcome}`),
  }
}

const anchored = (reassert: boolean, scrollTop = 500): AnchorPreservationFrameResult =>
  ({ kind: 'positioned', scrollTop, reassert })
const historyFrame = (wrote: boolean, reassert: boolean, scrollTop = 500): DirectionalHistoryFrameResult =>
  ({ kind: 'positioned', scrollTop, wrote, reassert })
const savedFrame = (reassert: boolean, scrollTop = 400): SavedPositionFrameResult =>
  ({ kind: 'positioned', scrollTop, reassert })
const targetFrame = (wrote: boolean, scrollTop = 400): ExplicitTargetFrameResult =>
  ({ kind: 'positioned', scrollTop, wrote })
const unreadFrame = (scrollTop = 400, atLiveEdge = false): UnreadMarkerFrameResult =>
  ({ kind: 'positioned', scrollTop, atLiveEdge })

/** The conversation's entry, as the hook observes it before any request: names the current room. */
function enterLive(t: Trace): void {
  t.controller.observeEntry({
    event: 'entry',
    conversationId: room,
    entryFacts: deriveEntryPositionFacts({ syncedLiveEdge: false, savedAnchor: null, savedOffsetPx: null }),
    reachability: () => liveTail,
    actual: { desired: { kind: 'live-edge', follow: true }, phase: 'positioning' },
  })
  // The reader has been at the live edge for a while: a settled position, written without a trace.
  t.controller.beginLiveEdgeRequest({
    conversationId: room,
    source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
    executor: {
      reachability: () => liveTail,
      beginLoop: () => null,
      positionFrame: () => liveFrame(true, false),
      complete: () => {},
    },
  })
  t.note('entered conversation')
}

type Scenario = [name: string, run: (t: Trace) => void | Promise<void>]

const liveScenarios: Scenario[] = [
  ['live edge: one write, no reassert', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, false)]),
    })
    t.drain()
  }],
  ['live edge: reasserts until eight frames hold still', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, true), liveFrame(true, true), liveFrame(true, true), liveFrame(false, true)]),
    })
    t.drain()
  }],
  ['live edge: never settles, ends best effort at the frame budget', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, true)]),
    })
    t.drain()
  }],
  ['live edge: held iOS write gives frames back, then lands', (t) => {
    t.controller.beginLiveEdgeNavigation({
      conversationId: room,
      navigationFacts: { unreadMarkerNeedsVisit: false, unreadMarkerAlign: 'start' },
      executor: liveExecutor(t, [
        { kind: 'held' }, { kind: 'held' }, { kind: 'held' }, liveFrame(true, true), liveFrame(false, true),
      ]),
    })
    t.drain()
    t.note(`pendingNavigation=${t.controller.hasPendingNavigation(room)}`)
  }],
  ['live edge: held write that never lands still ends', (t) => {
    t.controller.beginLiveEdgeNavigation({
      conversationId: room,
      navigationFacts: { unreadMarkerNeedsVisit: false, unreadMarkerAlign: 'start' },
      executor: liveExecutor(t, [liveFrame(true, true), { kind: 'held' }]),
    })
    t.drainQuiet()
  }],
  ['live edge: first frame unavailable', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [{ kind: 'unavailable' }]),
    })
    t.drain()
  }],
  ['live edge: later frame unavailable', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, true), { kind: 'unavailable' }]),
    })
    t.drain()
  }],
  ['live edge: loop cannot start', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, true)], { loop: { nullLoop: true } }),
    })
    t.drain()
  }],
  ['live edge: frame cannot be scheduled', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, true)], { loop: { failSchedule: true } }),
    })
    t.drain()
  }],
  ['live edge: adapter throws on a frame', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, true), 'throw']),
    })
    t.drain()
  }],
  ['live edge: empty window is not accepted', (t) => {
    const request = t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, false)], { reachability: [{ kind: 'empty-window' }] }),
    })
    t.note(`request=${request === null ? 'null' : 'accepted'}`)
  }],
  ['live edge: window must recenter first, then settles on the resident tail', (t) => {
    let version = 'v1'
    const executor = liveExecutor(t, [liveFrame(true, false)], {
      reachability: [liveRecenter, liveRecenter, liveTail],
      recenter: ['requested'],
      recenterVersion: () => version,
    })
    const request = t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor,
    })
    t.note(`refresh same version -> ${t.controller.refreshLiveEdge({ conversationId: room, executor })}`)
    version = 'v2'
    t.note(`refresh new version -> ${t.controller.refreshLiveEdge({ conversationId: room, executor })}`)
    t.note(`request=${request ? 'accepted' : 'null'}`)
    t.drain()
  }],
  ['live edge: recenter unavailable falls back to the best resident edge', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, false)], {
        reachability: [liveRecenter],
        recenter: ['unavailable'],
        recenterVersion: () => 'v1',
      }),
    })
    t.drain()
  }],
  ['live edge: no recenter function falls back to the best resident edge', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, false)], { reachability: [liveRecenter] }),
    })
    t.drain()
  }],
  ['live edge: unavailable window still tries the resident edge', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, false)], { reachability: [liveTail, liveUnavailable] }),
    })
    t.drain()
  }],
  ['live edge: content change restarts the loop under the same generation', (t) => {
    const first = liveExecutor(t, [liveFrame(true, true)])
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: first,
    })
    t.step()
    t.step()
    t.note(`reconcile -> ${t.controller.reconcileLiveEdge({
      conversationId: room,
      executor: liveExecutor(t, [liveFrame(true, true), liveFrame(false, true)]),
      rearmEligibleFromGeometry: false,
    })}`)
    t.drain()
  }],
  ['live edge: reconcile after settling re-pins', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, false)]),
    })
    t.note(`reconcile -> ${t.controller.reconcileLiveEdge({
      conversationId: room,
      executor: liveExecutor(t, [liveFrame(true, false)]),
      rearmEligibleFromGeometry: false,
    })}`)
    t.drain()
  }],
  ['live edge: the reader taking over ends the loop', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, true)]),
    })
    t.step()
    t.note(`observeUserInput -> ${t.controller.observeUserInput(room)}`)
    t.drain()
  }],
  ['live edge: a newer live request supersedes a running one', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, true)]),
    })
    t.step()
    t.controller.beginLiveEdgeNavigation({
      conversationId: room,
      navigationFacts: { unreadMarkerNeedsVisit: false, unreadMarkerAlign: 'start' },
      executor: liveExecutor(t, [liveFrame(true, false)]),
    })
    t.drain()
  }],
  ['live edge: entry selects live edge', (t) => {
    t.controller.beginLiveEdgeEntry({
      conversationId: room,
      entryFacts: deriveEntryPositionFacts({ syncedLiveEdge: true, savedAnchor: null, savedOffsetPx: null }),
      executor: liveExecutor(t, [liveFrame(true, true), liveFrame(false, true)]),
    })
    t.drain()
  }],
  ['live edge: deactivating the conversation drops the run', (t) => {
    t.controller.beginLiveEdgeRequest({
      conversationId: room,
      source: { kind: 'ambient-live-edge', reason: 'geometry-rearm' },
      executor: liveExecutor(t, [liveFrame(true, true)]),
    })
    t.step()
    t.controller.deactivate(room, t.controller.snapshot().active!.request.generation)
    t.note('deactivated')
    t.drain()
  }],
]

const savedScenarios: Scenario[] = [
  ['saved position: one write that needs no reassert', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room, entryFacts: savedFacts, executor: savedExecutor(t, [savedFrame(false)]),
    })
    t.drain()
    t.note(`pending=${t.controller.isSavedPositionPending(room)}`)
  }],
  ['saved position: reasserts until eight frames agree within drift', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [savedFrame(true, 400), savedFrame(true, 420), savedFrame(true, 405), savedFrame(true, 405)]),
    })
    t.note(`pending=${t.controller.isSavedPositionPending(room)}`)
    t.drain()
    t.note(`pending=${t.controller.isSavedPositionPending(room)}`)
  }],
  ['saved position: keeps drifting, ends best effort at the budget', (t) => {
    let scrollTop = 0
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: {
        ...savedExecutor(t, [savedFrame(true)]),
        positionFrame: (_request, lease) => {
          scrollTop += 50
          t.note(`saved.positionFrame current=${lease.isCurrent()} -> ${scrollTop}`)
          return savedFrame(true, scrollTop)
        },
      },
    })
    t.drain()
  }],
  ['saved position: the row is lost after the first write', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [savedFrame(true), { kind: 'unavailable' }]),
    })
    t.drain()
  }],
  ['saved position: first frame unavailable promotes the live-edge fallback', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [{ kind: 'unavailable' }]),
    })
    t.drain()
  }],
  ['saved position: loop cannot start', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [savedFrame(true)], { loop: { nullLoop: true } }),
    })
    t.drain()
  }],
  ['saved position: frame cannot be scheduled', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [savedFrame(true)], { loop: { failSchedule: true } }),
    })
    t.drain()
  }],
  ['saved position: adapter throws on a frame', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [savedFrame(true), 'throw']),
    })
    t.drain()
  }],
  ['saved position: row not mounted yet', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [savedFrame(false)], { reachability: [unmounted] }),
    })
    t.drain()
  }],
  ['saved position: empty window is pending, then refreshed', (t) => {
    const executor = savedExecutor(t, [savedFrame(false)], { reachability: [mounted, { kind: 'empty-window' }, mounted] })
    const request = t.controller.beginSavedPositionEntry({ conversationId: room, entryFacts: savedFacts, executor })
    t.note(`refresh -> ${t.controller.refreshSavedPosition({
      conversationId: room, generation: request!.generation, executor,
    })}`)
    t.drain()
  }],
  ['saved position: anchor outside the window loads around once, then positions', async (t) => {
    const executor = savedExecutor(t, [savedFrame(false)], {
      reachability: [absent('available'), absent('loading'), mounted],
      loadAround: () => Promise.resolve(),
    })
    const request = t.controller.beginSavedPositionEntry({ conversationId: room, entryFacts: savedFacts, executor })
    t.note(`pending=${t.controller.isSavedPositionPending(room)}`)
    await t.settleMicrotasks()
    t.note(`refresh -> ${t.controller.refreshSavedPosition({
      conversationId: room, generation: request!.generation, executor,
    })}`)
    t.drain()
  }],
  ['saved position: load around returns nothing and is exhausted', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [savedFrame(false)], {
        reachability: [absent('available'), absent('exhausted')],
        loadAround: () => null,
      }),
    })
    t.drain()
  }],
  ['saved position: load around fails, anchor stays absent, falls back', async (t) => {
    const executor = savedExecutor(t, [savedFrame(false)], {
      reachability: [absent('available'), absent('exhausted')],
      loadAround: () => Promise.reject(new Error('network')),
    })
    const request = t.controller.beginSavedPositionEntry({ conversationId: room, entryFacts: savedFacts, executor })
    await t.settleMicrotasks()
    t.note(`request=${request ? 'accepted' : 'null'}`)
    t.drain()
  }],
  ['saved position: no load around available, anchor absent, falls back', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [savedFrame(false)], { reachability: [absent('unavailable')], loadAround: null }),
    })
    t.drain()
  }],
  ['saved position: live-edge fallback needs a recenter, which is requested', (t) => {
    let version = 'v1'
    const live = liveExecutor(t, [liveFrame(true, false)], { reachability: [liveRecenter, liveTail], recenter: ['requested'], recenterVersion: () => version })
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [{ kind: 'unavailable' }], { live }),
    })
    version = 'v2'
    t.drain()
  }],
  ['saved position: fallback live edge that cannot position cancels quietly', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room,
      entryFacts: savedFacts,
      executor: savedExecutor(t, [{ kind: 'unavailable' }], {
        live: liveExecutor(t, [{ kind: 'unavailable' }], { reachability: [liveUnavailable] }),
      }),
    })
    t.drain()
  }],
  ['saved position: the reader taking over ends the loop', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room, entryFacts: savedFacts, executor: savedExecutor(t, [savedFrame(true)]),
    })
    t.step()
    t.note(`observeUserInput -> ${t.controller.observeUserInput(room)}`)
    t.drain()
  }],
  ['saved position: a newer request supersedes it', (t) => {
    t.controller.beginSavedPositionEntry({
      conversationId: room, entryFacts: savedFacts, executor: savedExecutor(t, [savedFrame(true)]),
    })
    t.step()
    t.controller.beginLiveEdgeNavigation({
      conversationId: room,
      navigationFacts: { unreadMarkerNeedsVisit: false, unreadMarkerAlign: 'start' },
      executor: liveExecutor(t, [liveFrame(true, false)]),
    })
    t.drain()
    t.note(`status=${JSON.stringify(t.controller.savedPositionStatus(room)?.phase ?? null)}`)
  }],
]

const unreadScenarios: Scenario[] = [
  ['unread marker: lands and holds for eight frames, then settles', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room, entryFacts: unreadFacts, executor: unreadExecutor(t, [unreadFrame(400)]),
    })
    t.drain()
  }],
  ['unread marker: waits for the divider, then lands', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: unreadExecutor(t, [{ kind: 'waiting' }, { kind: 'waiting' }, unreadFrame(400)]),
    })
    t.drain()
  }],
  ['unread marker: divider never appears, promotes the live-edge fallback', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room, entryFacts: unreadFacts, executor: unreadExecutor(t, [{ kind: 'waiting' }]),
    })
    t.drain()
  }],
  ['unread marker: landed but never held still, settles at the budget', (t) => {
    let top = 0
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: {
        ...unreadExecutor(t, [unreadFrame(0)], { geometry: 'follow', follow: () => top }),
        positionFrame: (_request, lease) => {
          top += 40
          t.note(`unread.positionFrame current=${lease.isCurrent()} -> ${top}`)
          return unreadFrame(top)
        },
      },
    })
    t.drain()
  }],
  ['unread marker: resolves at the live edge, hands over to the live edge', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room, entryFacts: unreadFacts, executor: unreadExecutor(t, [unreadFrame(400, true)]),
    })
    t.drain()
  }],
  ['unread marker: resolves at the live edge once, then budget runs out', (t) => {
    let top = 0
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: {
        ...unreadExecutor(t, [unreadFrame(0)], { geometry: 'follow', follow: () => top }),
        positionFrame: (_request, lease) => {
          top += 60
          t.note(`unread.positionFrame current=${lease.isCurrent()} -> ${top}`)
          return unreadFrame(top, true)
        },
      },
    })
    t.drain()
  }],
  ['unread marker: held iOS write waits without settling', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: unreadExecutor(t, [{ kind: 'held' }, { kind: 'held' }, { kind: 'held' }, unreadFrame(400)]),
    })
    t.drain()
  }],
  ['unread marker: frame unavailable promotes the fallback', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room, entryFacts: unreadFacts, executor: unreadExecutor(t, [unreadFrame(400), { kind: 'unavailable' }]),
    })
    t.drain()
  }],
  ['unread marker: reader moved the viewport without input, takeover', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: unreadExecutor(t, [unreadFrame(400)], {
        geometry: [
          { scrollTop: 400, contentHeight: 5000 },
          { scrollTop: 400, contentHeight: 5000 },
          { scrollTop: 1200, contentHeight: 5000 },
        ],
      }),
    })
    t.drain()
  }],
  ['unread marker: content height changed, not a takeover', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: unreadExecutor(t, [unreadFrame(400)], {
        geometry: [
          { scrollTop: 400, contentHeight: 5000 },
          { scrollTop: 1200, contentHeight: 4000 },
          { scrollTop: 400, contentHeight: 4000 },
        ],
      }),
    })
    t.drain()
  }],
  ['unread marker: no geometry available is never a takeover', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: unreadExecutor(t, [unreadFrame(400)], { geometry: [null] }),
    })
    t.drain()
  }],
  ['unread marker: target not indexed yet, the loop waits for hydration', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: unreadExecutor(t, [unreadFrame(400)], { reachability: [absent('unavailable')] }),
    })
    t.drain()
  }],
  ['unread marker: empty window waits for hydration', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: unreadExecutor(t, [unreadFrame(400)], { reachability: [{ kind: 'empty-window' }] }),
    })
    t.drain()
  }],
  ['unread marker: loop cannot start', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: unreadExecutor(t, [unreadFrame(400)], { loop: { nullLoop: true } }),
    })
    t.drain()
  }],
  ['unread marker: frame cannot be scheduled', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room,
      entryFacts: unreadFacts,
      executor: unreadExecutor(t, [unreadFrame(400)], { loop: { failSchedule: true } }),
    })
    t.drain()
  }],
  ['unread marker: adapter throws on a frame', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room, entryFacts: unreadFacts, executor: unreadExecutor(t, ['throw']),
    })
    t.drain()
  }],
  ['unread marker: no completion callback is fine', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room, entryFacts: unreadFacts, executor: unreadExecutor(t, [unreadFrame(400)], { noComplete: true }),
    })
    t.drain()
  }],
  ['unread marker: reassert drives one frame without scheduling another', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room, entryFacts: unreadFacts, executor: unreadExecutor(t, [unreadFrame(400)]),
    })
    t.controller.reassertUnreadMarker(room)
    t.controller.reassertUnreadMarker('another-room')
    t.drain()
  }],
  ['unread marker: the reader taking over ends the visit', (t) => {
    t.controller.beginUnreadMarkerEntry({
      conversationId: room, entryFacts: unreadFacts, executor: unreadExecutor(t, [unreadFrame(400)]),
    })
    t.step()
    t.note(`hold=${t.controller.hasUnreadMarkerHold(room)}`)
    t.note(`observeUserInput -> ${t.controller.observeUserInput(room)}`)
    t.drain()
  }],
  ['unread marker: return to latest visits the divider, then hands over', (t) => {
    t.controller.beginUnreadMarkerNavigation({
      conversationId: room,
      navigationFacts: { firstUnreadMessageId: 'first-unread', unreadMarkerNeedsVisit: true, unreadMarkerAlign: 'start' },
      executor: unreadExecutor(t, [{ kind: 'held' }, unreadFrame(400, true)]),
    })
    t.note(`pendingNavigation=${t.controller.hasPendingNavigation(room)}`)
    t.drain()
    t.note(`pendingNavigation=${t.controller.hasPendingNavigation(room)}`)
  }],
]

const targetScenarios: Scenario[] = [
  ['message target: positions and settles after four steady frames', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, [targetFrame(true, 400)]),
    })
    t.note(`ownsTarget=${t.controller.ownsMessageTarget()} pending=${t.controller.hasPendingNavigation(room)}`)
    t.drain()
    t.note(`ownsTarget=${t.controller.ownsMessageTarget()} pending=${t.controller.hasPendingNavigation(room)}`)
  }],
  ['message target: row not ready, then waits and lands', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room,
      messageId: 'target-a',
      executor: targetExecutor(t, [{ kind: 'waiting' }, { kind: 'waiting' }, targetFrame(true, 400), targetFrame(false, 420)]),
    })
    t.drain()
  }],
  ['message target: held iOS write counts as applied but does not settle', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room,
      messageId: 'target-a',
      executor: targetExecutor(t, [{ kind: 'held' }, { kind: 'held' }, targetFrame(true, 400)]),
    })
    t.drain()
  }],
  ['message target: held write that never lands ends best effort', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, [{ kind: 'held' }]),
    })
    t.drainQuiet()
  }],
  ['message target: frame unavailable before anything applied waits for the index', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, [{ kind: 'unavailable' }]),
    })
    t.drain()
  }],
  ['message target: frame unavailable after it applied', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room,
      messageId: 'target-a',
      executor: targetExecutor(t, [targetFrame(true, 100), { kind: 'unavailable' }]),
    })
    t.drain()
  }],
  ['message target: never converges, applied, ends best effort at the budget', (t) => {
    let top = 0
    t.controller.beginExplicitTarget({
      conversationId: room,
      messageId: 'target-a',
      executor: {
        ...targetExecutor(t, [targetFrame(true)]),
        positionFrame: (_request, lease) => {
          top += 100
          t.note(`target.positionFrame current=${lease.isCurrent()} -> ${top}`)
          return targetFrame(true, top)
        },
      },
    })
    t.drain()
  }],
  ['message target: never applied, ends pending at the budget', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, [{ kind: 'waiting' }]),
    })
    t.drain()
  }],
  ['message target: loop cannot start', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room,
      messageId: 'target-a',
      executor: targetExecutor(t, [targetFrame(true)], { loop: { nullLoop: true } }),
    })
    t.drain()
  }],
  ['message target: frame cannot be scheduled', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room,
      messageId: 'target-a',
      executor: targetExecutor(t, [targetFrame(true)], { loop: { failSchedule: true } }),
    })
    t.drain()
  }],
  ['message target: adapter throws on a frame', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, ['throw']),
    })
    t.drain()
  }],
  ['message target: not mounted yet', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, [targetFrame(true)], { reachability: [unmounted] }),
    })
    t.drain()
  }],
  ['message target: outside the window loads around, then positions', async (t) => {
    const executor = targetExecutor(t, [targetFrame(true, 400)], {
      reachability: [absent('available'), absent('loading'), mounted],
      loadAround: () => Promise.resolve(),
    })
    const request = t.controller.beginExplicitTarget({ conversationId: room, messageId: 'target-a', executor })
    await t.settleMicrotasks()
    t.note(`refresh -> ${t.controller.refreshExplicitTarget({ conversationId: room, generation: request!.generation, executor })}`)
    t.drain()
  }],
  ['message target: load around returns nothing, target not indexed', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room,
      messageId: 'target-a',
      executor: targetExecutor(t, [targetFrame(true)], {
        reachability: [absent('available'), absent('exhausted')],
        loadAround: () => null,
      }),
    })
    t.drain()
  }],
  ['message target: no load around, target not indexed, waits', (t) => {
    const executor = targetExecutor(t, [targetFrame(true, 400)], {
      reachability: [absent('unavailable'), mounted],
      loadAround: null,
    })
    const request = t.controller.beginExplicitTarget({ conversationId: room, messageId: 'target-a', executor })
    t.note(`request=${request ? 'accepted' : 'null'}`)
    t.note(`refresh -> ${t.controller.refreshExplicitTarget({ conversationId: room, generation: request!.generation, executor })}`)
    t.drain()
  }],
  ['message target: asking for the same target again reuses the run', (t) => {
    const executor = targetExecutor(t, [{ kind: 'waiting' }])
    const first = t.controller.beginExplicitTarget({ conversationId: room, messageId: 'target-a', executor })
    const second = t.controller.beginExplicitTarget({ conversationId: room, messageId: 'target-a', executor })
    t.note(`same request=${first === second}`)
    const other = t.controller.beginExplicitTarget({ conversationId: room, messageId: 'target-b', executor })
    t.note(`other request=${other !== first}`)
    t.step()
  }],
  ['message target: resize maintenance of a settled target', (t) => {
    const executor = targetExecutor(t, [targetFrame(true, 400)])
    t.controller.beginExplicitTarget({ conversationId: room, messageId: 'target-a', executor })
    t.drain()
    t.note(`resize -> ${t.controller.reconcileMessageTargetAfterResize({ conversationId: room, executor })}`)
    t.note(`pendingNavigation=${t.controller.hasPendingNavigation(room)}`)
    t.drain()
  }],
  ['message target: the reader taking over a running jump', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, [targetFrame(true, 400)]),
    })
    t.step()
    t.note(`observeUserInput up -> ${t.controller.observeUserInput(room, {
      deltaY: -40, geometry: { top: 300, height: 5000, client: 600 },
    } as never)}`)
    t.drain()
  }],
  ['message target: the reader scrolling down over a settled target pauses it', (t) => {
    const executor = targetExecutor(t, [targetFrame(true, 400)])
    t.controller.beginExplicitTarget({ conversationId: room, messageId: 'target-a', executor })
    t.drain()
    t.controller.reconcileMessageTargetAfterResize({ conversationId: room, executor })
    t.step()
    t.note(`observeUserInput down -> ${t.controller.observeUserInput(room, {
      deltaY: 40, geometry: { top: 300, height: 5000, client: 600 },
    } as never)}`)
    t.note(`inputEnd -> ${t.controller.observeUserInputEnd(room)}`)
    t.drain()
  }],
  ['message target: cancelled by its owner', (t) => {
    const request = t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, [targetFrame(true, 400)]),
    })
    t.step()
    t.note(`cancel wrong generation -> ${t.controller.cancelExplicitTarget(room, request!.generation + 99)}`)
    t.note(`cancel -> ${t.controller.cancelExplicitTarget(room, request!.generation)}`)
    t.drain()
  }],
  ['message target: a newer request supersedes the jump', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, [targetFrame(true, 400)]),
    })
    t.step()
    t.controller.beginResidentTopNavigation({ conversationId: room, executor: residentTopExecutor(t, [0]) })
    t.drain()
  }],
]

const residentTopScenarios: Scenario[] = [
  ['resident top: reaches the top and settles after two frames', (t) => {
    t.controller.beginResidentTopNavigation({ conversationId: room, executor: residentTopExecutor(t, [900, 300, 0, 0]) })
    t.note(`pendingNavigation=${t.controller.hasPendingNavigation(room)}`)
    t.drain()
    t.note(`pendingNavigation=${t.controller.hasPendingNavigation(room)}`)
  }],
  ['resident top: tolerance of one pixel counts as the top', (t) => {
    t.controller.beginResidentTopNavigation({ conversationId: room, executor: residentTopExecutor(t, [1, 1, 2, 1, 1]) })
    t.drain()
  }],
  ['resident top: never arrives, ends best effort at 120 frames', (t) => {
    t.controller.beginResidentTopNavigation({ conversationId: room, executor: residentTopExecutor(t, [500]) })
    t.drain()
  }],
  ['resident top: frame gives no position', (t) => {
    t.controller.beginResidentTopNavigation({ conversationId: room, executor: residentTopExecutor(t, [400, null]) })
    t.drain()
  }],
  ['resident top: start unavailable', (t) => {
    t.controller.beginResidentTopNavigation({
      conversationId: room, executor: residentTopExecutor(t, [0], { start: 'unavailable' }),
    })
    t.drain()
  }],
  ['resident top: loop cannot start', (t) => {
    t.controller.beginResidentTopNavigation({
      conversationId: room, executor: residentTopExecutor(t, [0], { loop: { nullLoop: true } }),
    })
    t.drain()
  }],
  ['resident top: frame cannot be scheduled', (t) => {
    t.controller.beginResidentTopNavigation({
      conversationId: room, executor: residentTopExecutor(t, [0], { loop: { failSchedule: true } }),
    })
    t.drain()
  }],
  ['resident top: adapter throws on a frame', (t) => {
    t.controller.beginResidentTopNavigation({ conversationId: room, executor: residentTopExecutor(t, [400, 'throw']) })
    t.drain()
  }],
  ['resident top: empty window is refused', (t) => {
    const request = t.controller.beginResidentTopNavigation({
      conversationId: room, executor: residentTopExecutor(t, [0], { reachability: [{ kind: 'empty-window' }] }),
    })
    t.note(`request=${request ? 'accepted' : 'null'}`)
  }],
  ['resident top: the reader taking over ends the run', (t) => {
    t.controller.beginResidentTopNavigation({ conversationId: room, executor: residentTopExecutor(t, [500]) })
    t.step()
    t.note(`observeUserInput -> ${t.controller.observeUserInput(room)}`)
    t.drain()
  }],
  ['resident top: a newer request supersedes the run', (t) => {
    t.controller.beginResidentTopNavigation({ conversationId: room, executor: residentTopExecutor(t, [500]) })
    t.step()
    t.controller.beginLiveEdgeNavigation({
      conversationId: room,
      navigationFacts: { unreadMarkerNeedsVisit: false, unreadMarkerAlign: 'start' },
      executor: liveExecutor(t, [liveFrame(true, false)]),
    })
    t.drain()
  }],
]

const anchorScenarios: Scenario[] = [
  ['media preservation: one write, no reassert', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room, desired: anchorDesired, executor: anchorExecutor(t, [anchored(false)], { name: 'media' }),
    })
    t.drain()
  }],
  ['media preservation: reasserts until eight frames agree within drift', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room,
      desired: anchorDesired,
      executor: anchorExecutor(t, [anchored(true, 500), anchored(true, 520), anchored(true, 505), anchored(true, 505)], { name: 'media' }),
    })
    t.drain()
  }],
  ['media preservation: keeps drifting, ends best effort at the budget', (t) => {
    let top = 0
    t.controller.beginMediaPreservation({
      conversationId: room,
      desired: anchorDesired,
      executor: {
        ...anchorExecutor(t, [anchored(true)], { name: 'media' }),
        positionFrame: (_request, lease) => {
          top += 30
          t.note(`media.positionFrame current=${lease.isCurrent()} -> ${top}`)
          return anchored(true, top)
        },
      },
    })
    t.drain()
  }],
  ['media preservation: first frame unavailable', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room, desired: anchorDesired, executor: anchorExecutor(t, [{ kind: 'unavailable' }], { name: 'media' }),
    })
    t.drain()
  }],
  ['media preservation: later frame unavailable', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room,
      desired: anchorDesired,
      executor: anchorExecutor(t, [anchored(true), { kind: 'unavailable' }], { name: 'media' }),
    })
    t.drain()
  }],
  ['media preservation: loop cannot start', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room,
      desired: anchorDesired,
      executor: anchorExecutor(t, [anchored(true)], { name: 'media', loop: { nullLoop: true } }),
    })
    t.drain()
  }],
  ['media preservation: frame cannot be scheduled', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room,
      desired: anchorDesired,
      executor: anchorExecutor(t, [anchored(true)], { name: 'media', loop: { failSchedule: true } }),
    })
    t.drain()
  }],
  ['media preservation: adapter throws on a frame', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room,
      desired: anchorDesired,
      executor: anchorExecutor(t, [anchored(true), 'throw'], { name: 'media' }),
    })
    t.drain()
  }],
  ['media preservation: anchor not in the window stops with a warning', (t) => {
    const request = t.controller.beginMediaPreservation({
      conversationId: room,
      desired: anchorDesired,
      executor: anchorExecutor(t, [anchored(false)], { name: 'media', reachability: [absent('unavailable')] }),
    })
    t.note(`request=${request ? 'accepted' : 'null'}`)
    t.drain()
  }],
  ['media preservation: row not mounted yet', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room,
      desired: anchorDesired,
      executor: anchorExecutor(t, [anchored(false)], { name: 'media', reachability: [unmounted] }),
    })
    t.drain()
  }],
  ['media preservation: rebased onto a new anchor while looping', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room, desired: anchorDesired, executor: anchorExecutor(t, [anchored(true, 500)], { name: 'media' }),
    })
    t.step()
    t.note(`rebase -> ${t.controller.rebaseMediaPreservation(room, { ...anchorDesired, messageId: 'message-9' })}`)
    t.note(`rebase wrong room -> ${t.controller.rebaseMediaPreservation('another-room', anchorDesired)}`)
    t.drain()
  }],
  ['media preservation: the reader taking over ends the loop', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room, desired: anchorDesired, executor: anchorExecutor(t, [anchored(true)], { name: 'media' }),
    })
    t.step()
    t.note(`observeUserInput -> ${t.controller.observeUserInput(room)}`)
    t.drain()
  }],
  ['media preservation: a newer request supersedes the loop', (t) => {
    t.controller.beginMediaPreservation({
      conversationId: room, desired: anchorDesired, executor: anchorExecutor(t, [anchored(true)], { name: 'media' }),
    })
    t.step()
    t.controller.beginLiveEdgeNavigation({
      conversationId: room,
      navigationFacts: { unreadMarkerNeedsVisit: false, unreadMarkerAlign: 'start' },
      executor: liveExecutor(t, [liveFrame(true, false)]),
    })
    t.drain()
  }],
  ['layout preservation: divider mutation keeps the reading point', (t) => {
    t.controller.beginLayoutPreservation({
      conversationId: room,
      desired: anchorDesired,
      reason: 'divider-mutation',
      executor: anchorExecutor(t, [anchored(true, 500), anchored(true, 500)], { name: 'layout' }),
    })
    t.drain()
  }],
  ['layout preservation: refused while a message target owns the position', (t) => {
    t.controller.beginExplicitTarget({
      conversationId: room, messageId: 'target-a', executor: targetExecutor(t, [{ kind: 'waiting' }]),
    })
    const request = t.controller.beginLayoutPreservation({
      conversationId: room,
      desired: anchorDesired,
      reason: 'divider-mutation',
      executor: anchorExecutor(t, [anchored(false)], { name: 'layout' }),
    })
    t.note(`request=${request ? 'accepted' : 'null'}`)
  }],
  ['interaction hold: holds, reconciles a new layout, releases and resumes the live edge', (t) => {
    t.controller.beginInteractionHold({
      conversationId: room,
      desired: historyDesired,
      executor: anchorExecutor(t, [anchored(true, 500), anchored(true, 520)], { name: 'hold' }),
    })
    t.step()
    t.note(`reconcile -> ${t.controller.reconcileInteractionHold({
      conversationId: room,
      executor: anchorExecutor(t, [anchored(true, 530), anchored(true, 530)], { name: 'hold2' }),
    })}`)
    t.step()
    t.controller.releaseInteractionHold({
      conversationId: room,
      resume: true,
      liveEdge: liveExecutor(t, [liveFrame(true, false)]),
    })
    t.note(`hasInteractionHold=${t.controller.hasInteractionHold()} position=${t.controller.hasInteractionPosition()}`)
    t.drain()
  }],
  ['interaction hold: release without resuming', (t) => {
    t.controller.beginInteractionHold({
      conversationId: room, desired: historyDesired, executor: anchorExecutor(t, [anchored(false)], { name: 'hold' }),
    })
    t.controller.releaseInteractionHold({ conversationId: room, resume: false, liveEdge: liveExecutor(t, [liveFrame(true, false)]) })
    t.drain()
  }],
  ['interaction hold: held input refuses a new hold', (t) => {
    t.controller.holdInput(room)
    const request = t.controller.beginInteractionHold({
      conversationId: room, desired: historyDesired, executor: anchorExecutor(t, [anchored(false)], { name: 'hold' }),
    })
    t.note(`request=${request ? 'accepted' : 'null'}`)
  }],
]

const historyScenarios: Scenario[] = [
  ['directional history: captured, then one write on the shifted window', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room,
      desired: historyDesired,
      distanceFromBottom: pixelOffset(640),
      executor: historyExecutor(t, [historyFrame(true, false)]),
    })
    t.note(`pending=${t.controller.isDirectionalHistoryPending(room, request!.generation)} holds=${t.controller.holdsDirectionalReading(room, request!.generation)}`)
    t.note(`reconcile -> ${t.controller.reconcileDirectionalHistory({
      conversationId: room, generation: request!.generation, executor: historyExecutor(t, [historyFrame(true, false)]),
    })}`)
    t.note(`pending=${t.controller.isDirectionalHistoryPending(room)}`)
    t.drain()
  }],
  ['directional history: reasserts for the whole budget, no early exit', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room,
      desired: historyDesired,
      distanceFromBottom: pixelOffset(640),
      executor: historyExecutor(t, [historyFrame(true, true)]),
    })
    t.note(`reconcile -> ${t.controller.reconcileDirectionalHistory({
      conversationId: room, generation: request!.generation, executor: historyExecutor(t, [historyFrame(true, true)]),
    })}`)
    t.drain()
  }],
  ['directional history: reasserts, then a frame says it is done', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room,
      desired: historyDesired,
      distanceFromBottom: pixelOffset(640),
      executor: historyExecutor(t, [historyFrame(true, true)]),
    })
    t.controller.reconcileDirectionalHistory({
      conversationId: room,
      generation: request!.generation,
      executor: historyExecutor(t, [historyFrame(true, true), historyFrame(false, true), historyFrame(false, false)]),
    })
    t.drain()
  }],
  ['directional history: first frame unavailable', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room,
      desired: historyDesired,
      distanceFromBottom: pixelOffset(640),
      executor: historyExecutor(t, [{ kind: 'unavailable' }]),
    })
    t.note(`reconcile -> ${t.controller.reconcileDirectionalHistory({
      conversationId: room, generation: request!.generation, executor: historyExecutor(t, [{ kind: 'unavailable' }]),
    })}`)
    t.drain()
  }],
  ['directional history: later frame unavailable', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room, desired: historyDesired, distanceFromBottom: pixelOffset(640), executor: historyExecutor(t, []),
    })
    t.controller.reconcileDirectionalHistory({
      conversationId: room,
      generation: request!.generation,
      executor: historyExecutor(t, [historyFrame(true, true), { kind: 'unavailable' }]),
    })
    t.drain()
  }],
  ['directional history: loop cannot start', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room, desired: historyDesired, distanceFromBottom: pixelOffset(640), executor: historyExecutor(t, []),
    })
    t.controller.reconcileDirectionalHistory({
      conversationId: room,
      generation: request!.generation,
      executor: historyExecutor(t, [historyFrame(true, true)], { loop: { nullLoop: true } }),
    })
    t.drain()
  }],
  ['directional history: frame cannot be scheduled', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room, desired: historyDesired, distanceFromBottom: pixelOffset(640), executor: historyExecutor(t, []),
    })
    t.controller.reconcileDirectionalHistory({
      conversationId: room,
      generation: request!.generation,
      executor: historyExecutor(t, [historyFrame(true, true)], { loop: { failSchedule: true } }),
    })
    t.drain()
  }],
  ['directional history: adapter throws on a frame', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room, desired: historyDesired, distanceFromBottom: pixelOffset(640), executor: historyExecutor(t, []),
    })
    t.controller.reconcileDirectionalHistory({
      conversationId: room, generation: request!.generation, executor: historyExecutor(t, [historyFrame(true, true), 'throw']),
    })
    t.drain()
  }],
  ['directional history: window did not shift', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room, desired: historyDesired, distanceFromBottom: pixelOffset(640), executor: historyExecutor(t, []),
    })
    t.note(`cancel wrong generation -> ${t.controller.cancelDirectionalHistoryWithoutShift({ conversationId: room, generation: request!.generation + 99 })}`)
    t.note(`cancel -> ${t.controller.cancelDirectionalHistoryWithoutShift({ conversationId: room, generation: request!.generation })}`)
    t.note(`pending=${t.controller.isDirectionalHistoryPending(room)}`)
  }],
  ['directional history: anchor no longer reachable drops the request', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room, desired: historyDesired, distanceFromBottom: pixelOffset(640), executor: historyExecutor(t, []),
    })
    t.note(`reconcile -> ${t.controller.reconcileDirectionalHistory({
      conversationId: room,
      generation: request!.generation,
      executor: historyExecutor(t, [historyFrame(true, false)], { reachability: [liveTail] }),
    })}`)
    t.drain()
  }],
  ['directional history: anchor not mounted yet', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room, desired: historyDesired, distanceFromBottom: pixelOffset(640), executor: historyExecutor(t, []),
    })
    t.note(`reconcile -> ${t.controller.reconcileDirectionalHistory({
      conversationId: room,
      generation: request!.generation,
      executor: historyExecutor(t, [historyFrame(true, false)], { reachability: [unmounted] }),
    })}`)
    t.drain()
  }],
  ['directional history: reader input before the first write is ignored, after it takes over', (t) => {
    const request = t.controller.beginDirectionalHistory({
      conversationId: room, desired: historyDesired, distanceFromBottom: pixelOffset(640), executor: historyExecutor(t, []),
    })
    t.note(`input before write -> ${t.controller.observeUserInput(room)}`)
    t.controller.reconcileDirectionalHistory({
      conversationId: room, generation: request!.generation, executor: historyExecutor(t, [historyFrame(true, true)]),
    })
    t.step()
    t.note(`input after write -> ${t.controller.observeUserInput(room)}`)
    t.note(`holds=${t.controller.holdsDirectionalReading(room, request!.generation)}`)
    t.drain()
  }],
  ['directional history: a newer request supersedes the pending shift', (t) => {
    t.controller.beginDirectionalHistory({
      conversationId: room, desired: historyDesired, distanceFromBottom: pixelOffset(640), executor: historyExecutor(t, []),
    })
    t.controller.beginLiveEdgeNavigation({
      conversationId: room,
      navigationFacts: { unreadMarkerNeedsVisit: false, unreadMarkerAlign: 'start' },
      executor: liveExecutor(t, [liveFrame(true, false)]),
    })
    t.note(`pending=${t.controller.isDirectionalHistoryPending(room)}`)
    t.drain()
  }],
]

const scenarios: Scenario[] = [
  ...liveScenarios,
  ...savedScenarios,
  ...unreadScenarios,
  ...targetScenarios,
  ...residentTopScenarios,
  ...anchorScenarios,
  ...historyScenarios,
]

describe('positioning controller frame-by-frame trace', () => {
  it('replays every path exactly as the recorded trace', async () => {
    const out: string[] = []
    for (const [name, run] of scenarios) {
      resetScrollShadowDiagnostics()
      const t = new Trace(name)
      enterLive(t)
      await run(t)
      t.note('end')
      out.push(...t.lines, '')
    }
    expect(NEVER).toBe('\u0000')
    await expect(out.join('\n')).toMatchFileSnapshot('./__traces__/positioningController.trace.txt')
  })

  it('covers each of the seven paths', () => {
    const titles = scenarios.map(([name]) => name)
    for (const prefix of ['live edge', 'saved position', 'unread marker', 'message target', 'resident top', 'media preservation', 'directional history']) {
      expect(titles.some((title) => title.startsWith(prefix)), prefix).toBe(true)
    }
  })
})
