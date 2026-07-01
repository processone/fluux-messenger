/**
 * Shared navigation utility for switching to conversations and rooms.
 *
 * Used by:
 * - useDeepLink: when opening xmpp: URIs
 * - useDesktopNotifications: when clicking notifications
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
  // causing unnecessary re-renders. We only need the activation actions here.
  // activateConversation/activateRoom hydrate the message cache before setting
  // active, so the navigated-to view never renders empty.
  const activateConversation = useChatStore((s) => s.activateConversation)
  const setChatTargetMessageId = useChatStore((s) => s.setTargetMessageId)
  const activateRoom = useRoomStore((s) => s.activateRoom)
  const setRoomTargetMessageId = useRoomStore((s) => s.setTargetMessageId)

  // Use refs to avoid stale closures in async callbacks
  const navigateRef = useRef(navigate)
  const activateConversationRef = useRef(activateConversation)
  const setChatTargetMessageIdRef = useRef(setChatTargetMessageId)
  const activateRoomRef = useRef(activateRoom)
  const setRoomTargetMessageIdRef = useRef(setRoomTargetMessageId)

  useEffect(() => {
    navigateRef.current = navigate
    activateConversationRef.current = activateConversation
    setChatTargetMessageIdRef.current = setChatTargetMessageId
    activateRoomRef.current = activateRoom
    setRoomTargetMessageIdRef.current = setRoomTargetMessageId
  }, [navigate, activateConversation, setChatTargetMessageId, activateRoom, setRoomTargetMessageId])

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
    void activateConversationRef.current(conversationId)
    void clearAllNotifications()
  }

  /**
   * Navigate to a contact's profile.
   * Uses URL-based navigation (/contacts/:jid) and clears active conversation/room.
   * Clears all active notifications.
   */
  const navigateToContact = (jid: string) => {
    void activateConversationRef.current(null)
    void activateRoomRef.current(null)
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
    void activateRoomRef.current(roomJid)
    void clearAllNotifications()
  }

  return { navigateToConversation, navigateToContact, navigateToRoom }
}
