import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { DirectionalHistoryBrowserAdapter } from './directionalHistoryBrowserAdapter'
import type { DirectionalHistoryWindowCoordinator } from './directionalHistoryWindowCoordinator'
import type { DirectionalHistoryExecutor } from './positioningController'
import {
  useDirectionalHistoryLoads,
  type DirectionalHistoryLoadPorts,
  type UseDirectionalHistoryLoadsInput,
} from './useDirectionalHistoryLoads'

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  requestId: 1,
  conversationId: 'room-a',
  direction: 'older' as const,
  anchorMessageId: 'm-5',
  anchorOffsetFromTop: 120,
  distanceFromBottom: 900,
  oldFirstId: 'm-0',
  oldMessageCount: 200,
  restored: false,
  ...overrides,
})

function harness(input: {
  available?: boolean
  beginResult?: unknown
  requestGeneration?: number | null
} = {}) {
  const scheduleSettlement = vi.fn((_callback: () => void) => {})
  const browser = {
    isAvailable: () => input.available ?? true,
    capture: vi.fn(() => ({
      facts: {
        anchorMessageId: 'm-5',
        anchorOffsetFromTop: 120,
        distanceFromBottom: 900,
        firstMessageId: 'm-0',
        messageCount: 200,
      },
      anchor: { messageId: 'm-5' },
      geometry: { scrollTop: 100, scrollHeight: 5_000, clientHeight: 600 },
    })),
    scheduleSettlement,
  } as unknown as DirectionalHistoryBrowserAdapter

  const begin = vi.fn((_input: Record<string, unknown>) =>
    input.beginResult === undefined
      ? { kind: 'started', snapshot: snapshot(), clearTravel: false }
      : input.beginResult,
  )
  const invokeLoad = vi.fn(
    (
      _saved: unknown,
      _run: () => unknown,
      _settle: (requestId: number) => void,
    ) => {},
  )
  const attachGeneration = vi.fn()
  const releaseSettledWithoutShift = vi.fn(() => ({ kind: 'none' as const }))
  const coordinator = {
    begin,
    invokeLoad,
    attachGeneration,
    releaseSettledWithoutShift,
  } as unknown as DirectionalHistoryWindowCoordinator

  const beginDirectionalHistory = vi.fn(() =>
    input.requestGeneration === null
      ? null
      : { generation: input.requestGeneration ?? 42 },
  )
  const cancelWithoutShift = vi.fn()
  const clearTravel = vi.fn()
  const hasTravelledAway = vi.fn(() => true)

  // A FRESH ports object per render, exactly as the caller supplies it. Reusing one object would
  // let a `[ports]` dependency look stable and hide an identity regression.
  const makePorts = (): DirectionalHistoryLoadPorts => ({
    getBrowser: () => browser,
    getCoordinator: () => coordinator,
    getActiveConversationId: () => 'room-a',
    getLiveWindow: () => ({ messageCount: 250, firstMessageId: 'older-0' }),
    hasTravelledAway,
    clearTravel,
    buildExecutor: vi.fn(() => ({}) as DirectionalHistoryExecutor),
    beginDirectionalHistory,
    cancelWithoutShift,
    log: vi.fn(),
  })

  const makeProps = (
    overrides: Partial<UseDirectionalHistoryLoadsInput> = {},
  ): UseDirectionalHistoryLoadsInput => ({
    ports: makePorts(),
    conversationId: 'room-a',
    firstMessageId: 'm-0',
    messageCount: 200,
    windowAtLiveEdge: false,
    isLoadingOlder: false,
    isLoadingNewer: false,
    isHistoryComplete: false,
    onScrollToTop: vi.fn(),
    onLoadNewer: vi.fn(),
    ...overrides,
  })

  const rendered = renderHook(
    (p: UseDirectionalHistoryLoadsInput) => useDirectionalHistoryLoads(p),
    { initialProps: makeProps() },
  )
  return {
    ...rendered,
    makeProps,
    browser,
    begin,
    invokeLoad,
    attachGeneration,
    releaseSettledWithoutShift,
    beginDirectionalHistory,
    cancelWithoutShift,
    clearTravel,
    hasTravelledAway,
    scheduleSettlement,
  }
}

