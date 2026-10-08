import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.fn()
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }))

import { finishSendsInBackground, sendsSettled, trackSend } from './pendingSends'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

function track(promise: Promise<void>) {
  const state = { done: false }
  void promise.then(() => { state.done = true })
  return state
}

describe('pending sends', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    invoke.mockReset()
    invoke.mockImplementation(async (command: string) => (command === 'plugin:background-task|begin' ? { id: 7 } : undefined))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('waits for tracked sends, then for the server acknowledgement', async () => {
    const send = deferred()
    const acknowledged = deferred()
    const whenSentAcknowledged = vi.fn(() => acknowledged.promise)
    void trackSend(send.promise)
    const state = track(sendsSettled(whenSentAcknowledged))

    await vi.advanceTimersByTimeAsync(0)
    expect(whenSentAcknowledged).not.toHaveBeenCalled()
    send.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(whenSentAcknowledged).toHaveBeenCalledTimes(1)
    expect(state.done).toBe(false)
    acknowledged.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.done).toBe(true)
  })

  it('also waits for a send started while waiting, and for a failed one', async () => {
    const first = deferred()
    const second = deferred()
    const whenSentAcknowledged = vi.fn(async () => {})
    void trackSend(first.promise)
    const state = track(sendsSettled(whenSentAcknowledged))

    trackSend(second.promise.then(() => { throw new Error('upload failed') })).catch(() => {})
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.done).toBe(false)
    second.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(state.done).toBe(true)
  })

  it('holds a background task until the sends settle', async () => {
    const acknowledged = deferred()
    const state = track(finishSendsInBackground(() => acknowledged.promise))

    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledWith('plugin:background-task|begin')
    expect(invoke).not.toHaveBeenCalledWith('plugin:background-task|end', expect.anything())
    acknowledged.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke).toHaveBeenCalledWith('plugin:background-task|end', { id: 7 })
    expect(state.done).toBe(true)
  })

  it('ends the background task before iOS expires it', async () => {
    const state = track(finishSendsInBackground(() => new Promise<void>(() => {})))

    await vi.advanceTimersByTimeAsync(24_000)
    expect(state.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(invoke).toHaveBeenCalledWith('plugin:background-task|end', { id: 7 })
    expect(state.done).toBe(true)
  })
})
