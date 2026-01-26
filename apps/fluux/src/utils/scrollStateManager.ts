/**
 * Scroll State Manager
 *
 * A dedicated module for managing scroll positions across conversation switches.
 * Isolates scroll persistence logic from the MessageList component for better
 * testability and reliability.
 *
 * Key features:
 * - Explicit state transitions with timestamps for debugging
 * - Proper handling of conversation switches
 * - Cleanup of stale entries
 * - Debug logging (controlled via DEBUG flag)
 */

const DEBUG = false

interface ScrollState {
  /** Saved scroll position (scrollTop) */
  scrollTop: number
  /** Whether the user was at the bottom when leaving */
  wasAtBottom: boolean
  /** Timestamp when the state was saved */
  savedAt: number
  /** Total scroll height when saved (for validation) */
  scrollHeight: number
}

interface ConversationState {
  /** Whether this conversation has been initialized (scrolled to bottom on first view) */
  initialized: boolean
  /** Message count when last seen (for detecting new messages) */
  messageCount: number
  /** Scroll state if saved */
  scrollState?: ScrollState
}

class ScrollStateManager {
  private states = new Map<string, ConversationState>()
  private currentConversationId: string | null = null
  private staleThresholdMs = 30 * 60 * 1000 // 30 minutes

  private log(action: string, data?: Record<string, unknown>) {
    if (DEBUG) {
      console.log(`[ScrollStateManager] ${action}`, data ?? '')
    }
  }

  /**
   * Get or create state for a conversation
   */
  private getState(conversationId: string): ConversationState {
    if (!this.states.has(conversationId)) {
      this.states.set(conversationId, {
        initialized: false,
        messageCount: 0,
      })
    }
    return this.states.get(conversationId)!
  }

  /**
   * Called when entering a conversation.
   * Returns the action to take for scroll positioning.
   */
  enterConversation(
    conversationId: string,
    messageCount: number
  ): 'scroll-to-bottom' | 'restore-position' | 'no-action' {
    // isSwitch is true when entering a different conversation OR returning after leaving
    // (currentConversationId is null after leaving, which should also trigger scroll behavior)
    const isSwitch = this.currentConversationId !== conversationId
    const state = this.getState(conversationId)

    this.log('enterConversation', {
      conversationId,
      messageCount,
      isSwitch,
      wasInitialized: state.initialized,
      hasSavedPosition: !!state.scrollState,
      wasAtBottom: state.scrollState?.wasAtBottom,
      prevMessageCount: state.messageCount,
    })

    // Update current conversation
    this.currentConversationId = conversationId

    // First time viewing this conversation - scroll to bottom
    if (!state.initialized) {
      state.initialized = true
      state.messageCount = messageCount
      this.log('action: scroll-to-bottom (first view)')
      return 'scroll-to-bottom'
    }

    // PRIORITY: If user had scrolled up (not at bottom), restore their position.
    // This takes precedence over "new messages" because:
    // 1. MAM history loading increases message count but isn't "new" messages
    // 2. If user explicitly scrolled up, they're reading something specific
    // 3. They'll see the unread indicator and can scroll down when ready
    if (state.scrollState && !state.scrollState.wasAtBottom) {
      // Update message count but keep the saved position
      state.messageCount = messageCount
      this.log('action: restore-position', {
        savedScrollTop: state.scrollState.scrollTop,
        savedAt: new Date(state.scrollState.savedAt).toISOString(),
      })
      return 'restore-position'
    }

    // User was at bottom (or no saved state) - scroll to bottom
    // This handles both "new messages arrived" and "return to conversation"
    state.messageCount = messageCount
    if (isSwitch) {
      this.log('action: scroll-to-bottom (was at bottom or first return)')
      return 'scroll-to-bottom'
    }

    // Same conversation, might be a re-render - no action needed
    this.log('action: no-action')
    return 'no-action'
  }

  /**
   * Save scroll position continuously (called on every scroll event).
   * This ensures we have the position even if DOM unmounts before cleanup.
   */
  saveScrollPosition(
    conversationId: string,
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number
  ): void {
    const state = this.getState(conversationId)
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight
    const wasAtBottom = distanceFromBottom < 50

    this.log('saveScrollPosition', {
      conversationId: conversationId.substring(0, 20),
      scrollTop,
      scrollHeight,
      distanceFromBottom,
      wasAtBottom,
    })

    if (wasAtBottom) {
      // If at bottom, clear any saved position - we'll scroll to bottom on return
      delete state.scrollState
    } else {
      // Save the scroll position for restoration
      state.scrollState = {
        scrollTop,
        wasAtBottom,
        savedAt: Date.now(),
        scrollHeight,
      }
    }
  }

