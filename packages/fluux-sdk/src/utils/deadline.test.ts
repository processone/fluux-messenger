import { describe, it, expect, vi, afterEach } from 'vitest'
import { raceDeadline } from './deadline'

describe('raceDeadline', () => {
  afterEach(() => { vi.useRealTimers() })

  it('settles with the work and clears the pending timer', async () => {
    vi.useFakeTimers()
    const result = await raceDeadline(Promise.resolve('done'), 1_000, () => 'late')
    expect(result).toBe('done')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears the timer when the work rejects', async () => {
    vi.useFakeTimers()
    await expect(raceDeadline(Promise.reject(new Error('boom')), 1_000, () => 'late')).rejects.toThrow('boom')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves with the deadline value when the work is too slow', async () => {
    vi.useFakeTimers()
    const result = raceDeadline(new Promise(() => {}), 1_000, () => 'late')
    await vi.advanceTimersByTimeAsync(1_000)
    await expect(result).resolves.toBe('late')
  })

  it('rejects when the deadline callback throws', async () => {
    vi.useFakeTimers()
    const result = raceDeadline(new Promise(() => {}), 1_000, () => { throw new Error('timed out') })
    const assertion = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })
})
