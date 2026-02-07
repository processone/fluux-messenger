import { useState, useRef, useEffect, useCallback, type RefObject } from 'react'

interface MessageLike {
  id: string
}

interface UseMessageSelectionOptions {
  /** Callback when user presses ArrowUp at the first message (for loading older history) */
  onReachedFirstMessage?: () => void
  /** Whether older history is currently loading (prevents repeated triggers) */
  isLoadingOlder?: boolean
  /** Whether all history has been loaded (disables trigger) */
  isHistoryComplete?: boolean
  /** Callback when user presses Enter on a selected message (for toggling expand/collapse) */
  onEnterPressed?: (messageId: string) => void
}

/**
 * Hook for managing keyboard navigation and selection in message lists.
 *
 * Features:
 * - Arrow key navigation through messages
 * - Debounced toolbar visibility (shows after "settling" on a message)
 * - Scroll selected message into view
 * - Cooldown to prevent mouse events from interfering with keyboard nav
 * - Triggers lazy loading when pressing ArrowUp at first message
 *
 * @param messages - Array of messages with at least an `id` property
 * @param scrollRef - Ref to the scrollable container
 * @param isAtBottomRef - Ref tracking if scroll is at bottom
 * @param options - Optional callbacks for lazy loading
 * @returns Selection state and control functions
 */
