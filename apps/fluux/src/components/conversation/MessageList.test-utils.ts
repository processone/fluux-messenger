/**
 * Test utilities for MessageList component testing.
 *
 * Provides the pure scroll/pointer helpers, a message factory, and keyboard
 * and mouse event factories used by the MessageList test suites.
 */
import { vi } from 'vitest'
import type { BaseMessage } from '@fluux/sdk'

// ============================================================================
// Pure Functions (extracted for easy testing)
// ============================================================================

/**
 * Calculate whether scroll position is at the bottom.
 * Extracted from scroll handler for testability.
 *
 * Formula: scrollHeight - scrollTop - clientHeight < threshold
 *
 * @example
 * // Content: 1000px, Viewport: 500px, Threshold: 50px
 * // At bottom when scrollTop >= 451 (distance from bottom = 1000 - 451 - 500 = 49 < 50)
 * // NOT at bottom when scrollTop <= 450 (distance = 1000 - 450 - 500 = 50, not < 50)
 */
export function calculateIsAtBottom(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
  threshold = 50
): boolean {
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight
  return distanceFromBottom < threshold
}

/**
 * Find the index of the last visible message in a scroll container.
 * Extracted from useMessageSelection for testability.
 */
export function findLastVisibleMessageIndex(
  messages: { id: string }[],
  containerRect: DOMRect,
  getMessageRect: (id: string) => DOMRect | null
): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const rect = getMessageRect(messages[i].id)
    if (rect) {
      // Message is visible if its bottom is below container top and top is above container bottom
      if (rect.bottom > containerRect.top && rect.top < containerRect.bottom) {
        return i
      }
    }
  }
  return messages.length - 1 // Default to last message
}

/**
 * Check if mouse has moved significantly (not scroll-triggered).
 */
export function hasMouseMovedSignificantly(
  current: { x: number; y: number },
  previous: { x: number; y: number } | null,
  threshold = 3
): boolean {
  if (!previous) return true
  const dx = Math.abs(current.x - previous.x)
  const dy = Math.abs(current.y - previous.y)
  return dx >= threshold || dy >= threshold
}

// ============================================================================
// Test Message Factory
// ============================================================================

/**
 * Create test messages with required BaseMessage fields.
 */
export function createTestMessages(count: number): BaseMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i}`,
    stanzaId: `stanza-${i}`,
    from: `user${i % 3}@example.com`,
    body: `Test message ${i}`,
    timestamp: new Date(Date.now() - (count - i) * 60000), // 1 minute apart
    isOutgoing: i % 2 === 0,
    type: 'chat' as const,
  }))
}

// ============================================================================
// Keyboard Event Factory
// ============================================================================

export interface MockKeyboardEventOptions {
  key: string
  altKey?: boolean
  ctrlKey?: boolean
  shiftKey?: boolean
  metaKey?: boolean
}

/**
 * Create a mock keyboard event for testing.
 */
export function createMockKeyboardEvent(
  options: MockKeyboardEventOptions
): React.KeyboardEvent {
  return {
    key: options.key,
    altKey: options.altKey ?? false,
    ctrlKey: options.ctrlKey ?? false,
    shiftKey: options.shiftKey ?? false,
    metaKey: options.metaKey ?? false,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.KeyboardEvent
}

// ============================================================================
// Mouse Event Factory
// ============================================================================

export interface MockMouseEventOptions {
  clientX: number
  clientY: number
  target?: HTMLElement
}

/**
 * Create a mock mouse event for testing.
 */
export function createMockMouseEvent(options: MockMouseEventOptions): React.MouseEvent {
  return {
    clientX: options.clientX,
    clientY: options.clientY,
    target: options.target ?? document.createElement('div'),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.MouseEvent
}
