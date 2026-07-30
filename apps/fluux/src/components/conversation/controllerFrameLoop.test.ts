import { describe, expect, it, vi } from 'vitest'
import {
  createControllerFrameLoop,
  type ControllerFrameLoopLifecycle,
  type ControllerFrameLoopRegistry,
} from './controllerFrameLoop'
import { createPinLoopClaim } from './pinLoopClaim'

function harness(lifecycle?: ControllerFrameLoopLifecycle) {
  let current = true
  const callbacks: Array<() => void> = []
  const end = vi.fn()
  const frame = vi.fn(() => null)
  const registry: ControllerFrameLoopRegistry = { current: null }
  const cancelFrame = vi.fn()
  const supersede = vi.fn(() => {
    const active = registry.current
    if (!active) return
    active.finish()
  })
  const loop = createControllerFrameLoop({
    lease: { isCurrent: () => current },
    supersede,
    beginHandle: () => ({ frame, end }),
    registry,
    requestFrame: (callback) => {
      callbacks.push(callback)
      return callbacks.length
    },
    cancelFrame,
    now: () => 100,
    warn: vi.fn(),
    lifecycle,
  })
  if (!loop) throw new Error('expected a current loop')
  return {
    loop,
    callbacks,
    end,
    frame,
    registry,
    cancelFrame,
    makeStale: () => {
      current = false
    },
  }
}

describe('controller frame-loop lifecycle', () => {
  it('finishes a started loop when its lease is stale before scheduling', () => {
    const run = harness()

    run.makeStale()
    run.loop.schedule(vi.fn())

    expect(run.end).toHaveBeenCalledOnce()
    expect(run.registry.current).toBeNull()
  })

  it('finishes instead of invoking a queued callback after its lease becomes stale', () => {
    const run = harness()
    const callback = vi.fn()
    run.loop.schedule(callback)

    run.makeStale()
    run.callbacks.shift()!()

    expect(callback).not.toHaveBeenCalled()
    expect(run.end).toHaveBeenCalledOnce()
    expect(run.registry.current).toBeNull()
  })

  it('finishes when a scheduled controller callback throws', () => {
    const run = harness()
    run.loop.schedule(() => {
      throw new Error('controller frame failed')
    })

    expect(() => run.callbacks.shift()!()).toThrow('controller frame failed')
    expect(run.end).toHaveBeenCalledOnce()
    expect(run.registry.current).toBeNull()
  })

  it('finishes when requestAnimationFrame scheduling throws', () => {
    const end = vi.fn()
    const registry: ControllerFrameLoopRegistry = { current: null }
    const loop = createControllerFrameLoop({
      lease: { isCurrent: () => true },
      supersede: vi.fn(),
      beginHandle: () => ({ frame: () => null, end }),
      registry,
      requestFrame: () => {
        throw new Error('scheduler failed')
      },
      cancelFrame: vi.fn(),
      now: () => 100,
      warn: vi.fn(),
    })!

    expect(() => loop.schedule(vi.fn())).toThrow('scheduler failed')
    expect(end).toHaveBeenCalledOnce()
    expect(registry.current).toBeNull()
  })

  it('releases the live-edge pin claim when a queued frame discovers a stale lease', () => {
    const claim = createPinLoopClaim()
    const run = harness({
      onStart: claim.renew,
      onFrame: claim.renew,
      onFinish: claim.release,
    })
    expect(claim.isHeld()).toBe(true)
    run.loop.schedule(vi.fn())

    run.makeStale()
    run.callbacks.shift()!()

    expect(claim.isHeld()).toBe(false)
    expect(run.end).toHaveBeenCalledOnce()
  })

  it('runs terminal cleanup once even when monitor cleanup throws', () => {
    const onFinish = vi.fn()
    const run = harness({ onFinish })
    run.end.mockImplementation(() => {
      throw new Error('monitor cleanup failed')
    })

    expect(() => run.loop.finish()).toThrow('monitor cleanup failed')
    expect(onFinish).toHaveBeenCalledOnce()
    expect(run.registry.current).toBeNull()

    run.loop.finish()
    expect(onFinish).toHaveBeenCalledOnce()
  })
})
