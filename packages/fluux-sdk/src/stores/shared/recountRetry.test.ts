import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRecountRetryScheduler } from './recountRetry'

describe('createRecountRetryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces an invalidation burst and preserves allowActive', async () => {
    const retry = vi.fn(async () => {})
    const scheduler = createRecountRetryScheduler(vi.fn())

    scheduler.schedule('room@example.com', false, retry)
    scheduler.schedule('room@example.com', true, retry)
    scheduler.schedule('room@example.com', false, retry)

    await vi.runAllTimersAsync()

    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith({ allowActive: true })
  })

  it('does not reschedule a retry invalidated while it is running', async () => {
    const scheduler = createRecountRetryScheduler(vi.fn())
    const retry = vi.fn(async () => {
      scheduler.schedule('room@example.com', true, retry)
    })

    scheduler.schedule('room@example.com', true, retry)
    await vi.runAllTimersAsync()
    await vi.runAllTimersAsync()

    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('serializes one trailing retry after an initial recount and bounds further invalidations', async () => {
    let release!: () => void
    let ready = true
    const scheduler = createRecountRetryScheduler(vi.fn())
    const retry = vi.fn(async () => {
      scheduler.schedule('room@example.com', true, retry, () => ready)
    })
    const initial = vi.fn(async () => {
      scheduler.schedule('room@example.com', false, retry, () => ready)
      scheduler.schedule('room@example.com', true, retry, () => ready)
      await new Promise<void>(resolve => { release = resolve })
    })

    scheduler.schedule('room@example.com', false, initial, () => ready, 'initial')
    await vi.runAllTimersAsync()
    expect(initial).toHaveBeenCalledTimes(1)
    expect(retry).not.toHaveBeenCalled()

    ready = false
    release()
    await vi.runAllTimersAsync()
    expect(retry).not.toHaveBeenCalled()

    ready = true
    scheduler.resume('room@example.com')
    await vi.runAllTimersAsync()
    expect(retry).toHaveBeenCalledExactlyOnceWith({ allowActive: true })
    await vi.runAllTimersAsync()
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it.each(['clear', 'cancel'] as const)('drops an initial recount trailing retry on %s', async action => {
    let release!: () => void
    const scheduler = createRecountRetryScheduler(vi.fn())
    const retry = vi.fn(async () => {})
    scheduler.schedule('room@example.com', true, async () => {
      scheduler.schedule('room@example.com', true, retry)
      await new Promise<void>(resolve => { release = resolve })
    }, () => true, 'initial')
    await vi.runAllTimersAsync()

    if (action === 'clear') scheduler.clear()
    else scheduler.cancel('room@example.com')
    release()
    await vi.runAllTimersAsync()
    expect(retry).not.toHaveBeenCalled()

    scheduler.schedule('room@example.com', true, retry)
    await vi.runAllTimersAsync()
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('holds the coalesced retry until its durable boundary is ready', async () => {
    let ready = false
    const retry = vi.fn(async () => {})
    const scheduler = createRecountRetryScheduler(vi.fn())

    scheduler.schedule('room@example.com', true, retry, () => ready)
    await vi.runAllTimersAsync()

    expect(retry).not.toHaveBeenCalled()

    ready = true
    scheduler.resume('room@example.com')
    await vi.runAllTimersAsync()

    expect(retry).toHaveBeenCalledTimes(1)
    expect(retry).toHaveBeenCalledWith({ allowActive: true })
  })

  it('preserves fresh initial requests during a trailing retry without looping automatic retries', async () => {
    const scheduler = createRecountRetryScheduler(vi.fn())
    let release!: () => void
    let calls = 0
    const retry = vi.fn(async () => {
      calls++
      scheduler.schedule('room@example.com', true, retry)
      if (calls === 2) await new Promise<void>(resolve => { release = resolve })
    })
    scheduler.schedule('room@example.com', true, retry, () => true, 'initial')
    await vi.runAllTimersAsync()
    expect(retry).toHaveBeenCalledTimes(2)
    scheduler.schedule('room@example.com', false, retry, () => true, 'initial')
    scheduler.schedule('room@example.com', true, retry, () => true, 'initial')
    release()
    await vi.runAllTimersAsync()
    expect(retry).toHaveBeenCalledTimes(4)
    await vi.runAllTimersAsync()
    expect(retry).toHaveBeenCalledTimes(4)
  })

  it('cancels pending retries when its session is cleared', async () => {
    const retry = vi.fn(async () => {})
    const scheduler = createRecountRetryScheduler(vi.fn())

    scheduler.schedule('room@example.com', false, retry)
    scheduler.clear()
    await vi.runAllTimersAsync()

    expect(retry).not.toHaveBeenCalled()
  })

  it('keeps recreated entity retry ownership when a cancelled retry settles', async () => {
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const retry = vi.fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise((resolve) => { releaseFirst = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { releaseSecond = resolve }))
      .mockImplementation(async () => {})
    const scheduler = createRecountRetryScheduler(vi.fn())

    scheduler.schedule('room@example.com', true, retry)
    await vi.runAllTimersAsync()
    expect(retry).toHaveBeenCalledTimes(1)

    scheduler.cancel('room@example.com')
    scheduler.schedule('room@example.com', true, retry)
    await vi.runAllTimersAsync()
    expect(retry).toHaveBeenCalledTimes(2)

    releaseFirst()
    await vi.runAllTimersAsync()

    scheduler.schedule('room@example.com', true, retry)
    await vi.runAllTimersAsync()
    expect(retry).toHaveBeenCalledTimes(2)

    releaseSecond()
    await vi.runAllTimersAsync()
  })
})
