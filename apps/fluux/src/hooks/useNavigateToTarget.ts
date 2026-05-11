/**
 * Shared navigation utility for switching to conversations and rooms.
 *
 * Used by:
 * - useDeepLink: when opening xmpp: URIs
 * - useDesktopNotifications: when clicking notifications
 * - ActivityLogView: when clicking an activity event
 *
 * Phase 2.4: Uses React Router for navigation instead of callback handlers.
 */
import { useRef, useEffect } from 'react'
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
  const setChatTargetMessageId = useChatStore((s) => s.setTargetMessageId)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const setRoomTargetMessageId = useRoomStore((s) => s.setTargetMessageId)

  // Use refs to avoid stale closures in async callbacks
  const navigateRef = useRef(navigate)
  const setActiveConversationRef = useRef(setActiveConversation)
  const setChatTargetMessageIdRef = useRef(setChatTargetMessageId)
  const setActiveRoomRef = useRef(setActiveRoom)
  const setRoomTargetMessageIdRef = useRef(setRoomTargetMessageId)

  useEffect(() => {
    navigateRef.current = navigate
    setActiveConversationRef.current = setActiveConversation
    setChatTargetMessageIdRef.current = setChatTargetMessageId
    setActiveRoomRef.current = setActiveRoom
    setRoomTargetMessageIdRef.current = setRoomTargetMessageId
  }, [navigate, setActiveConversation, setChatTargetMessageId, setActiveRoom, setRoomTargetMessageId])

  /**
   * Navigate to a 1:1 conversation.
   * Uses URL-based navigation (/messages/:jid) and sets active conversation.
   * Optionally scrolls to a specific message.
   * Clears all active notifications.
   */
  const navigateToConversation = (conversationId: string, messageId?: string) => {
    if (messageId) {
      setChatTargetMessageIdRef.current(messageId)
    }
    // Navigate via URL (this updates sidebarView via useRouteSync)
    void navigateRef.current(`/messages/${encodeURIComponent(conversationId)}`)
    // Also set active conversation in state
    void setActiveConversationRef.current(conversationId)
    void clearAllNotifications()
  }

  /**
   * Navigate to a contact's profile.
   * Uses URL-based navigation (/contacts/:jid) and clears active conversation/room.
   * Clears all active notifications.
   */
  const navigateToContact = (jid: string) => {
    void setActiveConversationRef.current(null)
    void setActiveRoomRef.current(null)
    void navigateRef.current(`/contacts/${encodeURIComponent(jid)}`)
    void clearAllNotifications()
  }

  /**
   * Navigate to a MUC room.
   * Uses URL-based navigation (/rooms/:jid) and sets active room.
   * Optionally scrolls to a specific message.
   * Clears all active notifications.
   */
  const navigateToRoom = (roomJid: string, messageId?: string) => {
    if (messageId) {
      setRoomTargetMessageIdRef.current(messageId)
    }
    // Navigate via URL (this updates sidebarView via useRouteSync)
    void navigateRef.current(`/rooms/${encodeURIComponent(roomJid)}`)
    // Also set active room in state
    void setActiveRoomRef.current(roomJid)
    void clearAllNotifications()
  }

  return { navigateToConversation, navigateToContact, navigateToRoom }
}
