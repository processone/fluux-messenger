/**
 * Test utilities for MessageList component testing.
 *
 * Provides mock scroll containers, message elements, and scenario builders
 * for comprehensive testing of scroll, keyboard, and mouse interactions.
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
// Mock Scroll Container
// ============================================================================

export interface MockScrollContainerOptions {
  scrollHeight: number
  clientHeight: number
  initialScrollTop?: number
}

export interface MockScrollContainer {
  scrollHeight: number
  clientHeight: number
  scrollTop: number
  scrollTo: ReturnType<typeof vi.fn>
  getBoundingClientRect: () => DOMRect
  addEventListener: ReturnType<typeof vi.fn>
  removeEventListener: ReturnType<typeof vi.fn>
}

/**
 * Create a mock scroll container for testing.
 */
export function createMockScrollContainer(
  options: MockScrollContainerOptions
): MockScrollContainer {
  const { scrollHeight, clientHeight, initialScrollTop } = options
  let scrollTop = initialScrollTop ?? scrollHeight - clientHeight // Default: at bottom

  return {
    get scrollHeight() {
      return scrollHeight
    },
    get clientHeight() {
      return clientHeight
    },
    get scrollTop() {
      return scrollTop
    },
    set scrollTop(value: number) {
      scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight))
    },
    scrollTo: vi.fn(({ top }: { top: number }) => {
      scrollTop = Math.max(0, Math.min(top, scrollHeight - clientHeight))
    }),
    getBoundingClientRect: () =>
      ({
        top: 0,
        bottom: clientHeight,
        left: 0,
        right: 400,
        width: 400,
        height: clientHeight,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }
}

// ============================================================================
// Mock Message Elements
// ============================================================================

export interface MockMessageElementsOptions {
  messageHeight?: number
}

/**
 * Create mock message element lookup for testing.
 * Returns a function that mocks document.querySelector for data-message-id selectors.
 */
export function createMockMessageElements(
  messages: { id: string }[],
  container: MockScrollContainer,
  options: MockMessageElementsOptions = {}
) {
  const { messageHeight = 60 } = options

  return {
    /**
     * Mock querySelector for finding message elements by ID.
     */
    querySelector: (selector: string): HTMLElement | null => {
      const match = selector.match(/\[data-message-id="(.+)"\]/)
      if (!match) return null

      const messageId = match[1]
      const index = messages.findIndex((m) => m.id === messageId)
      if (index === -1) return null

      const messageTop = index * messageHeight
      const visibleTop = messageTop - container.scrollTop

      return {
        getBoundingClientRect: () =>
          ({
            top: visibleTop,
            bottom: visibleTop + messageHeight,
            left: 0,
            right: 400,
            width: 400,
            height: messageHeight,
            x: 0,
            y: visibleTop,
            toJSON: () => ({}),
          }) as DOMRect,
        scrollIntoView: vi.fn(),
        getAttribute: (attr: string) => (attr === 'data-message-id' ? messageId : null),
      } as unknown as HTMLElement
    },

    /**
     * Calculate total content height for all messages.
     */
    getTotalHeight: () => messages.length * messageHeight,

    /**
     * Check if a message is visible in the container.
     */
    isMessageVisible: (messageId: string): boolean => {
      const index = messages.findIndex((m) => m.id === messageId)
      if (index === -1) return false

      const messageTop = index * messageHeight
      const messageBottom = messageTop + messageHeight
      const containerTop = container.scrollTop
      const containerBottom = container.scrollTop + container.clientHeight

      return messageBottom > containerTop && messageTop < containerBottom
    },
  }
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

/**
 * Create a minimal mock message for simple tests.
 */
export function createMinimalMessage(id: string, overrides: Partial<BaseMessage> = {}): BaseMessage {
  return {
    id,
    stanzaId: id,
    from: 'test@example.com',
    body: `Message ${id}`,
    timestamp: new Date(),
    isOutgoing: false,
    type: 'chat' as const,
    ...overrides,
  }
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

// ============================================================================
// Scenario Builder
// ============================================================================

type ActionFn = () => void | Promise<void>
type AssertionFn = () => void

/**
 * Builder for creating readable test scenarios.
 *
 * @example
 * ```typescript
 * await new ScenarioBuilder()
 *   .given('user opens conversation')
 *   .when('user scrolls up')
 *   .and('user switches conversation')
 *   .and('user returns to original conversation')
 *   .then('scroll position is restored')
 *   .run()
 * ```
 */
export class ScenarioBuilder {
  private steps: Array<{ label: string; fn: ActionFn | AssertionFn; type: 'action' | 'assertion' }> = []

  /**
   * Add a precondition/setup step.
   */
  given(label: string, fn: ActionFn = () => {}): this {
    this.steps.push({ label: `Given: ${label}`, fn, type: 'action' })
    return this
  }

  /**
   * Add an action step.
   */
  when(label: string, fn: ActionFn = () => {}): this {
    this.steps.push({ label: `When: ${label}`, fn, type: 'action' })
    return this
  }

  /**
   * Add another action step.
   */
  and(label: string, fn: ActionFn = () => {}): this {
    this.steps.push({ label: `And: ${label}`, fn, type: 'action' })
    return this
  }

  /**
   * Add an assertion step.
   */
  then(label: string, fn: AssertionFn = () => {}): this {
    this.steps.push({ label: `Then: ${label}`, fn, type: 'assertion' })
    return this
  }

  /**
   * Execute all steps in order.
   */
  async run(): Promise<void> {
    for (const step of this.steps) {
      try {
        await step.fn()
      } catch (error) {
        throw new Error(`Scenario failed at "${step.label}": ${error}`, { cause: error })
      }
    }
  }

  /**
   * Get a description of the scenario for test naming.
   */
  describe(): string {
    return this.steps.map((s) => s.label).join(' → ')
  }
}

// ============================================================================
// State Transition Tracker
// ============================================================================

export type ScrollState = 'AT_BOTTOM' | 'SCROLLED_UP' | 'KEYBOARD_NAVIGATING'
export type SelectionState = 'NO_SELECTION' | 'KEYBOARD_SELECTION' | 'HOVER_TRACKED'

/**
 * Track state transitions for debugging and assertions.
 */
export class StateTransitionTracker<T extends string> {
  private transitions: Array<{ from: T; to: T; timestamp: number }> = []
  private currentState: T

  constructor(initialState: T) {
    this.currentState = initialState
  }

  transition(to: T): void {
    this.transitions.push({
      from: this.currentState,
      to,
      timestamp: Date.now(),
    })
    this.currentState = to
  }

  get state(): T {
    return this.currentState
  }

  get history(): Array<{ from: T; to: T }> {
    return this.transitions.map(({ from, to }) => ({ from, to }))
  }

  /**
   * Assert that a specific transition occurred.
   */
  expectTransition(from: T, to: T): void {
    const found = this.transitions.some((t) => t.from === from && t.to === to)
    if (!found) {
      throw new Error(
        `Expected transition ${from} → ${to} but it did not occur. ` +
          `Transitions: ${this.transitions.map((t) => `${t.from}→${t.to}`).join(', ')}`
      )
    }
  }

  /**
   * Assert that a transition did NOT occur.
   */
  expectNoTransition(from: T, to: T): void {
    const found = this.transitions.some((t) => t.from === from && t.to === to)
    if (found) {
      throw new Error(`Expected no transition ${from} → ${to} but it occurred.`)
    }
  }

  reset(initialState: T): void {
    this.transitions = []
    this.currentState = initialState
  }
}
