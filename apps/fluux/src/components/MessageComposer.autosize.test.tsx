import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { MessageComposer } from './MessageComposer'

// Composer autosize regression guard.
//
// Root cause of the "composer mounts at 192px for a one-line draft" bug:
// the autosize effect only ran on [text]. If the measurement happened while
// the textarea was transiently narrow (window size being restored at app
// startup, sidebar drag, viewport resize), the wrapped content exceeded the
// 8-line cap, height was clamped to 192px, and NOTHING re-measured until the
// next keystroke. The fix re-measures whenever the textarea's WIDTH changes,
// via a ResizeObserver.
//
// jsdom has no layout, so scrollHeight is mocked and the ResizeObserver is a
// hand-driven fake: tests simulate "the layout width changed" by firing the
// observer callback with a new contentRect width.

type ROCallback = (entries: { contentRect: { width: number } }[]) => void

let roCallbacks: ROCallback[] = []
let roObserved: Element[] = []
let roDisconnected = 0

class MockResizeObserver {
  constructor(cb: ROCallback) {
    roCallbacks.push(cb)
  }
  observe(el: Element) {
    roObserved.push(el)
  }
  unobserve() {}
  disconnect() {
    roDisconnected++
  }
}

let mockScrollHeight = 48

const fireResize = (width: number) => {
  act(() => {
    roCallbacks.forEach((cb) => cb([{ contentRect: { width } }]))
  })
}

describe('MessageComposer autosize', () => {
  let originalRO: typeof ResizeObserver | undefined
  let scrollHeightSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    roCallbacks = []
    roObserved = []
    roDisconnected = 0
    mockScrollHeight = 48
    originalRO = globalThis.ResizeObserver
    globalThis.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver
    scrollHeightSpy = vi
      .spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.tagName === 'TEXTAREA' ? mockScrollHeight : 0
      })
  })

  afterEach(() => {
    scrollHeightSpy.mockRestore()
    if (originalRO) {
      globalThis.ResizeObserver = originalRO
    } else {
      delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver
    }
  })

  const renderComposer = (value: string) =>
    render(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        value={value}
        onValueChange={() => {}}
      />
    )

  it('sizes to content on mount', () => {
    const { container } = renderComposer('Hello world test')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.style.height).toBe('48px')
  })

  it('observes the textarea for width changes', () => {
    const { container } = renderComposer('Hello world test')
    const textarea = container.querySelector('textarea')
    expect(roObserved).toContain(textarea)
  })

  it('re-measures when the width changes — recovers from a stale narrow-width clamp', () => {
    // Mount while the layout is transiently narrow: content wraps massively,
    // height clamps to the 8-line max (192px). This is the reported bug state.
    mockScrollHeight = 360
    const { container } = renderComposer('Hello world test')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.style.height).toBe('192px')

    // Layout settles at the real width: one line again. No keystroke.
    mockScrollHeight = 48
    fireResize(828)
    expect(textarea.style.height).toBe('48px')
  })

  it('re-measures when the composer gets narrower and content needs more lines', () => {
    const { container } = renderComposer('A long draft that wraps when narrow')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.style.height).toBe('48px')

    fireResize(828) // baseline width
    mockScrollHeight = 96
    fireResize(211) // narrower: content now needs more lines
    expect(textarea.style.height).toBe('96px')
  })

  it('ignores observer callbacks when the width has not changed (height-only echoes)', () => {
    renderComposer('Hello world test')

    fireResize(828) // baseline
    const readsBefore = scrollHeightSpy.mock.calls.length
    fireResize(828) // our own style.height write echoes through the observer
    expect(scrollHeightSpy.mock.calls.length).toBe(readsBefore)
  })

  it('disconnects the observer on unmount', () => {
    const { unmount } = renderComposer('Hello world test')
    unmount()
    expect(roDisconnected).toBeGreaterThan(0)
  })
})