export function useMessageSelection<T extends MessageLike>(
  messages: T[],
  scrollRef: RefObject<HTMLElement | null>,
  isAtBottomRef: RefObject<boolean>,
  options?: UseMessageSelectionOptions
) {
  const { onReachedFirstMessage, isLoadingOlder, isHistoryComplete } = options ?? {}
  // Currently selected message ID
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(null)

  // Debounced toolbar visibility (shows after user "settles" on a message)
  const [showToolbarForSelection, setShowToolbarForSelection] = useState(false)
  const toolbarDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Track last mouse position to detect actual mouse movement
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null)

  // Cooldown period after keyboard navigation to ignore mouse events
  const keyboardCooldownRef = useRef<number>(0)

  // Cooldown for lazy loading trigger (prevents rapid retriggering when holding ArrowUp)
  const loadTriggerCooldownRef = useRef<number>(0)
  const LOAD_TRIGGER_COOLDOWN_MS = 1000

  // Track the currently hovered message (for starting keyboard nav from mouse position)
  const hoveredMessageIdRef = useRef<string | null>(null)

  // Debounce toolbar appearance when keyboard navigating
  useEffect(() => {
    // Clear any pending timer
    if (toolbarDebounceRef.current) {
      clearTimeout(toolbarDebounceRef.current)
      toolbarDebounceRef.current = null
    }

    if (selectedMessageId) {
      // Hide toolbar immediately when selection changes
      setShowToolbarForSelection(false)
      // Show toolbar after user settles on a message (400ms)
      toolbarDebounceRef.current = setTimeout(() => {
        setShowToolbarForSelection(true)
      }, 400)
    } else {
      setShowToolbarForSelection(false)
    }

    return () => {
      if (toolbarDebounceRef.current) {
        clearTimeout(toolbarDebounceRef.current)
      }
    }
  }, [selectedMessageId])

  // Scroll selected message into view when keyboard navigating
  useEffect(() => {
    if (selectedMessageId && scrollRef.current) {
      const element = document.querySelector(`[data-message-id="${selectedMessageId}"]`) as HTMLElement
      if (element) {
        const container = scrollRef.current
        const elementRect = element.getBoundingClientRect()
        const containerRect = container.getBoundingClientRect()

        // Calculate element position relative to container's visible area
        const elementTopRelative = elementRect.top - containerRect.top
        const elementBottomRelative = elementRect.bottom - containerRect.top

        // Scroll up if element is above visible area
        if (elementTopRelative < 0) {
          container.scrollTop += elementTopRelative - 10
        }
        // Scroll down if element is below visible area
        else if (elementBottomRelative > containerRect.height) {
          container.scrollTop += elementBottomRelative - containerRect.height + 10
        }
      }
    }
  }, [selectedMessageId, scrollRef])

  // Find the index of the last visible message in the scroll container (start from bottom)
  const findLastVisibleMessageIndex = useCallback(() => {
    // Fallback to last message if no DOM available
    if (!scrollRef.current) return messages.length - 1

    const container = scrollRef.current
    const containerRect = container.getBoundingClientRect()

    // Iterate from the end (newest messages) to find the last visible one
    for (let i = messages.length - 1; i >= 0; i--) {
      const element = document.querySelector(`[data-message-id="${messages[i].id}"]`)
      if (element) {
        const rect = element.getBoundingClientRect()
        // Message is visible if its bottom is below container top and top is above container bottom
        if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
          return i
        }
      }
    }
    return messages.length - 1 // Default to last message
  }, [messages, scrollRef])

  // Keyboard navigation for message list (plain arrow keys when message view is focused)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    const { onEnterPressed } = options ?? {}

    // Handle Enter key for toggling expand/collapse
    if (e.key === 'Enter' && selectedMessageId && onEnterPressed) {
      e.preventDefault()
      onEnterPressed(selectedMessageId)
      return
    }

    // Only handle plain ArrowUp/Down (no Alt modifier)
    // Alt+Arrow is reserved for sidebar navigation
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    if (e.altKey) return // Let Alt+Arrow pass through to sidebar
    if (messages.length === 0) return

    e.preventDefault()
    e.stopPropagation() // Prevent event from bubbling

    // Disable auto-scroll to bottom when keyboard navigating
    if (isAtBottomRef.current !== undefined) {
      (isAtBottomRef as { current: boolean }).current = false
    }

    // Set cooldown to ignore mouse events during/after scroll (300ms)
    keyboardCooldownRef.current = Date.now() + 300

    setSelectedMessageId(current => {
      let currentIndex: number
      if (current) {
        currentIndex = messages.findIndex(m => m.id === current)
      } else {
        // Start from hovered message if available, otherwise last visible message
        if (hoveredMessageIdRef.current) {
          const hoveredIndex = messages.findIndex(m => m.id === hoveredMessageIdRef.current)
          if (hoveredIndex !== -1) {
            currentIndex = hoveredIndex
            return messages[currentIndex]?.id ?? null
          }
        }
        // Fallback: start from last visible message when entering keyboard mode
        currentIndex = findLastVisibleMessageIndex()
        // Return this message first without moving, so user sees where they are
        return messages[currentIndex]?.id ?? null
      }

      let newIndex: number
      if (e.key === 'ArrowUp') {
        // Move up (to older messages) - stop at beginning
        if (currentIndex <= 0) {
          // At first message - trigger lazy loading if available
          // Use cooldown to prevent rapid retriggering when holding the key
          const now = Date.now()
          const cooldownPassed = now - loadTriggerCooldownRef.current > LOAD_TRIGGER_COOLDOWN_MS
          if (onReachedFirstMessage && !isLoadingOlder && !isHistoryComplete && cooldownPassed) {
            loadTriggerCooldownRef.current = now
            onReachedFirstMessage()
          }
          return current // Stay at current position
        }
        newIndex = currentIndex - 1
      } else {
        // Move down (to newer messages) - stop at end
        if (currentIndex >= messages.length - 1) {
          return current // Stay at current position
        }
        newIndex = currentIndex + 1
      }

      return messages[newIndex]?.id ?? null
    })
  }, [messages, findLastVisibleMessageIndex, scrollRef, isAtBottomRef, onReachedFirstMessage, isLoadingOlder, isHistoryComplete, options, selectedMessageId])

  /**
   * Clear selection (call when conversation changes)
   */
  const clearSelection = useCallback(() => {
    setSelectedMessageId(null)
    setShowToolbarForSelection(false)
  }, [])

  /**
   * Handle mouse movement over messages - tracks hovered message and clears keyboard selection
   */
  const handleMouseMove = useCallback((e: React.MouseEvent, messageId?: string) => {
    // Ignore if within keyboard cooldown
    if (Date.now() < keyboardCooldownRef.current) {
      lastMousePosRef.current = { x: e.clientX, y: e.clientY }
      return
    }

    // Check for actual mouse movement (ignore scroll-triggered events)
    const lastPos = lastMousePosRef.current
    if (lastPos && Math.abs(e.clientX - lastPos.x) < 3 && Math.abs(e.clientY - lastPos.y) < 3) {
      return
    }
    lastMousePosRef.current = { x: e.clientX, y: e.clientY }

    // Track hovered message for keyboard nav starting point
    hoveredMessageIdRef.current = messageId || null

    // Clear keyboard selection when mouse takes over
    if (selectedMessageId) {
      clearSelection()
    }
  }, [selectedMessageId, clearSelection])

  /**
   * Handle mouse leave - clears hovered message tracking
   */
  const handleMouseLeave = useCallback(() => {
    hoveredMessageIdRef.current = null
  }, [])

  return {
    /** Currently selected message ID */
    selectedMessageId,
    /** Set the selected message ID */
    setSelectedMessageId,
    /** Whether keyboard selection is active */
    hasKeyboardSelection: !!selectedMessageId,
    /** Whether toolbar should be visible for the selected message */
    showToolbarForSelection,
    /** Keyboard event handler - attach to onKeyDown */
    handleKeyDown,
    /** Clear the selection */
    clearSelection,
    /** Mouse move handler - tracks hover and clears keyboard selection */
    handleMouseMove,
    /** Mouse leave handler - clears hover tracking */
    handleMouseLeave,
  }
}
