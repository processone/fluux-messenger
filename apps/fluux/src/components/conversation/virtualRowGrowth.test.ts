import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TRACKED_VIRTUAL_ROW_SIZES,
  VirtualRowGrowthBatcher,
  VirtualRowSizeHistory,
} from './virtualRowGrowth'

describe('VirtualRowSizeHistory', () => {
  it('starts a fresh measurement baseline when the conversation changes', () => {
    const history = new VirtualRowSizeHistory()

    expect(history.observe('room-a', 100, 'same-row-key', 40)).toBeNull()
    expect(history.observe('room-b', 100, 'same-row-key', 60)).toBeNull()
    expect(history.observe('room-b', 100, 'same-row-key', 72)).toBe(12)
    expect(history.observe('room-a', 100, 'same-row-key', 80)).toBeNull()
  })

  it('starts a fresh measurement baseline when the message scale changes', () => {
    const history = new VirtualRowSizeHistory()

    expect(history.observe('room', 100, 'row', 40)).toBeNull()
    expect(history.observe('room', 110, 'row', 60)).toBeNull()
    expect(history.observe('room', 110, 'row', 66)).toBe(6)
  })

  it('evicts the least-recently measured row when the history reaches its bound', () => {
    const history = new VirtualRowSizeHistory()
    history.observe('room', 100, 'oldest', 40)
    for (let index = 0; index < MAX_TRACKED_VIRTUAL_ROW_SIZES; index += 1) {
      history.observe('room', 100, `row-${index}`, 40)
    }

    expect(history.observe('room', 100, 'oldest', 60)).toBeNull()
  })
})

describe('VirtualRowGrowthBatcher', () => {
  it('coalesces growth measured for the same conversation into one frame', () => {
    const callbacks: FrameRequestCallback[] = []
    const flush = vi.fn()
    const batcher = new VirtualRowGrowthBatcher(
      flush,
      (callback) => callbacks.push(callback),
      vi.fn(),
    )

    batcher.enqueue('room', 12)
    batcher.enqueue('room', 16)
    for (const callback of callbacks) callback(0)

    expect(callbacks).toHaveLength(1)
    expect(flush).toHaveBeenCalledWith('room', 28)
  })

  it('drops the obsolete batch and preserves growth measured after a conversation switch', () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    const canceled: number[] = []
    let nextFrameId = 1
    const flush = vi.fn()
    const batcher = new VirtualRowGrowthBatcher(
      flush,
      (callback) => {
        const frameId = nextFrameId
        nextFrameId += 1
        callbacks.set(frameId, callback)
        return frameId
      },
      (frameId) => {
        canceled.push(frameId)
        callbacks.delete(frameId)
      },
    )

    batcher.enqueue('room-a', 20)
    batcher.enqueue('room-b', 28)
    for (const callback of callbacks.values()) callback(0)

    expect(canceled).toEqual([1])
    expect(flush).toHaveBeenCalledOnce()
    expect(flush).toHaveBeenCalledWith('room-b', 28)
  })

  // Every case above injects its own scheduler, so none of them reaches the constructor defaults
  // the app actually runs with. Those defaults are stored as instance properties and invoked as
  // `this.requestFrame(...)`, so a default handed the DOM function bare receives the batcher as
  // its receiver and Blink and WebKit throw `TypeError: Illegal invocation`. jsdom accepts any
  // receiver, so the receiver itself is what this asserts — the throw is not observable here.
  it('invokes its DEFAULT frame scheduler with the global receiver, never the batcher', () => {
    const receivers: unknown[] = []
    const request = vi
      .spyOn(globalThis, 'requestAnimationFrame')
      .mockImplementation(function (this: unknown) {
        receivers.push(this)
        return 7
      })
    const cancel = vi
      .spyOn(globalThis, 'cancelAnimationFrame')
      .mockImplementation(function (this: unknown) {
        receivers.push(this)
      })

    try {
      const batcher = new VirtualRowGrowthBatcher(vi.fn())
      batcher.enqueue('room', 24)
      batcher.dispose()
    } finally {
      request.mockRestore()
      cancel.mockRestore()
    }

    expect(receivers).toHaveLength(2)
    for (const receiver of receivers) {
      expect(receiver).not.toBeInstanceOf(VirtualRowGrowthBatcher)
    }
  })
})
