import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ControllerFrameLoopRegistration } from './controllerFrameLoop'
import type { PinLoopClaim } from './pinLoopClaim'
import type { DirectionalHistoryWindowCoordinator } from './directionalHistoryWindowCoordinator'
const monitorBegin = vi.fn((_label: string, _now: number, _frameBudget?: number) => ({
  frame: () => null,
  end: () => {},
  label: 'marker' as const,
}))
vi.mock('./reassertLoopMonitor', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./reassertLoopMonitor')>()),
  createReassertLoopMonitor: () => ({ begin: monitorBegin, activeCount: () => 0 }),
}))

import {
  useScrollExecutors,
  type ScrollExecutorPorts,
  type UseScrollExecutorsInput,
} from './useScrollExecutors'

function portsHarness(overrides: Partial<ScrollExecutorPorts> = {}) {
  const scroller = document.createElement('div')
  const recordProgrammaticWrite = vi.fn()
  const log = vi.fn()
  const liveWindow = {
    messageCount: 20,
    firstMessageId: 'm-0' as string | undefined,
    windowAtLiveEdge: true as boolean | undefined,
  }
  const ports: ScrollExecutorPorts = {
    getScroller: () => scroller,
    getVirtualizer: () => undefined,
    getActiveConversationId: () => 'room-a',
    getLiveWindow: () => liveWindow,
    getPassiveContext: () => ({ conversationId: 'room-a', virtualizer: undefined }),
    isLoadingOlder: () => false,
    getLoadAround: () => undefined,
    getStoreTargetMessageId: () => null,
    consumeStoreTarget: vi.fn(),
    recordProgrammaticWrite,
    getDirectionalWindow: () => null as DirectionalHistoryWindowCoordinator | null,
    syncPrevMessageCount: vi.fn(),
    pinBottomClaim: () => ({
      renew: vi.fn(),
      release: vi.fn(),
      isHeld: () => false,
    }) as unknown as PinLoopClaim,
    reassertLoopRegistry: {
      current: null as ControllerFrameLoopRegistration | null,
    },
    log,
    ...overrides,
  }
  return { ports, scroller, liveWindow, recordProgrammaticWrite, log }
}

/**
 * Model the caller's identity contract faithfully, because these controls are ABOUT identity.
 *
 * In `useMessageListScroll` these are `useCallback`s: `setMeasuredAtBottom` and
 * `rememberCurrentScrollSnapshot` are stable, `isAtBottomRef` is a ref, and `rememberBottomIntent`
 * changes only with the conversation. A harness that allocates a fresh `vi.fn()` per render makes
 * every factory churn for the wrong reason and silently passes even when the window facts have been
 * dropped from a dependency array.
 */
function baseInput(
  ports: ScrollExecutorPorts,
  overrides: Partial<UseScrollExecutorsInput> = {},
): UseScrollExecutorsInput {
  const conversationId = overrides.conversationId ?? 'room-a'
  return {
    ports,
    conversationId,
    messageCount: 20,
    firstMessageId: 'm-0',
    lastMessageId: 'm-19',
    windowAtLiveEdge: true,
    isLoadingNewer: false,
    onLoadNewer: undefined,
    isAtBottomRef: STABLE_AT_BOTTOM_REF,
    setMeasuredAtBottom: STABLE_SET_MEASURED_AT_BOTTOM,
    rememberBottomIntent: rememberBottomIntentFor(conversationId),
    rememberCurrentScrollSnapshot: STABLE_REMEMBER_SNAPSHOT,
    ...overrides,
  }
}

const STABLE_AT_BOTTOM_REF = { current: true }
const STABLE_SET_MEASURED_AT_BOTTOM = vi.fn()
const STABLE_REMEMBER_SNAPSHOT = vi.fn()
const rememberBottomIntentByConversation = new Map<string, () => void>()
function rememberBottomIntentFor(conversationId: string) {
  const existing = rememberBottomIntentByConversation.get(conversationId)
  if (existing) return existing
  const created = vi.fn()
  rememberBottomIntentByConversation.set(conversationId, created)
  return created
}

