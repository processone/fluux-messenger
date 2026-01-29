import { useEffect } from 'react'
import { connectionStore } from '@fluux/sdk'

/**
 * Hook to track window focus and update the SDK store.
 *
 * Uses document.hasFocus() to detect when the app is in the foreground.
 * This allows notifications to fire when the window is visible but the
 * user is working in another app (window not focused).
 *
 * When the window is not focused (e.g., user switched to another app),
 * new messages in the active conversation will:
 * - Trigger desktop notifications
 * - Show the "new messages" marker when the user returns
 *
 * This hook is intentionally minimal and doesn't return any values
 * to avoid causing re-renders.
 */
export function useWindowVisibility(): void {
  useEffect(() => {
    const handleFocusChange = () => {
      // Update store directly without going through React state
      // Use hasFocus() to detect foreground state, not just visibility
      connectionStore.getState().setWindowVisible(document.hasFocus())
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
