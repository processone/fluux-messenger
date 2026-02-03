/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMessageCopyFormatter } from './useMessageCopyFormatter'

describe('useMessageCopyFormatter', () => {
  let container: HTMLDivElement
  let containerRef: { current: HTMLDivElement }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    containerRef = { current: container }
  })

  afterEach(() => {
    document.body.removeChild(container)
  })

  // Helper to create a message element with data attributes
  function createMessageElement(id: string, from: string, time: string, body: string) {
    const div = document.createElement('div')
    div.setAttribute('data-message-id', id)
    div.setAttribute('data-message-from', from)
    div.setAttribute('data-message-time', time)
    div.setAttribute('data-message-body', body)
    // Add text content inside for partial selection
    const textSpan = document.createElement('span')
    textSpan.textContent = body
    div.appendChild(textSpan)
    return div
  }

  // Helper to create a date separator element
  function createDateSeparator(date: string) {
    const div = document.createElement('div')
    div.setAttribute('data-date-separator', date)
    return div
  }

  // Helper to create a mock ClipboardEvent
  function createMockClipboardEvent(setData: ReturnType<typeof vi.fn>, preventDefault: ReturnType<typeof vi.fn>) {
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', {
      value: { setData },
      writable: false,
    })
    Object.defineProperty(event, 'preventDefault', {
      value: preventDefault,
      writable: false,
    })
    return event
  }

  // Helper to simulate selection within a single message (partial text)
  function simulatePartialSelection(element: HTMLElement): { preventDefault: ReturnType<typeof vi.fn>, setData: ReturnType<typeof vi.fn> } {
    const selection = window.getSelection()!
    selection.removeAllRanges()

    // Select text within the message's text content
    const textNode = element.querySelector('span')?.firstChild
    if (textNode) {
      const range = document.createRange()
      range.setStart(textNode, 0)
      range.setEnd(textNode, Math.min(5, textNode.textContent?.length || 0))
      selection.addRange(range)
    }

    const preventDefault = vi.fn()
    const setData = vi.fn()
    const event = createMockClipboardEvent(setData, preventDefault)

    container.dispatchEvent(event)

    return { preventDefault, setData }
  }

  // Helper to simulate selection across multiple messages
  function simulateMultiMessageSelection(elements: HTMLElement[]): { preventDefault: ReturnType<typeof vi.fn>, setData: ReturnType<typeof vi.fn> } {
    const selection = window.getSelection()!
    selection.removeAllRanges()

    if (elements.length > 0) {
      const range = document.createRange()
      range.setStartBefore(elements[0])
      range.setEndAfter(elements[elements.length - 1])
      selection.addRange(range)
    }

    const preventDefault = vi.fn()
    const setData = vi.fn()
    const event = createMockClipboardEvent(setData, preventDefault)

    container.dispatchEvent(event)

    return { preventDefault, setData }
  }

  it('should use default browser copy for selection within a single message', async () => {
    renderHook(() => useMessageCopyFormatter({ containerRef }))

    // Wait for effect to run
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    const msg1 = createMessageElement('1', 'Alice', '14:30', 'Hello world, this is a longer message')
    container.appendChild(msg1)

    const { preventDefault, setData } = simulatePartialSelection(msg1)

    // Single message partial selection should NOT be intercepted
    expect(preventDefault).not.toHaveBeenCalled()
    expect(setData).not.toHaveBeenCalled()
  })

  it('should format output when selecting across multiple messages', async () => {
    renderHook(() => useMessageCopyFormatter({ containerRef }))

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    // Create a group with date separator and messages
    const group = document.createElement('div')
    const dateSep = createDateSeparator('2024-01-15')
    const msg1 = createMessageElement('1', 'Alice', '14:30', 'Hello')
    const msg2 = createMessageElement('2', 'Bob', '14:31', 'Hi there')

    group.appendChild(dateSep)
    group.appendChild(msg1)
    group.appendChild(msg2)
    container.appendChild(group)

    const { preventDefault, setData } = simulateMultiMessageSelection([msg1, msg2])

    // Multiple message selection should be formatted
    expect(preventDefault).toHaveBeenCalled()
    expect(setData).toHaveBeenCalledWith('text/plain', expect.any(String))

    // Check that the output contains date header and messages
    const output = setData.mock.calls[0][1]
    expect(output).toContain('Alice 14:30')
    expect(output).toContain('Hello')
    expect(output).toContain('Bob 14:31')
    expect(output).toContain('Hi there')
  })

  it('should not intercept when selection is collapsed (no selection)', async () => {
    renderHook(() => useMessageCopyFormatter({ containerRef }))

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    const msg1 = createMessageElement('1', 'Alice', '14:30', 'Hello')
    container.appendChild(msg1)

    // Create collapsed selection
    const selection = window.getSelection()!
    selection.removeAllRanges()

    const preventDefault = vi.fn()
    const setData = vi.fn()
    const event = createMockClipboardEvent(setData, preventDefault)
    container.dispatchEvent(event)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(setData).not.toHaveBeenCalled()
  })

  it('should not intercept when selection is outside container', async () => {
    renderHook(() => useMessageCopyFormatter({ containerRef }))

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    // Create messages outside the container
    const outsideContainer = document.createElement('div')
    document.body.appendChild(outsideContainer)
    const msg1 = createMessageElement('1', 'Alice', '14:30', 'Hello')
    outsideContainer.appendChild(msg1)

    // Select outside message
    const selection = window.getSelection()!
    selection.removeAllRanges()
    const range = document.createRange()
    range.selectNodeContents(msg1)
    selection.addRange(range)

    const preventDefault = vi.fn()
    const setData = vi.fn()
    const event = createMockClipboardEvent(setData, preventDefault)
    container.dispatchEvent(event)

    expect(preventDefault).not.toHaveBeenCalled()
    expect(setData).not.toHaveBeenCalled()

    document.body.removeChild(outsideContainer)
  })

  it('should include date header in formatted output', async () => {
    renderHook(() => useMessageCopyFormatter({ containerRef }))

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    const group = document.createElement('div')
    const dateSep = createDateSeparator('2024-01-15')
    const msg1 = createMessageElement('1', 'Alice', '14:30', 'First message')
    const msg2 = createMessageElement('2', 'Alice', '14:31', 'Second message')

    group.appendChild(dateSep)
    group.appendChild(msg1)
    group.appendChild(msg2)
    container.appendChild(group)

    const { setData } = simulateMultiMessageSelection([msg1, msg2])

    const output = setData.mock.calls[0][1]
    // Should include formatted date
    expect(output).toMatch(/January 15, 2024/)
  })

  it('should clean up event listener on unmount', async () => {
    const removeEventListenerSpy = vi.spyOn(container, 'removeEventListener')

    const { unmount } = renderHook(() => useMessageCopyFormatter({ containerRef }))

    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })

    unmount()

    expect(removeEventListenerSpy).toHaveBeenCalledWith('copy', expect.any(Function))
  })
})
