import { useEffect } from 'react'
import { connectionStore, chatStore, roomStore } from '@fluux/sdk'

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

      // When window becomes visible again, mark active entities as read
      if (!wasFocused && isFocused) {
        const activeConversationId = chatStore.getState().activeConversationId
        if (activeConversationId) {
          chatStore.getState().markAsRead(activeConversationId)
        }
        const activeRoomJid = roomStore.getState().activeRoomJid
        if (activeRoomJid) {
          roomStore.getState().markAsRead(activeRoomJid)
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
