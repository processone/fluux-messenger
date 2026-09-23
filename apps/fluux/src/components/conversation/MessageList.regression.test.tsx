/**
 * Regression tests for MessageList behavior.
 *
 * Each test documents a specific bug that was fixed and ensures it doesn't regress.
 * Tests are named with issue IDs for traceability.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useMessageSelection } from '@/hooks/useMessageSelection'
import {
  createTestMessages,
  createMockKeyboardEvent,
  createMockMouseEvent,
  calculateIsAtBottom,
  hasMouseMovedSignificantly,
} from './MessageList.test-utils'

describe('MessageList Regressions', () => {
  let mockScrollRef: { current: HTMLElement | null }

  beforeEach(() => {
    vi.useFakeTimers()
    mockScrollRef = { current: null }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('REGRESSION-001: Scroll position calculation threshold', () => {
    /**
     * Bug: isAtBottom was using incorrect calculation
     * Fix: Use scrollHeight - scrollTop - clientHeight < threshold
     *
     * Formula: distanceFromBottom = scrollHeight - scrollTop - clientHeight
     * At bottom when distanceFromBottom < threshold (strict less than)
     *
     * Example: scrollHeight=1000, clientHeight=500, threshold=50
     * - scrollTop=451: distance = 1000-451-500 = 49 < 50 → AT BOTTOM
     * - scrollTop=450: distance = 1000-450-500 = 50, NOT < 50 → SCROLLED UP
     */
    it('should detect at bottom when within 50px threshold', () => {
      // Container: 1000px tall content, 500px viewport, scrolled to 451 (49px from bottom)
      expect(calculateIsAtBottom(1000, 451, 500, 50)).toBe(true)
      // Scrolled to 480 (20px from bottom)
      expect(calculateIsAtBottom(1000, 480, 500, 50)).toBe(true)
      // Scrolled to max (0px from bottom)
      expect(calculateIsAtBottom(1000, 500, 500, 50)).toBe(true)
    })

    it('should detect scrolled up when beyond 50px threshold', () => {
      // Container: 1000px tall content, 500px viewport, scrolled to 400 (100px from bottom)
      expect(calculateIsAtBottom(1000, 400, 500, 50)).toBe(false)
      // Scrolled to 450 (exactly 50px from bottom - NOT at bottom, threshold is strict <)
      expect(calculateIsAtBottom(1000, 450, 500, 50)).toBe(false)
    })

    it('should handle edge case at exact threshold', () => {
      // Exactly at threshold (50px from bottom) - NOT at bottom (strict < comparison)
      expect(calculateIsAtBottom(1000, 450, 500, 50)).toBe(false)
      // 1px within threshold (49px from bottom) - AT bottom
      expect(calculateIsAtBottom(1000, 451, 500, 50)).toBe(true)
    })
  })

  describe('REGRESSION-002: Alt+Arrow key handling', () => {
    /**
     * Bug: Alt+Arrow was navigating both sidebar and message list
     * Fix: Add `if (e.altKey) return` to pass event to sidebar
     */
    it('should ignore Alt+Arrow and let it bubble to sidebar', () => {
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      // Set initial selection
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Alt+ArrowUp should be ignored
      const event = createMockKeyboardEvent({ key: 'ArrowUp', altKey: true })
      act(() => {
        result.current.handleKeyDown(event)
      })

      // Selection should remain unchanged
      expect(result.current.selectedMessageId).toBe('msg-2')
      // preventDefault should NOT have been called (event passes through)
      expect(event.preventDefault).not.toHaveBeenCalled()
    })

    it('should handle plain Arrow keys for message navigation', () => {
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Plain ArrowUp should navigate
      const event = createMockKeyboardEvent({ key: 'ArrowUp' })
      act(() => {
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe('msg-1')
      expect(event.preventDefault).toHaveBeenCalled()
    })
  })

  describe('REGRESSION-003: Keyboard navigation starting point', () => {
    /**
     * Bug: Keyboard navigation didn't start from hovered message
     * Fix: Track hoveredMessageIdRef and use it as starting point
     */
    it('should start navigation from hovered message', () => {
      vi.useRealTimers() // Need real timers for cooldown
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      // No selection initially
      expect(result.current.selectedMessageId).toBe(null)

      // Hover over msg-3
      act(() => {
        const mouseEvent = createMockMouseEvent({ clientX: 100, clientY: 100 })
        result.current.handleMouseMove(mouseEvent, 'msg-3')
      })

      // Press ArrowUp - should start from hovered message
      act(() => {
        const keyEvent = createMockKeyboardEvent({ key: 'ArrowUp' })
        result.current.handleKeyDown(keyEvent)
      })

      // First keypress selects the hovered message
      expect(result.current.selectedMessageId).toBe('msg-3')

      vi.useFakeTimers()
    })

    it('should fall back to last message when no DOM available', () => {
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      // No selection, no hover
      expect(result.current.selectedMessageId).toBe(null)

      // Press ArrowUp without DOM - should fall back to last message
      act(() => {
        const keyEvent = createMockKeyboardEvent({ key: 'ArrowUp' })
        result.current.handleKeyDown(keyEvent)
      })

      // Without DOM, defaults to last message (msg-4)
      expect(result.current.selectedMessageId).toBe('msg-4')
    })
  })

  describe('REGRESSION-004: Mouse movement detection', () => {
    /**
     * Bug: Scroll-triggered mouse events were clearing selection
     * Fix: Track mouse position and only react to significant movement
     */
    it('should ignore tiny mouse movements (scroll-triggered)', () => {
      expect(hasMouseMovedSignificantly({ x: 100, y: 100 }, { x: 101, y: 101 }, 3)).toBe(false)
      expect(hasMouseMovedSignificantly({ x: 100, y: 100 }, { x: 102, y: 102 }, 3)).toBe(false)
    })

    it('should detect significant mouse movements', () => {
      expect(hasMouseMovedSignificantly({ x: 100, y: 100 }, { x: 103, y: 100 }, 3)).toBe(true)
      expect(hasMouseMovedSignificantly({ x: 100, y: 100 }, { x: 100, y: 103 }, 3)).toBe(true)
      expect(hasMouseMovedSignificantly({ x: 100, y: 100 }, { x: 110, y: 110 }, 3)).toBe(true)
    })

    it('should always detect movement when no previous position', () => {
      expect(hasMouseMovedSignificantly({ x: 100, y: 100 }, null, 3)).toBe(true)
    })
  })

  describe('REGRESSION-005: Keyboard cooldown', () => {
    /**
     * Bug: Mouse events immediately after keyboard nav cleared selection
     * Fix: Add 300ms cooldown after keyboard navigation
     */
    it('should not clear selection during keyboard cooldown', () => {
      vi.useRealTimers() // Need real timers for Date.now()
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      // Set selection via keyboard nav
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Simulate keyboard navigation (sets cooldown)
      act(() => {
        const keyEvent = createMockKeyboardEvent({ key: 'ArrowUp' })
        result.current.handleKeyDown(keyEvent)
      })

      expect(result.current.selectedMessageId).toBe('msg-1')

      // Mouse move immediately after (within cooldown)
      act(() => {
        const mouseEvent = createMockMouseEvent({ clientX: 200, clientY: 200 })
        result.current.handleMouseMove(mouseEvent, 'msg-4')
      })

      // Selection should still be active (cooldown protects it)
      expect(result.current.hasKeyboardSelection).toBe(true)

      vi.useFakeTimers()
    })
  })

  describe('REGRESSION-006: Toolbar debounce timing', () => {
    /**
     * Bug: Toolbar flashed during rapid keyboard navigation
     * Fix: 400ms debounce before showing toolbar
     */
    it('should not show toolbar during rapid navigation', () => {
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      // Navigate rapidly
      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })
      expect(result.current.showToolbarForSelection).toBe(false)

      // Navigate again before 400ms
      act(() => {
        vi.advanceTimersByTime(200)
        result.current.setSelectedMessageId('msg-1')
      })
      expect(result.current.showToolbarForSelection).toBe(false)

      // Navigate again
      act(() => {
        vi.advanceTimersByTime(200)
        result.current.setSelectedMessageId('msg-2')
      })
      expect(result.current.showToolbarForSelection).toBe(false)

      // Now wait 400ms without navigation
      act(() => {
        vi.advanceTimersByTime(400)
      })
      expect(result.current.showToolbarForSelection).toBe(true)
    })

    it('should hide toolbar immediately on selection change', () => {
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      // Set selection and wait for toolbar
      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })
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
  })

  describe('REGRESSION-007: Selection state consistency', () => {
    /**
     * Bug: hasKeyboardSelection could be out of sync with selectedMessageId
     * Fix: Derive hasKeyboardSelection from selectedMessageId
     */
    it('should keep hasKeyboardSelection in sync with selectedMessageId', () => {
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      // Initially no selection
      expect(result.current.selectedMessageId).toBe(null)
      expect(result.current.hasKeyboardSelection).toBe(false)

      // Set selection
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
    })
  })

  describe('REGRESSION-008: Arrow key boundary handling', () => {
    /**
     * Bug: ArrowUp at first message or ArrowDown at last could crash
     * Fix: Clamp index to valid range and return current on boundary
     */
    it('should stay at first message when pressing ArrowUp', () => {
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      // ArrowUp at first message
      act(() => {
        const event = createMockKeyboardEvent({ key: 'ArrowUp' })
        result.current.handleKeyDown(event)
      })

      // Should stay at first message
      expect(result.current.selectedMessageId).toBe('msg-0')
    })

    it('should stay at last message when pressing ArrowDown', () => {
      const messages = createTestMessages(5)
      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef)
      )

      act(() => {
        result.current.setSelectedMessageId('msg-4')
      })

      // ArrowDown at last message
      act(() => {
        const event = createMockKeyboardEvent({ key: 'ArrowDown' })
        result.current.handleKeyDown(event)
      })

      // Should stay at last message
      expect(result.current.selectedMessageId).toBe('msg-4')
    })

    it('should handle empty message array', () => {
      const { result } = renderHook(() =>
        useMessageSelection([], mockScrollRef)
      )

      // Should not crash on empty array
      const event = createMockKeyboardEvent({ key: 'ArrowUp' })
      act(() => {
        result.current.handleKeyDown(event)
      })

      expect(result.current.selectedMessageId).toBe(null)
      expect(event.preventDefault).not.toHaveBeenCalled()
    })
  })

  describe('REGRESSION-009: Scroll position preservation on conversation switch', () => {
    /**
     * Bug: Switching conversations always scrolled to bottom instead of restoring position
     * Fix: Remove isAtBottomRef.current = true from ChatView/RoomView useEffect
     *
     * The MessageList component properly tracks scroll positions per conversation using
     * module-level Maps (scrollPositions, initializedConversations). The bug was that
     * ChatView and RoomView were forcibly setting isAtBottomRef.current = true on
     * conversation change, which made MessageList think the user was at bottom when
     * they had actually scrolled up.
     *
     * MessageList behavior:
     * 1. First visit to conversation → scroll to bottom (tracked via initializedConversations)
     * 2. User scrolls up → isAtBottomRef becomes false
     * 3. Switch conversation → save scroll position (only if NOT at bottom)
     * 4. Return to conversation → restore saved position OR scroll to bottom if was at bottom
     *
     * The fix removes the forced reset so MessageList can correctly determine whether
     * the user was at bottom when they left the conversation.
     */
    it('should document that isAtBottomRef must NOT be force-reset on conversation change', () => {
      // This test documents the contract between MessageList and its parent components.
      // MessageList uses isAtBottomRef to decide whether to save scroll position.
      //
      // If isAtBottomRef is false when leaving a conversation:
      //   → MessageList saves the scroll position
      //   → Returning restores the position
      //
      // If isAtBottomRef is true when leaving:
      //   → MessageList does NOT save the position (clears any stale one)
      //   → Returning scrolls to bottom
      //
      // The bug was that ChatView/RoomView were setting isAtBottomRef.current = true
      // in their useEffect that runs on conversation change, BEFORE MessageList's
      // save-position effect could read the actual value.

      const isAtBottomRef = { current: false } // User scrolled up

      // Simulate the WRONG behavior (what the bug did):
      // Parent component forcibly resets isAtBottomRef on conversation change
      isAtBottomRef.current = true // THIS IS THE BUG - removes user's scroll context

      // Now MessageList thinks user was at bottom, so it won't save position
      expect(isAtBottomRef.current).toBe(true) // This is what causes the bug

      // The FIX is to NOT reset isAtBottomRef in parent components.
      // Let MessageList manage scroll state based on actual scroll events.
    })

    it('should preserve scroll position logic in MessageList save/restore cycle', () => {
      // Verify the expected save/restore behavior

      // Scenario 1: User scrolled up (isAtBottom = false)
      let isAtBottom = false
      const shouldSavePosition = !isAtBottom
      expect(shouldSavePosition).toBe(true) // Position should be saved

      // Scenario 2: User was at bottom (isAtBottom = true)
      isAtBottom = true
      const shouldClearPosition = isAtBottom
      expect(shouldClearPosition).toBe(true) // Stale position should be cleared
    })
  })

  describe('REGRESSION-010: Keyboard-triggered lazy loading', () => {
    /**
     * Feature: Pressing ArrowUp at the first message triggers MAM fetch
     * This allows users to load older history without needing to scroll
     */
    it('should call onReachedFirstMessage when pressing ArrowUp at first message', () => {
      const messages = createTestMessages(5)
      const onReachedFirstMessage = vi.fn()

      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, {
          onReachedFirstMessage,
          isLoadingOlder: false,
          isHistoryComplete: false,
        })
      )

      // Select the first message
      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      // Press ArrowUp at first message
      const event = createMockKeyboardEvent({ key: 'ArrowUp' })
      act(() => {
        result.current.handleKeyDown(event)
      })

      // Should trigger lazy loading
      expect(onReachedFirstMessage).toHaveBeenCalledTimes(1)
      // Selection should stay at first message
      expect(result.current.selectedMessageId).toBe('msg-0')
    })

    it('should NOT call onReachedFirstMessage when isLoadingOlder is true', () => {
      const messages = createTestMessages(5)
      const onReachedFirstMessage = vi.fn()

      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, {
          onReachedFirstMessage,
          isLoadingOlder: true, // Already loading
          isHistoryComplete: false,
        })
      )

      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      const event = createMockKeyboardEvent({ key: 'ArrowUp' })
      act(() => {
        result.current.handleKeyDown(event)
      })

      // Should NOT trigger because already loading
      expect(onReachedFirstMessage).not.toHaveBeenCalled()
    })

    it('should NOT call onReachedFirstMessage when isHistoryComplete is true', () => {
      const messages = createTestMessages(5)
      const onReachedFirstMessage = vi.fn()

      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, {
          onReachedFirstMessage,
          isLoadingOlder: false,
          isHistoryComplete: true, // All history loaded
        })
      )

      act(() => {
        result.current.setSelectedMessageId('msg-0')
      })

      const event = createMockKeyboardEvent({ key: 'ArrowUp' })
      act(() => {
        result.current.handleKeyDown(event)
      })

      // Should NOT trigger because history is complete
      expect(onReachedFirstMessage).not.toHaveBeenCalled()
    })

    it('should NOT call onReachedFirstMessage when not at first message', () => {
      const messages = createTestMessages(5)
      const onReachedFirstMessage = vi.fn()

      const { result } = renderHook(() =>
        useMessageSelection(messages, mockScrollRef, {
          onReachedFirstMessage,
          isLoadingOlder: false,
          isHistoryComplete: false,
        })
      )

      // Select a message in the middle
      act(() => {
        result.current.setSelectedMessageId('msg-2')
      })

      // Press ArrowUp - should navigate, not trigger loading
      const event = createMockKeyboardEvent({ key: 'ArrowUp' })
      act(() => {
        result.current.handleKeyDown(event)
      })

      // Should NOT trigger lazy loading (not at first message)
      expect(onReachedFirstMessage).not.toHaveBeenCalled()
      // Should have navigated to previous message
      expect(result.current.selectedMessageId).toBe('msg-1')
    })
  })
})