describe('useDirectionalHistoryLoads', () => {
  it('keeps applyReleaseDecision stable so the live-edge effect does not re-fire on appends', () => {
    const h = harness()
    const before = h.result.current.applyReleaseDecision
    h.rerender(h.makeProps({ messageCount: 201, firstMessageId: 'm-1' }))
    h.rerender(h.makeProps({ messageCount: 202 }))
    expect(h.result.current.applyReleaseDecision).toBe(before)
  })

  it('cancels only for a cancel decision', () => {
    const h = harness()
    h.result.current.applyReleaseDecision({ kind: 'none' })
    expect(h.cancelWithoutShift).not.toHaveBeenCalled()

    h.result.current.applyReleaseDecision({
      kind: 'cancel',
      generation: 7,
      snapshot: snapshot(),
    } as Parameters<typeof h.result.current.applyReleaseDecision>[0])
    expect(h.cancelWithoutShift).toHaveBeenCalledWith({
      conversationId: 'room-a',
      generation: 7,
    })
  })

  it('does not consult the coordinator when the browser cannot capture', () => {
    const h = harness({ available: false })
    h.result.current.triggerLoadOlder()
    expect(h.begin).not.toHaveBeenCalled()
    expect(h.invokeLoad).not.toHaveBeenCalled()
  })

  it('starts no request and no load when the coordinator blocks', () => {
    const h = harness({
      beginResult: { kind: 'blocked', reason: 'recently-restored' },
    })
    h.result.current.triggerLoadOlder()
    expect(h.beginDirectionalHistory).not.toHaveBeenCalled()
    expect(h.invokeLoad).not.toHaveBeenCalled()
  })

  it('submits a top-offset anchor request and attaches its generation', () => {
    const h = harness()
    h.result.current.triggerLoadOlder()

    expect(h.beginDirectionalHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'room-a',
        desired: {
          kind: 'anchor',
          messageId: 'm-5',
          placement: { kind: 'top-offset', offsetPx: 120 },
        },
        distanceFromBottom: 900,
      }),
    )
    expect(h.attachGeneration).toHaveBeenCalledWith(1, 42)
    expect(h.invokeLoad).toHaveBeenCalledOnce()
  })

  it('still runs the load when the controller declines to create a request', () => {
    // The batch must not be stranded just because positioning is unavailable.
    const h = harness({ requestGeneration: null })
    h.result.current.triggerLoadOlder()
    expect(h.attachGeneration).not.toHaveBeenCalled()
    expect(h.invokeLoad).toHaveBeenCalledOnce()
  })

  it('clears the travel latch only when the coordinator asks', () => {
    const h = harness()
    h.result.current.triggerLoadOlder()
    expect(h.clearTravel).not.toHaveBeenCalled()

    const asked = harness({
      beginResult: { kind: 'started', snapshot: snapshot(), clearTravel: true },
    })
    asked.result.current.triggerLoadOlder()
    expect(asked.clearTravel).toHaveBeenCalledWith('room-a', 'top')
  })

  it('routes each direction to its own loader, edge and in-flight flag', () => {
    const h = harness()
    h.result.current.triggerLoadOlder()
    expect(h.begin.mock.calls[0][0]).toMatchObject({
      direction: 'older',
      mode: 'automatic',
      loaderAvailable: true,
      loading: false,
    })
    expect(h.hasTravelledAway).toHaveBeenLastCalledWith('room-a', 'top')

    h.begin.mockClear()
    h.result.current.triggerLoadNewer()
    expect(h.begin.mock.calls[0][0]).toMatchObject({ direction: 'newer' })
    expect(h.hasTravelledAway).toHaveBeenLastCalledWith('room-a', 'bottom')
  })

  it('marks the explicit command so it can bypass the travel requirement', () => {
    const h = harness()
    h.result.current.handleLoadEarlier()
    expect(h.begin.mock.calls[0][0]).toMatchObject({
      direction: 'older',
      mode: 'explicit',
    })
  })

  it('reports the in-flight loading flag for the requested direction only', () => {
    const h = harness()
    h.rerender(h.makeProps({ isLoadingOlder: true }))
    h.result.current.triggerLoadOlder()
    expect(h.begin.mock.calls[0][0]).toMatchObject({ loading: true })

    h.begin.mockClear()
    h.result.current.triggerLoadNewer()
    expect(h.begin.mock.calls[0][0]).toMatchObject({ loading: false })
  })

  it('settles against the CURRENT live window, not the one captured at load start', () => {
    const h = harness()
    h.result.current.triggerLoadOlder()
    h.invokeLoad.mock.calls[0][2](1)
    // scheduleSettlement received the callback; run it as the adapter's frame would.
    h.scheduleSettlement.mock.calls[0][0]()
    // A load that shifted the window changes firstMessageId; releasing against a stale value would
    // cancel a request that actually landed.
    expect(h.releaseSettledWithoutShift).toHaveBeenCalledWith({
      requestId: 1,
      conversationId: 'room-a',
      firstMessageId: 'older-0',
    })
  })
})