  /**
   * Called when leaving a conversation (switching to another).
   * Clears currentConversationId so returning is detected as a switch.
   */
  leaveConversation(
    conversationId: string,
    scrollTop: number,
    scrollHeight: number,
    clientHeight: number
  ): void {
    // Save position first
    this.saveScrollPosition(conversationId, scrollTop, scrollHeight, clientHeight)

    const state = this.getState(conversationId)
    this.log('leaveConversation', {
      conversationId,
      scrollTop,
      scrollHeight,
      wasAtBottom: !state.scrollState,
    })

    // Clear current conversation so that returning to this conversation
    // is correctly detected as a "switch" (triggers scroll restoration)
    if (this.currentConversationId === conversationId) {
      this.currentConversationId = null
    }
  }

  /**
   * Mark a conversation as left without saving scroll position.
   * Used when we don't have valid scroll data to save (e.g., user switched
   * away before any scroll events occurred).
   */
  markAsLeft(conversationId: string): void {
    this.log('markAsLeft', { conversationId })
    if (this.currentConversationId === conversationId) {
      this.currentConversationId = null
    }
  }

  /**
   * Get the saved scroll position for a conversation.
   * Returns null if no position saved or if it was at bottom.
   */
  getSavedScrollTop(conversationId: string): number | null {
    const state = this.states.get(conversationId)
    if (!state?.scrollState || state.scrollState.wasAtBottom) {
      return null
    }

    // Check if the saved state is stale
    if (Date.now() - state.scrollState.savedAt > this.staleThresholdMs) {
      this.log('Clearing stale scroll state', { conversationId })
      delete state.scrollState
      return null
    }

    return state.scrollState.scrollTop
  }

  /**
   * Clear the saved scroll state after restoration.
   */
  clearSavedScrollState(conversationId: string): void {
    const state = this.states.get(conversationId)
    if (state?.scrollState) {
      this.log('clearSavedScrollState', { conversationId })
      delete state.scrollState
    }
  }

  /**
   * Update message count and return if this is a new message arrival.
   */
  updateMessageCount(conversationId: string, newCount: number): boolean {
    const state = this.getState(conversationId)
    const prevCount = state.messageCount
    const isNewMessage = prevCount > 0 && newCount > prevCount

    this.log('updateMessageCount', {
      conversationId,
      prevCount,
      newCount,
      isNewMessage,
    })

    state.messageCount = newCount
    return isNewMessage
  }

  /**
   * Check if a conversation has been initialized.
   */
  isInitialized(conversationId: string): boolean {
    return this.getState(conversationId).initialized
  }

  /**
   * Reset all state (useful for testing or logout).
   */
  reset(): void {
    this.log('reset')
    this.states.clear()
    this.currentConversationId = null
  }

  /**
   * Clean up stale entries to prevent memory leaks.
   */
  cleanup(): void {
    const now = Date.now()
    for (const [id, state] of this.states.entries()) {
      if (state.scrollState && now - state.scrollState.savedAt > this.staleThresholdMs) {
        this.log('cleanup: removing stale entry', { conversationId: id })
        this.states.delete(id)
      }
    }
  }

  /**
   * Get current conversation ID (for debugging).
   */
  getCurrentConversationId(): string | null {
    return this.currentConversationId
  }

  /**
   * Get debug info for all tracked conversations.
   */
  getDebugInfo(): Record<string, unknown> {
    const info: Record<string, unknown> = {
      currentConversationId: this.currentConversationId,
      trackedConversations: this.states.size,
      conversations: {},
    }

    for (const [id, state] of this.states.entries()) {
      (info.conversations as Record<string, unknown>)[id] = {
        initialized: state.initialized,
        messageCount: state.messageCount,
        hasScrollState: !!state.scrollState,
        scrollTop: state.scrollState?.scrollTop,
        wasAtBottom: state.scrollState?.wasAtBottom,
      }
    }

    return info
  }
}

// Singleton instance
export const scrollStateManager = new ScrollStateManager()

// Export class for testing
export { ScrollStateManager }
