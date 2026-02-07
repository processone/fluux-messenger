import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMessageSelection } from './useMessageSelection'

interface MockMessage {
  id: string
  body: string
}

describe('useMessageSelection', () => {
  const createMessages = (count: number): MockMessage[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `msg-${i}`,
      body: `Message ${i}`,
    }))

  let mockScrollRef: { current: HTMLDivElement | null }
  let mockIsAtBottomRef: { current: boolean }

  beforeEach(() => {
    vi.useFakeTimers()
    mockScrollRef = { current: null }
    mockIsAtBottomRef = { current: true }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('initial state', () => {
    it('should return all required properties', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      expect(result.current.selectedMessageId).toBe(null)
      expect(result.current.hasKeyboardSelection).toBe(false)
      expect(result.current.showToolbarForSelection).toBe(false)
      expect(result.current.handleKeyDown).toBeDefined()
      expect(result.current.clearSelection).toBeDefined()
      expect(result.current.handleMouseMove).toBeDefined()
      expect(result.current.handleMouseLeave).toBeDefined()
    })
  })

  describe('clearSelection', () => {
    it('should reset selection state', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set a selection
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      expect(result.current.selectedMessageId).toBe('msg-2')
      expect(result.current.hasKeyboardSelection).toBe(true)

      // Clear selection
      act(() => {
        result.current.clearSelection()
      })

      expect(result.current.selectedMessageId).toBe(null)
      expect(result.current.hasKeyboardSelection).toBe(false)
      expect(result.current.showToolbarForSelection).toBe(false)
    })
  })

  describe('toolbar debounce', () => {
    it('should hide toolbar immediately on selection change', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set initial selection
      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      // Wait for toolbar to appear
      act(() => {
        vi.advanceTimersByTime(400)
      })

      expect(result.current.showToolbarForSelection).toBe(true)

      // Change selection - toolbar should hide immediately
      act(() => {
        result.current.setSelectedMessageId('msg-1')
      })

      expect(result.current.showToolbarForSelection).toBe(false)
    })

    it('should show toolbar after 400ms of settling', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      // Initially hidden
      expect(result.current.showToolbarForSelection).toBe(false)

      // After 200ms - still hidden
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(result.current.showToolbarForSelection).toBe(false)

      // After 400ms - visible
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(result.current.showToolbarForSelection).toBe(true)
    })

    it('should hide toolbar when selection is cleared', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set selection
      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      // Wait for toolbar to show
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(result.current.showToolbarForSelection).toBe(true)

      // Clear selection
      act(() => {
        result.current.setSelectedMessageId(null)
      })
      expect(result.current.showToolbarForSelection).toBe(false)
    })
  })


  describe('handleMouseMove', () => {
    it('should clear keyboard selection when mouse moves significantly', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set selection
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })
      expect(result.current.hasKeyboardSelection).toBe(true)

      // First mouse move to establish position
      act(() => {
        result.current.handleMouseMove({
          clientX: 100,
          clientY: 100,
        } as React.MouseEvent, 'msg-1')
      })

      // Second mouse move with significant movement - should clear selection
      act(() => {
        result.current.handleMouseMove({
          clientX: 200,
          clientY: 200,
        } as React.MouseEvent, 'msg-3')
      })

      expect(result.current.hasKeyboardSelection).toBe(false)
    })

    it('should not clear selection during keyboard cooldown', () => {
      vi.useRealTimers() // Use real timers for this test
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Set selection and simulate keyboard navigation (which sets cooldown)
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Manually trigger keyboard handler to set cooldown
      act(() => {
        const event = {
          key: 'ArrowUp',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // Mouse move during cooldown - should NOT clear selection
      act(() => {
        result.current.handleMouseMove({
          clientX: 100,
          clientY: 100,
        } as React.MouseEvent, 'msg-1')
      })

      expect(result.current.hasKeyboardSelection).toBe(true)
      vi.useFakeTimers() // Restore fake timers
    })
  })

  describe('setSelectedMessageId', () => {
    it('should update selection state', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-3')
      })

      expect(result.current.selectedMessageId).toBe('msg-3')
      expect(result.current.hasKeyboardSelection).toBe(true)
    })
  })

  describe('hasKeyboardSelection', () => {
    it('should be true when message is selected', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      expect(result.current.hasKeyboardSelection).toBe(false)

      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      expect(result.current.hasKeyboardSelection).toBe(true)
    })

    it('should be false when selection is null', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })
      expect(result.current.hasKeyboardSelection).toBe(true)

      act(() => {
        result.current.setSelectedMessageId(null)
      })
      expect(result.current.hasKeyboardSelection).toBe(false)
    })
  })

  describe('messages update', () => {
    it('should keep selection when messages array changes', () => {
      const initialMessages = createMessages(5)
      const { result, rerender } = renderHook(
        ({ msgs }) => useMessageSelection(msgs, mockScrollRef, mockIsAtBottomRef),
        { initialProps: { msgs: initialMessages } }
      )

      // Select a message
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })
      expect(result.current.selectedMessageId).toBe('msg-2')

      // Add more messages
      const newMessages = [...initialMessages, { id: 'msg-5', body: 'New message' }]
      rerender({ msgs: newMessages })

      // Selection should be preserved
      expect(result.current.selectedMessageId).toBe('msg-2')
    })
  })

  describe('handleKeyDown with arrow keys', () => {
    it('should navigate up with ArrowUp', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Select msg-2 (middle)
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // ArrowUp should move selection up
      act(() => {
        const event = {
          key: 'ArrowUp',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe('msg-1')
    })

    it('should navigate down with ArrowDown', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Select msg-2 (middle)
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // ArrowDown should move selection down
      act(() => {
        const event = {
          key: 'ArrowDown',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe('msg-3')
    })

    it('should start navigation from hovered message', () => {
      vi.useRealTimers() // Use real timers for cooldown
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // No selection initially
      expect(result.current.selectedMessageId).toBe(null)

      // Hover over msg-3 (mouse move with significant movement)
      act(() => {
        result.current.handleMouseMove({
          clientX: 100,
          clientY: 100,
        } as React.MouseEvent, 'msg-3')
      })

      // Press ArrowUp to start keyboard navigation from hovered message
      act(() => {
        const event = {
          key: 'ArrowUp',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // First ArrowUp should select the hovered message (msg-3)
      expect(result.current.selectedMessageId).toBe('msg-3')

      vi.useFakeTimers() // Restore fake timers
    })

    it('should ignore Alt+Arrow to let sidebar handle it', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Select msg-2 (middle)
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Alt+ArrowUp should be ignored (passes through to sidebar)
      act(() => {
        const event = {
          key: 'ArrowUp',
          altKey: true,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // Selection should remain unchanged
      expect(result.current.selectedMessageId).toBe('msg-2')
    })

    it('should not navigate with unrelated keys', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Tab should not navigate
      act(() => {
        const event = {
          key: 'Tab',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe('msg-2')
    })

    it('should call onEnterPressed when Enter is pressed on a selected message', () => {
      const messages = createMessages(5)
      const onEnterPressed = vi.fn()
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, {
          onEnterPressed,
        })
      )

      // Select a message
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Press Enter
      const preventDefault = vi.fn()
      act(() => {
        const event = {
          key: 'Enter',
          preventDefault,
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // onEnterPressed should be called with the message ID
      expect(onEnterPressed).toHaveBeenCalledWith('msg-2')
      expect(preventDefault).toHaveBeenCalled()
      // Selection should remain
      expect(result.current.selectedMessageId).toBe('msg-2')
    })

    it('should not call onEnterPressed when no message is selected', () => {
      const messages = createMessages(5)
      const onEnterPressed = vi.fn()
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef, {
          onEnterPressed,
        })
      )

      // No selection
      expect(result.current.selectedMessageId).toBe(null)

      // Press Enter
      act(() => {
        const event = {
          key: 'Enter',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // onEnterPressed should NOT be called
      expect(onEnterPressed).not.toHaveBeenCalled()
    })

    it('should not call anything when Enter is pressed without onEnterPressed callback', () => {
      const messages = createMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, mockIsAtBottomRef)
      )

      // Select a message
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Press Enter - should not throw or change selection
      act(() => {
        const event = {
          key: 'Enter',
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      // Selection should remain unchanged
      expect(result.current.selectedMessageId).toBe('msg-2')
    })

    it('should do nothing when messages array is empty', () => {
      const { result } = renderHook(() =>
        useMessageSelection([], mockScrollRef, mockIsAtBottomRef)
      )

      const preventDefault = vi.fn()
      const stopPropagation = vi.fn()

      act(() => {
        const event = {
          key: 'ArrowUp',
          preventDefault,
          stopPropagation,
        } as unknown as React.KeyboardEvent
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe(null)
      // preventDefault should not be called when messages are empty
      expect(preventDefault).not.toHaveBeenCalled()
    })
  })
})
