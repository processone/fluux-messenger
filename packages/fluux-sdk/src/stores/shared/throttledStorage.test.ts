import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { localStorageMock } from '../../core/sideEffects.testHelpers'
import { schedule, flushKey, cancel, flush, _resetForTesting } from './throttledStorage'

Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true })

const KEY = 'test-key'
const OTHER = 'other-key'

function writeCount(): number {
  return localStorageMock.setItem.mock.calls.length
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  localStorageMock.setItem.mockClear()
  _resetForTesting()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('throttledStorage', () => {
  it('writes immediately on the leading edge', () => {
    schedule(KEY, () => 'a')
    expect(localStorage.getItem(KEY)).toBe('a')
    expect(writeCount()).toBe(1)
  })

  it('coalesces N schedules in one window into 2 writes', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    schedule(KEY, () => 'c')
    schedule(KEY, () => 'd')
    expect(writeCount()).toBe(1)
    vi.advanceTimersByTime(1000)
    expect(writeCount()).toBe(2)
    expect(localStorage.getItem(KEY)).toBe('d')
  })

  // The control that kills a leading-edge-only implementation: it passes the
  // write-count assertions above and fails this one.
  it('flush writes the LATEST pending value, not the first', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    flush()
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  it('does not invoke produce for coalesced writes', () => {
    const produce = vi.fn(() => 'x')
    schedule(KEY, () => 'first')
    schedule(KEY, produce)
    schedule(KEY, () => 'last')
    expect(produce).not.toHaveBeenCalled()
  })

  it('keeps writing during a sustained burst, ~1 per window', () => {
    schedule(KEY, () => 'v0')
    for (let i = 1; i <= 5; i++) {
      schedule(KEY, () => `v${i}`)
      vi.advanceTimersByTime(1000)
    }
    // 1 leading + 5 trailing
    expect(writeCount()).toBe(6)
    expect(localStorage.getItem(KEY)).toBe('v5')
  })

  it('cancel drops the pending write', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    cancel(KEY)
    vi.advanceTimersByTime(5000)
    expect(localStorage.getItem(KEY)).toBe('a')
    expect(writeCount()).toBe(1)
  })

  it('flushKey writes the pending thunk for one key only', () => {
    schedule(KEY, () => 'a')
    schedule(OTHER, () => 'x')
    schedule(KEY, () => 'b')
    schedule(OTHER, () => 'y')
    flushKey(KEY)
    expect(localStorage.getItem(KEY)).toBe('b')
    expect(localStorage.getItem(OTHER)).toBe('x')
  })

  it('flushKey with nothing pending performs zero writes', () => {
    schedule(KEY, () => 'a')
    localStorageMock.setItem.mockClear()
    flushKey(KEY)
    expect(writeCount()).toBe(0)
  })

  it('closes the window, so the next schedule writes immediately', () => {
    schedule(KEY, () => 'a')
    flushKey(KEY)
    schedule(KEY, () => 'b')
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  // Guards the quiet-close branch of onTimer: a window that expires with
  // NOTHING pending must delete the entry, not just leave the timer to rot.
  // If `entries.delete(key)` were dropped there, the stale entry would
  // survive with a dead timer id, and the next `schedule()` would see a
  // truthy entry, stash into `pending`, and never arm a new timer — losing
  // the write silently until something else flushes the key.
  it('closes the window after a quiet period, so the next schedule is a leading edge', () => {
    schedule(KEY, () => 'a') // leading edge; window opens
    vi.advanceTimersByTime(1000) // fires with NOTHING pending -> quiet close
    expect(vi.getTimerCount()).toBe(0)

    localStorageMock.setItem.mockClear()
    schedule(KEY, () => 'b') // must take a fresh leading edge
    expect(localStorage.getItem(KEY)).toBe('b')
    expect(localStorageMock.setItem.mock.calls.length).toBe(1)
  })

  it('pagehide flushes pending writes', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    window.dispatchEvent(new Event('pagehide'))
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  it('a failed leading write leaves no window and no timer', () => {
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => schedule(KEY, () => 'a')).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    // The next save must write immediately, not be coalesced behind a window
    // that is guarding a write which never landed.
    schedule(KEY, () => 'b')
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  it('a failed trailing write closes the window instead of rearming', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    schedule(KEY, () => 'c')
    expect(localStorage.getItem(KEY)).toBe('c')
  })

  it('a throwing produce on the trailing edge leaves no timer armed', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => {
      throw new Error('serialize failed')
    })
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    schedule(KEY, () => 'c')
    expect(localStorage.getItem(KEY)).toBe('c')
  })

  it('a throwing produce inside flush and flushKey does not propagate', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => {
      throw new Error('serialize failed')
    })
    expect(() => flush()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    schedule(OTHER, () => 'x')
    schedule(OTHER, () => {
      throw new Error('serialize failed')
    })
    expect(() => flushKey(OTHER)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  // The spec promises absorption of BOTH error kinds on ALL FOUR paths. The
  // three above cover produce-on-timer, produce-in-flush/flushKey and
  // setItem-on-leading/timer. These pin the remaining corners.
  it('a throwing produce on the leading edge leaves no window and no timer', () => {
    expect(() =>
      schedule(KEY, () => {
        throw new Error('serialize failed')
      })
    ).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)

    schedule(KEY, () => 'b')
    expect(localStorage.getItem(KEY)).toBe('b')
  })

  it('a failed setItem during flush does not propagate', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => flush()).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a failed setItem during flushKey does not propagate', () => {
    schedule(KEY, () => 'a')
    schedule(KEY, () => 'b')
    localStorageMock.setItem.mockImplementationOnce(() => {
      throw new Error('quota')
    })
    expect(() => flushKey(KEY)).not.toThrow()
    expect(vi.getTimerCount()).toBe(0)
  })
})
