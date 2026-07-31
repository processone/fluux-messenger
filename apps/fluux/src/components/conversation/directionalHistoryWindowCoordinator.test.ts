import { describe, expect, it } from 'vitest'
import {
  DirectionalHistoryWindowCoordinator,
  type BeginDirectionalHistoryInput,
} from './directionalHistoryWindowCoordinator'

function input(
  overrides: Partial<BeginDirectionalHistoryInput> = {},
): BeginDirectionalHistoryInput {
  return {
    conversationId: 'room-a',
    direction: 'older',
    mode: 'automatic',
    now: 1_000,
    loaderAvailable: true,
    loading: false,
    historyComplete: false,
    windowAtLiveEdge: true,
    travelledAway: false,
    capture: () => ({
      anchorMessageId: 'message-8',
      anchorOffsetFromTop: -12,
      distanceFromBottom: 640,
      firstMessageId: 'message-1',
      messageCount: 20,
    }),
    ...overrides,
  }
}

describe('DirectionalHistoryWindowCoordinator', () => {
  it('owns the automatic cooldown while genuine boundary travel may bypass it', () => {
    const coordinator = new DirectionalHistoryWindowCoordinator(500)

    const first = coordinator.begin(input())
    const blocked = coordinator.begin(input({ now: 1_200 }))
    const travelled = coordinator.begin(input({
      now: 1_200,
      travelledAway: true,
    }))

    expect(first.kind).toBe('started')
    expect(blocked).toEqual({ kind: 'blocked', reason: 'cooldown' })
    expect(travelled.kind).toBe('started')
    if (travelled.kind === 'started') {
      expect(travelled.clearTravel).toBe(true)
      expect(travelled.snapshot.requestId).not.toBe(
        first.kind === 'started' ? first.snapshot.requestId : -1,
      )
    }
  })

  it('owns direction-specific availability and explicit older-load eligibility', () => {
    const coordinator = new DirectionalHistoryWindowCoordinator(500)
    let captures = 0

    expect(coordinator.begin(input({
      loaderAvailable: false,
      capture: () => {
        captures += 1
        return input().capture()
      },
    }))).toEqual({
      kind: 'blocked',
      reason: 'unavailable',
    })
    expect(captures).toBe(0)
    expect(coordinator.begin(input({ loading: true }))).toEqual({
      kind: 'blocked',
      reason: 'loading',
    })
    expect(coordinator.begin(input({ historyComplete: true }))).toEqual({
      kind: 'blocked',
      reason: 'history-complete',
    })
    expect(coordinator.begin(input({
      direction: 'newer',
      windowAtLiveEdge: true,
    }))).toEqual({ kind: 'blocked', reason: 'live-edge' })

    const explicit = coordinator.begin(input({
      mode: 'explicit',
      now: 10,
    }))
    expect(explicit.kind).toBe('started')
    if (explicit.kind === 'started') {
      expect(explicit.clearTravel).toBe(false)
    }
  })

  it('blocks automatic older loads briefly after an applied restore', () => {
    const coordinator = new DirectionalHistoryWindowCoordinator(500)
    const started = coordinator.begin(input())
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return

    coordinator.markRestored(started.snapshot.requestId, 1_100)

    expect(coordinator.begin(input({
      now: 1_200,
      travelledAway: true,
    }))).toEqual({ kind: 'blocked', reason: 'recently-restored' })
    expect(coordinator.begin(input({
      now: 1_601,
      travelledAway: true,
    })).kind).toBe('started')
  })

  it('bounds a no-shift snapshot to the exact load that armed it', () => {
    const coordinator = new DirectionalHistoryWindowCoordinator(0)
    coordinator.enterConversation('room-a', true)
    const first = coordinator.begin(input({ mode: 'explicit', now: 1 }))
    const second = coordinator.begin(input({ mode: 'explicit', now: 2 }))
    expect(first.kind).toBe('started')
    expect(second.kind).toBe('started')
    if (first.kind !== 'started' || second.kind !== 'started') return
    coordinator.attachGeneration(first.snapshot.requestId, 10)
    coordinator.attachGeneration(second.snapshot.requestId, 11)

    coordinator.markLoadSettled(first.snapshot.requestId)
    expect(coordinator.releaseSettledWithoutShift({
      requestId: first.snapshot.requestId,
      conversationId: 'room-a',
      firstMessageId: 'message-1',
    })).toEqual({ kind: 'none' })
    expect(coordinator.activeSnapshot('room-a')?.requestId).toBe(
      second.snapshot.requestId,
    )

    coordinator.markLoadSettled(second.snapshot.requestId)
    expect(coordinator.releaseSettledWithoutShift({
      requestId: second.snapshot.requestId,
      conversationId: 'room-a',
      firstMessageId: 'message-1',
    })).toMatchObject({
      kind: 'cancel',
      generation: 11,
      snapshot: { requestId: second.snapshot.requestId },
    })
  })

  it('keeps an in-flight snapshot for the shift it produces, then ignores settlement', () => {
    const coordinator = new DirectionalHistoryWindowCoordinator(0)
    coordinator.enterConversation('room-a', true)
    const started = coordinator.begin(input({ mode: 'explicit' }))
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    coordinator.attachGeneration(started.snapshot.requestId, 12)

    expect(coordinator.observeWindow({
      conversationId: 'room-a',
      firstMessageId: 'older-1',
    })).toMatchObject({
      kind: 'reconcile',
      generation: 12,
      snapshot: { requestId: started.snapshot.requestId },
    })
    expect(coordinator.isPendingWindowShift('room-a', 'older-1')).toBe(true)
    coordinator.markRestored(started.snapshot.requestId, 1_100)
    coordinator.markLoadSettled(started.snapshot.requestId)
    expect(coordinator.releaseSettledWithoutShift({
      requestId: started.snapshot.requestId,
      conversationId: 'room-a',
      firstMessageId: 'older-1',
    })).toEqual({ kind: 'none' })
  })

  it('does not let a departed conversation settle or observe into the active conversation', () => {
    const coordinator = new DirectionalHistoryWindowCoordinator(0)
    coordinator.enterConversation('room-a', true)
    const departed = coordinator.begin(input({ mode: 'explicit' }))
    expect(departed.kind).toBe('started')
    if (departed.kind !== 'started') return
    coordinator.attachGeneration(departed.snapshot.requestId, 12)

    coordinator.enterConversation('room-b', false)

    expect(coordinator.activeSnapshot('room-a')).toBeNull()
    expect(coordinator.activeSnapshot('room-b')).toBeNull()
    expect(coordinator.markLoadSettled(departed.snapshot.requestId)).toBe(false)
    expect(coordinator.releaseSettledWithoutShift({
      requestId: departed.snapshot.requestId,
      conversationId: 'room-a',
      firstMessageId: 'message-1',
    })).toEqual({ kind: 'none' })
    expect(coordinator.observeWindow({
      conversationId: 'room-a',
      firstMessageId: 'older-1',
    })).toEqual({ kind: 'none' })

    const active = coordinator.begin(input({
      conversationId: 'room-b',
      direction: 'newer',
      mode: 'explicit',
      windowAtLiveEdge: false,
      now: 2_000,
    }))
    expect(active.kind).toBe('started')
    if (active.kind !== 'started') return

    expect(coordinator.markLoadSettled(departed.snapshot.requestId)).toBe(false)
    expect(coordinator.activeSnapshot('room-b')?.requestId).toBe(
      active.snapshot.requestId,
    )
  })

  it('cancels only on a false-to-true live-window transition', () => {
    const coordinator = new DirectionalHistoryWindowCoordinator(0)
    coordinator.enterConversation('room-a', false)
    const started = coordinator.begin(input({
      mode: 'explicit',
      direction: 'newer',
      windowAtLiveEdge: false,
    }))
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    coordinator.attachGeneration(started.snapshot.requestId, 13)

    expect(coordinator.observeLiveEdge('room-a', false)).toEqual({
      kind: 'none',
    })
    expect(coordinator.observeLiveEdge('room-a', true)).toMatchObject({
      kind: 'cancel',
      generation: 13,
    })
    expect(coordinator.observeLiveEdge('room-a', true)).toEqual({
      kind: 'none',
    })
  })

  it('owns invocation settlement for promises and synchronous failures', async () => {
    const coordinator = new DirectionalHistoryWindowCoordinator(0)
    const started = coordinator.begin(input({ mode: 'explicit' }))
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') return
    let resolve!: () => void
    const promise = new Promise<void>((done) => { resolve = done })
    const settled: number[] = []

    coordinator.invokeLoad(
      started.snapshot,
      () => promise,
      (requestId) => settled.push(requestId),
    )
    expect(settled).toEqual([])
    resolve()
    await promise
    await Promise.resolve()
    expect(settled).toEqual([started.snapshot.requestId])
    expect(coordinator.activeSnapshot('room-a')?.loadSettled).toBe(true)

    const throwing = coordinator.begin(input({ mode: 'explicit', now: 2_000 }))
    expect(throwing.kind).toBe('started')
    if (throwing.kind !== 'started') return
    expect(() => coordinator.invokeLoad(
      throwing.snapshot,
      () => { throw new Error('load failed') },
      (requestId) => settled.push(requestId),
    )).toThrow('load failed')
    expect(settled).toContain(throwing.snapshot.requestId)
  })
})
