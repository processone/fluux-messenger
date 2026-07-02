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

  // --- Scrollbar only past the 8-line cap -----------------------------------
  // With overflow-y:auto always on, Blink (mobile Brave) paints a scrollbar for
  // a single line because the integer height we write can round under the
  // fractional content height. Keep overflow-y hidden until content genuinely
  // exceeds the 8-line cap (192px), where a scrollbar is actually needed.
  it('keeps overflow-y hidden below the max height', () => {
    mockScrollHeight = 48 // one line
    const { container } = renderComposer('Hello world test')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.style.overflowY).toBe('hidden')
  })

  it('switches overflow-y to auto once content exceeds the 8-line cap', () => {
    mockScrollHeight = 240 // taller than the 192px cap
    const { container } = renderComposer('Nine\nlines\nof\ntext\nthat\noverflow\nthe\ncomposer\ncap')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.style.height).toBe('192px')
    expect(textarea.style.overflowY).toBe('auto')
  })

  it('restores overflow-y hidden when a tall draft shrinks back under the cap', () => {
    mockScrollHeight = 240
    const { container, rerender } = renderComposer('a\nb\nc\nd\ne\nf\ng\nh\ni')
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.style.overflowY).toBe('auto')

    mockScrollHeight = 48 // deleted back to one line
    rerender(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        value="a"
        onValueChange={() => {}}
      />
    )
    expect(textarea.style.overflowY).toBe('hidden')
  })

  // --- Per-keystroke forced-layout avoidance --------------------------------
  // resizeToContent ran on every keystroke and unconditionally (a) reset the
  // textarea to height:auto and (b) called onInputResize. The auto-reset
  // changes the composer's box, relayouting the flex column — including the
  // entire non-virtualized message list — and onInputResize then reads the
  // list's scrollHeight, forcing a second full layout. In a long conversation
  // every keystroke therefore paid a full message-list reflow (~30ms measured
  // at ~900 messages). The composer must not disturb layout when the typed
  // text does not change the composer's height.
  const renderWithResize = (value: string, onInputResize: () => void) =>
    render(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        value={value}
        onValueChange={() => {}}
        onInputResize={onInputResize}
      />
    )

  it('does not fire onInputResize on an append that leaves the height unchanged', () => {
    const onInputResize = vi.fn()
    mockScrollHeight = 48
    const { rerender } = renderWithResize('Hello', onInputResize)
    onInputResize.mockClear() // ignore the mount-time sizing call

    // Append one character on the same line — height is unchanged.
    rerender(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        value="Hello!"
        onValueChange={() => {}}
        onInputResize={onInputResize}
      />
    )

    expect(onInputResize).not.toHaveBeenCalled()
  })

  it('fires onInputResize and grows when an append wraps to a new line', () => {
    const onInputResize = vi.fn()
    mockScrollHeight = 48
    const { container, rerender } = renderWithResize('Hello', onInputResize)
    onInputResize.mockClear()

    mockScrollHeight = 72 // content now needs a second line
    rerender(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        value="Hello world that now wraps onto a second line"
        onValueChange={() => {}}
        onInputResize={onInputResize}
      />
    )

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.style.height).toBe('72px')
    expect(onInputResize).toHaveBeenCalled()
  })

  it('shrinks (and fires onInputResize) when text is deleted back to one line', () => {
    const onInputResize = vi.fn()
    mockScrollHeight = 72
    const { container, rerender } = renderWithResize('two\nlines', onInputResize)
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(textarea.style.height).toBe('72px')
    onInputResize.mockClear()

    mockScrollHeight = 48 // deleted back to one line
    rerender(
      <MessageComposer
        placeholder="Type a message"
        onSend={vi.fn().mockResolvedValue(true)}
        value="two"
        onValueChange={() => {}}
        onInputResize={onInputResize}
      />
    )

    expect(textarea.style.height).toBe('48px')
    expect(onInputResize).toHaveBeenCalled()
  })
})
