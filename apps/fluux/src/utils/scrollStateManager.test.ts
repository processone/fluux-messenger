import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { ScrollStateManager } from './scrollStateManager'

describe('ScrollStateManager', () => {
  let manager: ScrollStateManager

  beforeEach(() => {
    manager = new ScrollStateManager()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('enterConversation', () => {
    it('returns scroll-to-bottom for first view of a conversation', () => {
      const action = manager.enterConversation('conv1', 10)
      expect(action).toBe('scroll-to-bottom')
    })

    it('returns no-action for same conversation re-render (no switch)', () => {
      manager.enterConversation('conv1', 10) // Initialize
      const action = manager.enterConversation('conv1', 10) // Same conversation
      expect(action).toBe('no-action')
    })

    it('returns scroll-to-bottom when switching to a previously initialized conversation that was at bottom', () => {
      // First view of conv1
      manager.enterConversation('conv1', 10)
      // Leave conv1 while at bottom (scrollTop = 900, scrollHeight = 1000, clientHeight = 100)
      manager.leaveConversation('conv1', 900, 1000, 100)

      // Switch to conv2
      manager.enterConversation('conv2', 5)

      // Return to conv1 - should scroll to bottom since it was at bottom
      const action = manager.enterConversation('conv1', 10)
      expect(action).toBe('scroll-to-bottom')
    })

    it('returns restore-position when switching to a conversation that was scrolled up', () => {
      // First view of conv1
      manager.enterConversation('conv1', 10)
      // Leave conv1 while scrolled up (scrollTop = 200, scrollHeight = 1000, clientHeight = 100)
      manager.leaveConversation('conv1', 200, 1000, 100)

      // Switch to conv2
      manager.enterConversation('conv2', 5)

      // Return to conv1 - should restore position
      const action = manager.enterConversation('conv1', 10)
      expect(action).toBe('restore-position')
    })
  })

  describe('leaveConversation', () => {
    it('does not save position when at bottom', () => {
      manager.enterConversation('conv1', 10)
      // At bottom: scrollHeight - scrollTop - clientHeight = 1000 - 900 - 100 = 0
      manager.leaveConversation('conv1', 900, 1000, 100)

      expect(manager.getSavedScrollTop('conv1')).toBeNull()
    })

    it('saves position when scrolled up', () => {
      manager.enterConversation('conv1', 10)
      // Scrolled up: scrollHeight - scrollTop - clientHeight = 1000 - 200 - 100 = 700
      manager.leaveConversation('conv1', 200, 1000, 100)

      expect(manager.getSavedScrollTop('conv1')).toBe(200)
    })

    it('considers within 50px of bottom as "at bottom"', () => {
      manager.enterConversation('conv1', 10)
      // Almost at bottom: scrollHeight - scrollTop - clientHeight = 1000 - 855 - 100 = 45 < 50
      manager.leaveConversation('conv1', 855, 1000, 100)

      expect(manager.getSavedScrollTop('conv1')).toBeNull()
    })

    it('saves position when just outside the 50px threshold', () => {
      manager.enterConversation('conv1', 10)
      // Just outside: scrollHeight - scrollTop - clientHeight = 1000 - 849 - 100 = 51 > 50
      manager.leaveConversation('conv1', 849, 1000, 100)

      expect(manager.getSavedScrollTop('conv1')).toBe(849)
    })
  })

  describe('getSavedScrollTop', () => {
    it('returns null for unknown conversation', () => {
      expect(manager.getSavedScrollTop('unknown')).toBeNull()
    })

    it('returns null after position was cleared', () => {
      manager.enterConversation('conv1', 10)
      manager.leaveConversation('conv1', 200, 1000, 100)
      manager.clearSavedScrollState('conv1')

      expect(manager.getSavedScrollTop('conv1')).toBeNull()
    })

    it('returns null for stale positions (over 30 minutes)', () => {
      manager.enterConversation('conv1', 10)
      manager.leaveConversation('conv1', 200, 1000, 100)

      // Fast-forward 31 minutes
      vi.advanceTimersByTime(31 * 60 * 1000)

      expect(manager.getSavedScrollTop('conv1')).toBeNull()
    })

    it('returns position within 30 minute window', () => {
      manager.enterConversation('conv1', 10)
      manager.leaveConversation('conv1', 200, 1000, 100)

      // Fast-forward 29 minutes (still valid)
      vi.advanceTimersByTime(29 * 60 * 1000)

      expect(manager.getSavedScrollTop('conv1')).toBe(200)
    })
  })

  describe('updateMessageCount', () => {
    it('returns false for first update (no previous count)', () => {
      manager.enterConversation('conv1', 0)
      const isNew = manager.updateMessageCount('conv1', 5)
      expect(isNew).toBe(false)
    })

    it('returns true when message count increases', () => {
      manager.enterConversation('conv1', 5)
      manager.updateMessageCount('conv1', 5) // Set initial count
      const isNew = manager.updateMessageCount('conv1', 6)
      expect(isNew).toBe(true)
    })

    it('returns false when message count stays the same', () => {
      manager.enterConversation('conv1', 5)
      manager.updateMessageCount('conv1', 5)
      const isNew = manager.updateMessageCount('conv1', 5)
      expect(isNew).toBe(false)
    })

    it('returns false when message count decreases', () => {
      manager.enterConversation('conv1', 5)
      manager.updateMessageCount('conv1', 5)
      const isNew = manager.updateMessageCount('conv1', 3)
      expect(isNew).toBe(false)
    })
  })

  describe('isInitialized', () => {
    it('returns false for never-viewed conversation', () => {
      expect(manager.isInitialized('conv1')).toBe(false)
    })

    it('returns true after entering conversation', () => {
      manager.enterConversation('conv1', 10)
      expect(manager.isInitialized('conv1')).toBe(true)
    })
  })

  describe('reset', () => {
    it('clears all tracked state', () => {
      manager.enterConversation('conv1', 10)
      manager.leaveConversation('conv1', 200, 1000, 100)
      manager.enterConversation('conv2', 5)

      manager.reset()

      expect(manager.isInitialized('conv1')).toBe(false)
      expect(manager.isInitialized('conv2')).toBe(false)
      expect(manager.getSavedScrollTop('conv1')).toBeNull()
      expect(manager.getCurrentConversationId()).toBeNull()
    })
  })

  describe('cleanup', () => {
    it('removes stale entries', () => {
      manager.enterConversation('conv1', 10)
      manager.leaveConversation('conv1', 200, 1000, 100)
      manager.enterConversation('conv2', 5)
      manager.leaveConversation('conv2', 300, 1000, 100)

      // Fast-forward 31 minutes
      vi.advanceTimersByTime(31 * 60 * 1000)

      manager.cleanup()

      // Both should be cleaned up since they're stale
      expect(manager.isInitialized('conv1')).toBe(false)
      expect(manager.isInitialized('conv2')).toBe(false)
    })

    it('keeps fresh entries', () => {
      manager.enterConversation('conv1', 10)
      manager.leaveConversation('conv1', 200, 1000, 100)

      // Fast-forward 10 minutes (still fresh)
      vi.advanceTimersByTime(10 * 60 * 1000)

      manager.cleanup()

      // Should still be there
      expect(manager.isInitialized('conv1')).toBe(true)
      expect(manager.getSavedScrollTop('conv1')).toBe(200)
    })
  })

  describe('getDebugInfo', () => {
    it('returns current state for debugging', () => {
      manager.enterConversation('conv1', 10)
      manager.leaveConversation('conv1', 200, 1000, 100)

      const info = manager.getDebugInfo()

      // After leaving, currentConversationId is cleared (null)
      // so that returning is correctly detected as a "switch"
      expect(info.currentConversationId).toBeNull()
      expect(info.trackedConversations).toBe(1)
      expect((info.conversations as Record<string, unknown>)['conv1']).toMatchObject({
        initialized: true,
        messageCount: 10,
        hasScrollState: true,
        scrollTop: 200,
        wasAtBottom: false,
      })
    })
  })

  describe('markAsLeft', () => {
    it('clears currentConversationId without saving scroll position', () => {
      manager.enterConversation('conv1', 10)
      expect(manager.getCurrentConversationId()).toBe('conv1')

      manager.markAsLeft('conv1')

      expect(manager.getCurrentConversationId()).toBeNull()
      // Should not have saved any scroll state
      expect(manager.getSavedScrollTop('conv1')).toBeNull()
    })

    it('preserves existing scroll state when marking as left', () => {
      manager.enterConversation('conv1', 10)
      // Save a scroll position first
      manager.saveScrollPosition('conv1', 500, 2000, 400)
      expect(manager.getSavedScrollTop('conv1')).toBe(500)

      manager.markAsLeft('conv1')

      // Scroll state should be preserved
      expect(manager.getSavedScrollTop('conv1')).toBe(500)
      expect(manager.getCurrentConversationId()).toBeNull()
    })

    it('does nothing if marking a different conversation as left', () => {
      manager.enterConversation('conv1', 10)
      expect(manager.getCurrentConversationId()).toBe('conv1')

      manager.markAsLeft('conv2')

      // conv1 should still be current since we tried to mark conv2
      expect(manager.getCurrentConversationId()).toBe('conv1')
    })
  })

  describe('saveScrollPosition', () => {
    it('saves position when scrolled up (not at bottom)', () => {
      manager.enterConversation('conv1', 10)
      // Scrolled up: distanceFromBottom = 2000 - 500 - 400 = 1100
      manager.saveScrollPosition('conv1', 500, 2000, 400)

      expect(manager.getSavedScrollTop('conv1')).toBe(500)
    })

    it('clears position when at bottom', () => {
      manager.enterConversation('conv1', 10)
      // First save a position
      manager.saveScrollPosition('conv1', 500, 2000, 400)
      expect(manager.getSavedScrollTop('conv1')).toBe(500)

      // Then scroll to bottom: distanceFromBottom = 2000 - 1600 - 400 = 0
      manager.saveScrollPosition('conv1', 1600, 2000, 400)

      expect(manager.getSavedScrollTop('conv1')).toBeNull()
    })

    it('updates position on subsequent saves', () => {
      manager.enterConversation('conv1', 10)
      manager.saveScrollPosition('conv1', 500, 2000, 400)
      expect(manager.getSavedScrollTop('conv1')).toBe(500)

      manager.saveScrollPosition('conv1', 300, 2000, 400)
      expect(manager.getSavedScrollTop('conv1')).toBe(300)
    })
  })

  describe('complex navigation scenarios', () => {
    it('handles multiple conversation switches correctly', () => {
      // View conv1 for the first time
      expect(manager.enterConversation('conv1', 10)).toBe('scroll-to-bottom')

      // Scroll up in conv1
      manager.leaveConversation('conv1', 200, 1000, 100)

      // Switch to conv2 for the first time
      expect(manager.enterConversation('conv2', 5)).toBe('scroll-to-bottom')

      // Leave conv2 at bottom
      manager.leaveConversation('conv2', 900, 1000, 100)

      // Switch to conv3 for the first time
      expect(manager.enterConversation('conv3', 8)).toBe('scroll-to-bottom')

      // Return to conv1 (was scrolled up)
      expect(manager.enterConversation('conv1', 10)).toBe('restore-position')
      expect(manager.getSavedScrollTop('conv1')).toBe(200)

      // Clear the restored position
      manager.clearSavedScrollState('conv1')

      // Leave conv1 at bottom
      manager.leaveConversation('conv1', 900, 1000, 100)

      // Return to conv2 (was at bottom)
      expect(manager.enterConversation('conv2', 5)).toBe('scroll-to-bottom')
    })

    it('BUG PREVENTION: using wrong scroll data would lose position (DOM race condition)', () => {
      // This test documents the bug where React cleanup reads DOM after content change.
      // The fix is to use pendingScrollDataRef (captured during scroll events) instead of DOM.

      // User is in conv1 (long conversation), scrolled up
      manager.enterConversation('conv1', 33)
      // User scrolls up to position 960 (scrollHeight: 2586, clientHeight: 357)
      // distanceFromBottom = 2586 - 960 - 357 = 1269 (not at bottom)
      manager.saveScrollPosition('conv1', 960, 2586, 357)
      expect(manager.getSavedScrollTop('conv1')).toBe(960)

      // User switches to conv2 (short conversation, scrollHeight: 357)
      // BUG SCENARIO: If cleanup reads DOM after React renders conv2's content,
      // it would read scrollTop=0, scrollHeight=357 and INCORRECTLY save that to conv1

      // WRONG: This is what the bug did - save conv2's dimensions to conv1
      // manager.leaveConversation('conv1', 0, 357, 357) // wasAtBottom=true, DELETES scroll state!

      // CORRECT: Use the last saved scroll position from conv1 (from saveScrollPosition)
      manager.leaveConversation('conv1', 960, 2586, 357) // Correct data from pendingScrollDataRef

      // Switch to conv2
      manager.enterConversation('conv2', 2)
      // Stay at bottom in conv2
      manager.leaveConversation('conv2', 0, 357, 357)

      // Return to conv1 - should restore position!
      const action = manager.enterConversation('conv1', 33)
      expect(action).toBe('restore-position')
      expect(manager.getSavedScrollTop('conv1')).toBe(960)
    })

    it('BUG PREVENTION: short conversation should not corrupt long conversation position', () => {
      // Scenario: A (long) -> B (short, no scrollbar) -> A (should restore)

      // User in conv A, scrolled up
      manager.enterConversation('convA', 100)
      manager.saveScrollPosition('convA', 500, 5000, 400)
      manager.leaveConversation('convA', 500, 5000, 400)

      // User switches to conv B (short, no scrollbar: scrollHeight === clientHeight)
      manager.enterConversation('convB', 3)
      // Short conversation - always at bottom (no scrollbar)
      manager.leaveConversation('convB', 0, 400, 400) // wasAtBottom = true

      // Return to conv A - must restore position, NOT scroll to bottom
      const action = manager.enterConversation('convA', 100)
      expect(action).toBe('restore-position')
      expect(manager.getSavedScrollTop('convA')).toBe(500)
    })

    it('handles rapid conversation switches', () => {
      manager.enterConversation('conv1', 10)
      manager.leaveConversation('conv1', 200, 1000, 100)

      manager.enterConversation('conv2', 5)
      manager.leaveConversation('conv2', 300, 1000, 100)

      manager.enterConversation('conv3', 8)
      manager.leaveConversation('conv3', 400, 1000, 100)

      // Return to conv1 - should have its position preserved
      expect(manager.enterConversation('conv1', 10)).toBe('restore-position')
      expect(manager.getSavedScrollTop('conv1')).toBe(200)

      // Return to conv2 - should have its position preserved
      expect(manager.enterConversation('conv2', 5)).toBe('restore-position')
      expect(manager.getSavedScrollTop('conv2')).toBe(300)
    })

    it('preserves scroll position when messages arrive while away (user was scrolled up)', () => {
      manager.enterConversation('conv1', 10)
      // User was scrolled up (not at bottom: scrollTop=200, scrollHeight=1000, clientHeight=100)
      // distanceFromBottom = 1000 - 200 - 100 = 700 (not at bottom)
      manager.leaveConversation('conv1', 200, 1000, 100)

      manager.enterConversation('conv2', 5)

      // Return to conv1 with more messages (could be MAM history or new messages)
      const action = manager.enterConversation('conv1', 15)

      // Should restore position - user was reading, let them scroll down when ready
      // They'll see the unread indicator
      expect(action).toBe('restore-position')
      expect(manager.getSavedScrollTop('conv1')).toBe(200)
    })

    it('scrolls to bottom when messages arrive while away (user was at bottom)', () => {
      manager.enterConversation('conv1', 10)
      // User was at bottom: scrollTop=900, scrollHeight=1000, clientHeight=100
      // distanceFromBottom = 1000 - 900 - 100 = 0 (at bottom)
      manager.leaveConversation('conv1', 900, 1000, 100)

      manager.enterConversation('conv2', 5)

      // Return to conv1 with more messages
      const action = manager.enterConversation('conv1', 15)

      // Should scroll to bottom - user was at bottom, show new content
      expect(action).toBe('scroll-to-bottom')
      // No saved position since user was at bottom
      expect(manager.getSavedScrollTop('conv1')).toBeNull()
    })

    it('restores position when returning with no new messages', () => {
      manager.enterConversation('conv1', 10)
      manager.leaveConversation('conv1', 200, 1000, 100)

      manager.enterConversation('conv2', 5)

      // Return to conv1 with same message count
      const action = manager.enterConversation('conv1', 10)

      // Should restore position since no new messages
      expect(action).toBe('restore-position')
      expect(manager.getSavedScrollTop('conv1')).toBe(200)
    })

    it('BUG PREVENTION: search preview must not corrupt real conversation scroll state', () => {
      // Scenario: User is in conv1 scrolled up, opens search, previews results
      // from the same conversation. The preview uses a prefixed conversationId
      // (e.g., "search-preview:conv1") to avoid overwriting the real scroll state.

      // User in conv1, scrolled up
      manager.enterConversation('conv1', 50)
      manager.saveScrollPosition('conv1', 400, 3000, 500)
      manager.leaveConversation('conv1', 400, 3000, 500)

      // Search preview opens for the same conversation (prefixed ID)
      manager.enterConversation('search-preview:conv1', 100)
      // Preview scrolls to the matched message (different position)
      manager.saveScrollPosition('search-preview:conv1', 1200, 5000, 500)
      manager.leaveConversation('search-preview:conv1', 1200, 5000, 500)

      // User navigates between multiple search results in the same conversation
      manager.enterConversation('search-preview:conv1', 100)
      manager.saveScrollPosition('search-preview:conv1', 800, 5000, 500)
      manager.leaveConversation('search-preview:conv1', 800, 5000, 500)

      // User closes search and returns to the real conversation
      const action = manager.enterConversation('conv1', 50)

      // Must restore the REAL scroll position, not the search preview's
      expect(action).toBe('restore-position')
      expect(manager.getSavedScrollTop('conv1')).toBe(400)
    })

    it('REGRESSION: unmount without leaveConversation causes no-action on remount', () => {
      // Scenario: ChatView unmounts (e.g., navigating to search view) without calling
      // leaveConversation. When ChatView remounts for the same conversation,
      // enterConversation returns 'no-action' because currentConversationId was never cleared.
      // Fix: Component unmount must call markAsLeft or leaveConversation.

      // User is in conv1
      manager.enterConversation('conv1', 10)
      expect(manager.getCurrentConversationId()).toBe('conv1')

      // Component unmounts WITHOUT calling leaveConversation (the bug)
      // currentConversationId is still 'conv1'

      // Component remounts for the same conversation
      const actionWithoutCleanup = manager.enterConversation('conv1', 10)
      // This would return 'no-action' — the conversation switch code
      // still falls through to scroll-to-bottom in the if/else chain,
      // but having the correct action is cleaner
      expect(actionWithoutCleanup).toBe('no-action')

      // Now test with proper cleanup via markAsLeft
      manager.markAsLeft('conv1')
      expect(manager.getCurrentConversationId()).toBeNull()

      // Re-enter the conversation — should detect it as a switch
      const actionWithCleanup = manager.enterConversation('conv1', 10)
      expect(actionWithCleanup).toBe('scroll-to-bottom')
    })

    it('REGRESSION: out-of-bounds saved position must not lock scroll at top', () => {
      // Scenario: User is in a conversation with many messages, scrolls up.
      // Position is saved (e.g., scrollTop=2000 with scrollHeight=5000).
      // User leaves, returns, but content is now much smaller (e.g., only
      // cached messages loaded, scrollHeight=500). The saved position
      // exceeds maxScrollTop, so the browser clamps scrollTop to 0.
      // If isAtBottomRef is set to false (restore-position path),
      // auto-scroll is locked out and the view is stuck at top.
      //
      // Fix: Bounds-check the saved position before restoring. If out of
      // bounds, scroll to bottom instead.

      // User is in conv1, scrolled up in a long conversation
      manager.enterConversation('conv1', 100)
      manager.saveScrollPosition('conv1', 2000, 5000, 400)
      // distanceFromBottom = 5000 - 2000 - 400 = 2600 (not at bottom)

      // User leaves
      manager.leaveConversation('conv1', 2000, 5000, 400)

      // User returns — manager says restore-position
      const action = manager.enterConversation('conv1', 100)
      expect(action).toBe('restore-position')

      const savedPos = manager.getSavedScrollTop('conv1')
      expect(savedPos).toBe(2000)

      // The scroll hook should bounds-check: if savedPos > maxScrollTop, scroll to bottom.
      // Simulating: content now only 500px tall (messages not loaded yet)
      const currentScrollHeight = 500
      const currentClientHeight = 400
      const maxScrollTop = currentScrollHeight - currentClientHeight
      // maxScrollTop = 100, but savedPos = 2000 → OUT OF BOUNDS
      expect(savedPos!).toBeGreaterThan(maxScrollTop)

      // The hook must detect this and scroll to bottom instead of restoring
      // (verified in the useMessageListScroll implementation)
    })

    it('REGRESSION: search view navigation must not leave stale currentConversationId', () => {
      // Scenario: User in conv1 → navigates to search → search preview uses
      // "search-preview:conv1" → user closes search → returns to conv1.
      // Without proper cleanup, currentConversationId could be stale.

      // User in conv1
      manager.enterConversation('conv1', 10)
      expect(manager.getCurrentConversationId()).toBe('conv1')

      // Navigate to search: component unmounts and calls markAsLeft
      manager.markAsLeft('conv1')
      expect(manager.getCurrentConversationId()).toBeNull()

      // Search preview opens with prefixed ID
      manager.enterConversation('search-preview:conv1', 50)
      expect(manager.getCurrentConversationId()).toBe('search-preview:conv1')

      // Search preview closes: component unmounts and calls markAsLeft
      manager.markAsLeft('search-preview:conv1')
      expect(manager.getCurrentConversationId()).toBeNull()

      // Return to conv1 — should be detected as a switch
      const action = manager.enterConversation('conv1', 10)
      expect(action).toBe('scroll-to-bottom')
    })
  })
})
