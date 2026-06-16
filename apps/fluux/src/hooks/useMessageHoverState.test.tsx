// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMessageHoverState } from './useMessageHoverState'

describe('useMessageHoverState', () => {
  let container: HTMLDivElement
  let messageEl: HTMLDivElement
  let toolbarButton: HTMLButtonElement
  let scrollRef: { current: HTMLElement | null }

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    messageEl = document.createElement('div')
    messageEl.textContent = 'Hello world'
    container.appendChild(messageEl)
    // Toolbar subtree, marked with data-message-toolbar
    const toolbar = document.createElement('div')
    toolbar.setAttribute('data-message-toolbar', '')
    toolbarButton = document.createElement('button')
    toolbar.appendChild(toolbarButton)
    container.appendChild(toolbar)
    document.body.appendChild(container)
    scrollRef = { current: container }
  })

  afterEach(() => {
    vi.useRealTimers()
    window.getSelection()?.removeAllRanges()
    container.remove()
  })

  function setup(resetKey = 'conv-1') {
    return renderHook(
      ({ key }: { key: string }) =>
        useMessageHoverState({ scrollRef, resetKey: key }),
      { initialProps: { key: resetKey } }
    )
  }

  function mouseDown(target: Element, button = 0) {
    act(() => {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button }))
    })
  }

  function mouseUp() {
    act(() => {
      document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
    })
  }

  function selectTextInContainer() {
    const range = document.createRange()
    range.selectNodeContents(messageEl)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
  }

  function clearSelection() {
    window.getSelection()!.removeAllRanges()
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })
  }

  it('shows hover only after the intent delay', () => {
    const { result } = setup()

    act(() => result.current.handleMessageHover('a'))
    expect(result.current.hoveredMessageId).toBeNull()

    act(() => vi.advanceTimersByTime(199))
    expect(result.current.hoveredMessageId).toBeNull()

    act(() => vi.advanceTimersByTime(1))
    expect(result.current.hoveredMessageId).toBe('a')
  })

  it('never shows hover for rows swept over quickly', () => {
    const { result } = setup()

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(50))
    act(() => result.current.handleMessageLeave())
    act(() => result.current.handleMessageHover('b'))
    act(() => vi.advanceTimersByTime(150))
    // 'a' was abandoned at 50ms; 'b' has only accumulated 150ms
    expect(result.current.hoveredMessageId).toBeNull()

    act(() => vi.advanceTimersByTime(50))
    expect(result.current.hoveredMessageId).toBe('b')
  })

  it('keeps the toolbar on same-row re-entry within the leave delay (toolbar bridge)', () => {
    const { result } = setup()

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.hoveredMessageId).toBe('a')

    act(() => result.current.handleMessageLeave())
    act(() => vi.advanceTimersByTime(50))
    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(150))
    // Leave timer was cancelled; no re-delay for the same row
    expect(result.current.hoveredMessageId).toBe('a')
  })

  it('clears hover after the leave delay', () => {
    const { result } = setup()

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))
    act(() => result.current.handleMessageLeave())
    act(() => vi.advanceTimersByTime(100))
    expect(result.current.hoveredMessageId).toBeNull()
  })

  it('hides immediately on mousedown over message content and suppresses hover during the drag', () => {
    const { result } = setup()

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.hoveredMessageId).toBe('a')

    mouseDown(messageEl)
    expect(result.current.hoveredMessageId).toBeNull()

    // Hovering other rows mid-drag does nothing
    act(() => result.current.handleMessageHover('b'))
    act(() => vi.advanceTimersByTime(500))
    expect(result.current.hoveredMessageId).toBeNull()
  })

  it('re-arms hover for the row under the pointer after mouseup without selection', () => {
    const { result } = setup()

    mouseDown(messageEl)
    act(() => result.current.handleMessageHover('b'))
    mouseUp()
    // mouseup defers its selection check by a tick
    act(() => vi.advanceTimersByTime(0))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.hoveredMessageId).toBe('b')
  })

  it('does not hide on mousedown inside the toolbar', () => {
    const { result } = setup()

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))

    mouseDown(toolbarButton)
    expect(result.current.hoveredMessageId).toBe('a')
  })

  it('ignores non-left-button mousedown', () => {
    const { result } = setup()

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))

    mouseDown(messageEl, 2)
    expect(result.current.hoveredMessageId).toBe('a')
  })

  it('ignores mousedown outside the scroll container', () => {
    const { result } = setup()
    const outside = document.createElement('div')
    document.body.appendChild(outside)

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))

    mouseDown(outside)
    expect(result.current.hoveredMessageId).toBe('a')
    outside.remove()
  })

  it('suppresses hover while a selection exists inside the container', () => {
    const { result } = setup()

    selectTextInContainer()

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(500))
    expect(result.current.hoveredMessageId).toBeNull()
  })

  it('hides an already-visible toolbar when a selection appears', () => {
    const { result } = setup()

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.hoveredMessageId).toBe('a')

    selectTextInContainer()
    expect(result.current.hoveredMessageId).toBeNull()
  })

  it('re-arms hover for the row under the pointer when the selection clears', () => {
    const { result } = setup()

    selectTextInContainer()
    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(500))
    expect(result.current.hoveredMessageId).toBeNull()

    clearSelection()
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.hoveredMessageId).toBe('a')
  })

  it('ignores selections outside the container', () => {
    const { result } = setup()
    const outside = document.createElement('div')
    outside.textContent = 'outside text'
    document.body.appendChild(outside)

    const range = document.createRange()
    range.selectNodeContents(outside)
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
    act(() => {
      document.dispatchEvent(new Event('selectionchange'))
    })

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.hoveredMessageId).toBe('a')
    outside.remove()
  })

  it('resets hover when resetKey changes', () => {
    const { result, rerender } = setup('conv-1')

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.hoveredMessageId).toBe('a')

    rerender({ key: 'conv-2' })
    expect(result.current.hoveredMessageId).toBeNull()
  })

  it('resets the mousedown latch when resetKey changes (switch mid-drag without a mouseup)', () => {
    const { result, rerender } = setup('conv-1')

    // Drag starts in conversation 1, but no mouseup reaches the list — the user
    // switches conversation via the keyboard / a notification click.
    mouseDown(messageEl)

    rerender({ key: 'conv-2' })

    // The toolbar must work again in the new conversation: a stuck mousedown
    // latch would suppress hover indefinitely.
    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.hoveredMessageId).toBe('a')
  })

  it('resets the mousedown latch on window blur', () => {
    const { result } = setup()

    mouseDown(messageEl)
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))
    expect(result.current.hoveredMessageId).toBe('a')
  })

  it('removes document listeners on unmount', () => {
    const addSpy = vi.spyOn(document, 'addEventListener')
    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const { unmount } = setup()

    const added = addSpy.mock.calls.map(([type]) => type)
    expect(added).toEqual(expect.arrayContaining(['mousedown', 'mouseup', 'selectionchange']))

    unmount()
    const removed = removeSpy.mock.calls.map(([type]) => type)
    expect(removed).toEqual(expect.arrayContaining(['mousedown', 'mouseup', 'selectionchange']))

    addSpy.mockRestore()
    removeSpy.mockRestore()
  })

  it('keeps handler identities stable across re-renders', () => {
    const { result, rerender } = setup()
    const firstHover = result.current.handleMessageHover
    const firstLeave = result.current.handleMessageLeave

    act(() => result.current.handleMessageHover('a'))
    act(() => vi.advanceTimersByTime(200))
    rerender({ key: 'conv-1' })

    expect(result.current.handleMessageHover).toBe(firstHover)
    expect(result.current.handleMessageLeave).toBe(firstLeave)
  })
})
