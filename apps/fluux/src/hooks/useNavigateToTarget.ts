/**
 * Shared navigation utility for switching to conversations and rooms.
 *
 * Used by:
 * - useDeepLink: when opening xmpp: URIs
 * - useDesktopNotifications: when clicking notifications
 *
 * Phase 2.4: Uses React Router for navigation instead of callback handlers.
 */
import { useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'

// Check if we're running in Tauri
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

/**
 * Clear all active notifications from the notification center.
 * Called when navigating to a conversation/room so stale notifications are dismissed.
 *
 * Note: removeAllActive() is not available on all platforms (e.g., may not work on macOS).
 * We silently ignore errors since this is a "nice to have" feature.
 */
async function clearAllNotifications(): Promise<void> {
  if (!isTauri) return

  try {
    const { removeAllActive } = await import('@tauri-apps/plugin-notification')
    await removeAllActive()
  } catch {
    // Silently ignore - removeAllActive is not available on all platforms
  }
}

/**
 * Hook that provides navigation functions for switching to conversations and rooms.
 * Uses React Router for URL-based navigation.
 */
export function useNavigateToTarget() {
  const navigate = useNavigate()
  // NOTE: Use direct store subscriptions instead of useChat()/useRoom() hooks.
  // Those hooks subscribe to conversations/rooms which change during MAM loading,
  // causing unnecessary re-renders. We only need the setters here.
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)

  // Use refs to avoid stale closures in async callbacks
  const navigateRef = useRef(navigate)
  const setActiveConversationRef = useRef(setActiveConversation)
  const setActiveRoomRef = useRef(setActiveRoom)

  useEffect(() => {
    navigateRef.current = navigate
    setActiveConversationRef.current = setActiveConversation
    setActiveRoomRef.current = setActiveRoom
  }, [navigate, setActiveConversation, setActiveRoom])

  /**
   * Navigate to a 1:1 conversation.
   * Uses URL-based navigation (/messages/:jid) and sets active conversation.
   * Clears all active notifications.
   */
  const navigateToConversation = useCallback((conversationId: string) => {
    // Navigate via URL (this updates sidebarView via useRouteSync)
    navigateRef.current(`/messages/${encodeURIComponent(conversationId)}`)
    // Also set active conversation in state
    setActiveConversationRef.current(conversationId)
    clearAllNotifications()
  }, [])

  /**
   * Navigate to a MUC room.
   * Uses URL-based navigation (/rooms/:jid) and sets active room.
   * Clears all active notifications.
   */
  const navigateToRoom = useCallback((roomJid: string) => {
    // Navigate via URL (this updates sidebarView via useRouteSync)
    navigateRef.current(`/rooms/${encodeURIComponent(roomJid)}`)
    // Also set active room in state
    setActiveRoomRef.current(roomJid)
    clearAllNotifications()
  }, [])

  return { navigateToConversation, navigateToRoom }
}