describe('useScrollExecutors identity churn', () => {
  // The factories below are dependencies of effects in useMessageListScroll that MUST re-run when
  // the live window moves — the `refresh` live-edge effect exists for exactly that. Holding the
  // factories in a ref, or memoising them on [] , silently stops those effects from re-firing. These
  // controls fail against that "simplification".
  const churnCases: Array<{
    what: string
    change: Partial<UseScrollExecutorsInput>
    churns: Array<keyof ReturnType<typeof useScrollExecutors>>
  }> = [
    {
      what: 'a new message lands (messageCount)',
      change: { messageCount: 21 },
      churns: [
        'createLiveEdgeExecutor',
        'createAnchorPreservationExecutor',
        'buildSavedPositionExecutor',
        'createResidentTopExecutor',
      ],
    },
    {
      what: 'the window slides off the live edge',
      change: { windowAtLiveEdge: false },
      churns: [
        'createLiveEdgeExecutor',
        'createAnchorPreservationExecutor',
        'buildSavedPositionExecutor',
        'createResidentTopExecutor',
      ],
    },
    {
      what: 'the newest message id changes',
      change: { lastMessageId: 'm-20' },
      churns: ['createLiveEdgeExecutor', 'buildSavedPositionExecutor'],
    },
    {
      what: 'a forward-window load starts',
      change: { isLoadingNewer: true },
      churns: ['createLiveEdgeExecutor', 'buildSavedPositionExecutor'],
    },
    {
      what: 'the conversation changes',
      change: { conversationId: 'room-b' },
      churns: ['buildSavedPositionExecutor', 'buildExplicitTargetExecutor'],
    },
  ]

  it.each(churnCases)('re-creates its factories when $what', ({ change, churns }) => {
    const { ports } = portsHarness()
    const { result, rerender } = renderHook(
      (input: UseScrollExecutorsInput) => useScrollExecutors(input),
      { initialProps: baseInput(ports) },
    )
    const before = { ...result.current }

    rerender(baseInput(ports, change))

    for (const key of churns) {
      expect(
        result.current[key],
        `${String(key)} must not be frozen across a window change`,
      ).not.toBe(before[key])
    }
  })

  it('keeps a stable identity for the two lifecycle escape hatches', () => {
    const { ports } = portsHarness()
    const { result, rerender } = renderHook(
      (input: UseScrollExecutorsInput) => useScrollExecutors(input),
      { initialProps: baseInput(ports) },
    )
    const before = { ...result.current }

    // Both are consumed by effects that must NOT re-run on ordinary appends.
    rerender(baseInput(ports, { messageCount: 21, lastMessageId: 'm-20' }))
    expect(result.current.resetLiveEdgeRepaintDebt).toBe(before.resetLiveEdgeRepaintDebt)
    expect(result.current.disposeDirectionalHistoryBrowser).toBe(
      before.disposeDirectionalHistoryBrowser,
    )
    expect(result.current.getDirectionalHistoryBrowser).toBe(
      before.getDirectionalHistoryBrowser,
    )
  })
})

