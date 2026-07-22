import { useEffect } from 'react'
import { connectionStore, chatStore, roomStore } from '@fluux/sdk'
import { dismissNotification } from '@/utils/dismissNotification'
import { isViewportAtBottom } from '@/utils/viewportAtBottom'

/**
 * Hook to track window focus and update the SDK store.
 *
 * Uses document.hasFocus() to detect when the app is in the foreground.
 * This allows notifications to fire when the window is visible but the
 * user is working in another app (window not focused).
 *
 * When the window regains focus, active entities (conversation/room) are
 * marked as read since the user is now seeing the messages.
 *
 * This hook is intentionally minimal and doesn't return any values
 * to avoid causing re-renders.
 */
export function useWindowVisibility(): void {
  useEffect(() => {
    const handleFocusChange = () => {
      const wasFocused = connectionStore.getState().windowVisible
      const isFocused = document.hasFocus()

      // Update store directly without going through React state
      connectionStore.getState().setWindowVisible(isFocused)

      // When the window regains focus, mark active entities as read — but ONLY when
      // their viewport is actually showing the newest message (issue #1076).
      //
      // Focusing the app is not evidence of reading: the last-open view is usually
      // just whatever was open when the user left. markAsRead advances the read
      // pointer to the live edge, which drops the "new messages" divider and gets
      // published over XEP-0490, so an unconditional call here silently discards a
      // read position the user never caught up to. Gajim gates the same transition
      // on view_is_at_bottom(); this is that gate.
      //
      // The notification dismissal stays unconditional — the user IS at the app now,
      // so the OS-level alert has served its purpose either way.
      if (!wasFocused && isFocused) {
        const activeConversationId = chatStore.getState().activeConversationId
        if (activeConversationId) {
          if (isViewportAtBottom('conversation', activeConversationId)) {
            chatStore.getState().markAsRead(activeConversationId)
          }
          void dismissNotification('conversation', activeConversationId)
        }
        const activeRoomJid = roomStore.getState().activeRoomJid
        if (activeRoomJid) {
          if (isViewportAtBottom('room', activeRoomJid)) {
            roomStore.getState().markAsRead(activeRoomJid)
          }
          void dismissNotification('room', activeRoomJid)
        }
      }
    }

    // Set initial state
    handleFocusChange()

    // Listen to multiple events for reliable focus detection:
    // - visibilitychange: fires when page becomes hidden/visible (minimize, tab switch)
    // - focus/blur: fires when window gains/loses focus (app switch)
    document.addEventListener('visibilitychange', handleFocusChange)
    window.addEventListener('focus', handleFocusChange)
    window.addEventListener('blur', handleFocusChange)

    return () => {
      document.removeEventListener('visibilitychange', handleFocusChange)
      window.removeEventListener('focus', handleFocusChange)
      window.removeEventListener('blur', handleFocusChange)
    }
  }, [])
}