describe('useScrollExecutors adapter ownership', () => {
  it('shares one live-edge adapter across executors so a repaint burst can coalesce', () => {
    let scrollTop = 0
    let repaints = 0
    const scroller = document.createElement('div')
    Object.defineProperties(scroller, {
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (v: number) => { scrollTop = v },
      },
      scrollHeight: { configurable: true, get: () => 2_000 },
      clientHeight: { configurable: true, get: () => 600 },
      // Only the stale-paint repair forces layout between its two overflowY writes.
      offsetHeight: { configurable: true, get: () => { repaints += 1; return 600 } },
    })
    const virtualizer = {
      getVirtualItems: () => [],
      getTotalSize: () => 2_000,
      itemCount: 20,
      getOffsetForMessageId: vi.fn(() => 0),
      getIndexForMessageId: vi.fn(() => 0),
      ensureMessageMounted: vi.fn(async () => {}),
      measureElement: vi.fn(),
      scrollToOffset: vi.fn(),
      scrollToIndex: vi.fn(() => { scrollTop = 1_400 }),
      beginAnimatedScrollToOffset: vi.fn(),
    }
    const { ports } = portsHarness({
      getScroller: () => scroller,
      getVirtualizer: () => virtualizer,
    })
    const { result, rerender } = renderHook(
      (input: UseScrollExecutorsInput) => useScrollExecutors(input),
      { initialProps: baseInput(ports) },
    )
    const lease = {
      conversationId: 'room-a',
      generation: 1,
      operation: 1,
      frameBudget: 60,
      signal: new AbortController().signal,
      isCurrent: () => true,
      markApplied: () => true,
      settle: () => true,
    }
    const request = {
      generation: 1,
      conversationId: 'room-a',
      source: { kind: 'entry', reason: 'live-edge' },
      desired: { kind: 'live-edge', follow: true },
    } as Parameters<
      ReturnType<typeof useScrollExecutors>['createLiveEdgeExecutor'] extends
        (...a: never[]) => infer E ? E extends { positionFrame: infer P } ? P : never : never
    >[0]

    // An isolated first arrival paints promptly.
    result.current.createLiveEdgeExecutor('new-message').positionFrame(request, lease)
    expect(repaints).toBe(1)

    // A second arrival built from a LATER render must join the first one's burst and be suppressed.
    // Giving each executor its own adapter resets the burst, so this would repaint again.
    scrollTop = 0
    rerender(baseInput(ports, { messageCount: 21 }))
    result.current.createLiveEdgeExecutor('new-message').positionFrame(request, lease)
    expect(repaints).toBe(1)
  })

  it('reads ports through a ref rather than freezing the first render', () => {
    const harness = portsHarness()
    const { result, rerender } = renderHook(
      (input: UseScrollExecutorsInput) => useScrollExecutors(input),
      { initialProps: baseInput(harness.ports) },
    )
    const executor = result.current.createLiveEdgeExecutor('marker-fallback')
    expect(executor.reachability()).not.toEqual({ kind: 'empty-window' })

    // A later render supplies a fresh ports object describing an empty window. The executor built
    // earlier must observe it: a live-edge executor outlives the render that built it.
    const emptied = portsHarness({
      getLiveWindow: () => ({
        messageCount: 0,
        firstMessageId: undefined,
        windowAtLiveEdge: true,
      }),
    })
    rerender(baseInput(emptied.ports))
    expect(executor.reachability()).toEqual({ kind: 'empty-window' })
  })

  it('builds the directional-history executor here, not at the call site', () => {
    const { ports } = portsHarness()
    const { result } = renderHook(
      (input: UseScrollExecutorsInput) => useScrollExecutors(input),
      { initialProps: baseInput(ports) },
    )
    const saved = { requestId: 1, restored: false } as Parameters<
      typeof result.current.buildDirectionalHistoryExecutor
    >[0]

    // The hook must hand back a whole executor. Exposing only the completion callback pushes
    // createExecutor back into useMessageListScroll and reopens the construction boundary.
    const executor = result.current.buildDirectionalHistoryExecutor(saved)
    expect(typeof executor.reachability).toBe('function')
    expect(typeof executor.positionFrame).toBe('function')
    expect(typeof executor.beginLoop).toBe('function')
    expect(typeof executor.complete).toBe('function')

    // Each load gets its own executor: the completion closes over that load's snapshot.
    expect(result.current.buildDirectionalHistoryExecutor(saved)).not.toBe(executor)
  })

  it('disposes the directional adapter only when it is still the current one', () => {
    const { ports } = portsHarness()
    const { result } = renderHook(
      (input: UseScrollExecutorsInput) => useScrollExecutors(input),
      { initialProps: baseInput(ports) },
    )

    const browser = result.current.getDirectionalHistoryBrowser()
    expect(result.current.getDirectionalHistoryBrowser()).toBe(browser)

    result.current.disposeDirectionalHistoryBrowser()
    // A rebuild after disposal must hand out a fresh adapter, not the disposed one.
    expect(result.current.getDirectionalHistoryBrowser()).not.toBe(browser)
  })
})

describe('useScrollExecutors monitor wiring', () => {
  it("hands the monitor the lease's frame budget", () => {
    // The non-converging threshold is a fraction of the budget. Drop the budget here and every
    // loop silently reverts to the flat threshold — unreachable for the short loops — with
    // nothing else in the codebase noticing.
    monitorBegin.mockClear()
    const { ports } = portsHarness()
    const { result } = renderHook(
      (input: UseScrollExecutorsInput) => useScrollExecutors(input),
      { initialProps: baseInput(ports) },
    )
    result.current.buildUnreadMarkerExecutor().beginLoop({
      conversationId: 'room-a',
      generation: 1,
      operation: 1,
      frameBudget: 30,
      signal: new AbortController().signal,
      isCurrent: () => true,
      markApplied: () => true,
      settle: () => true,
    })

    expect(monitorBegin).toHaveBeenCalledTimes(1)
    expect(monitorBegin.mock.calls[0]?.[2]).toBe(30)
  })
})
