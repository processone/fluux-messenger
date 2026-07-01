/**
 * useViewNavigation - Consolidated navigation state coordination hook
 *
 * Phase 3: Extracts complex navigation state from ChatLayout into a reusable hook.
 *
 * Responsibilities:
 * - Per-tab memory (remembers last selection when switching tabs)
 * - Side effects (mark as read when leaving)
 * - Clearing conflicting state on view switch
 * - Auto-select first item when switching to content views
 */
import { useState, useRef, useEffect, useCallback } from 'react'
import { chatStore, roomStore, searchStore, type Contact } from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'
import { useRouteSync, type NavigateOptions } from './useRouteSync'
import { isSmallScreen } from './useIsMobileWeb'
import type { SidebarView } from '@/components/sidebar-components/types'

/**
 * Per-tab memory - remembers the last active item in each tab
 */
export interface PerTabMemory {
  lastMessagesConversation: string | null
  lastRoomsRoom: string | null
  lastDirectoryContact: Contact | null
}

/**
 * Navigation state and actions returned by useViewNavigation
 */
export interface ViewNavigationResult {
  // Current state
  sidebarView: SidebarView
  perTabMemory: PerTabMemory

  // Navigation actions (with side effects)
  navigateToView: (view: SidebarView) => void

  // Direct navigation functions (for session restore, without side effects)
  navigateToMessages: (jid?: string, options?: NavigateOptions) => void
  navigateToRooms: (jid?: string, options?: NavigateOptions) => void
  navigateToContacts: (jid?: string, options?: NavigateOptions) => void
  navigateToAdmin: (category?: string, options?: NavigateOptions) => void
  navigateToSettings: (category?: string, options?: NavigateOptions) => void
  navigateToSearch: (options?: NavigateOptions) => void
}

/**
 * Hook that consolidates view navigation state and side effects.
 *
 * Extracts the following from ChatLayout:
 * - Per-tab memory (lastMessagesConversation, lastRoomsRoom, lastDirectoryContact)
 * - Side effects: marking as read when leaving, clearing conflicting state
 *
 * @param selectedContact - Currently selected contact in contacts view
 */
export function useViewNavigation(selectedContact: Contact | null): ViewNavigationResult {
  // NOTE: Use direct store subscriptions instead of useChat()/useRoom() hooks.
  // Those hooks subscribe to activeMessages which changes frequently during MAM loading,
  // causing unnecessary re-renders of components using this hook (e.g., ChatLayout).
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  // Hydrating activation for non-null restores: loads the message cache before
  // setting active so the restored view doesn't render empty (see SDK stores)
  const activateConversation = useChatStore((s) => s.activateConversation)
  const activateRoom = useRoomStore((s) => s.activateRoom)

  // Get routing functions from useRouteSync
  const {
    sidebarView,
    navigateToMessages,
    navigateToRooms,
    navigateToContacts,
    navigateToAdmin,
    navigateToSettings,
    navigateToSearch,
  } = useRouteSync()

  // Per-tab memory state
  const [lastMessagesConversation, setLastMessagesConversation] = useState<string | null>(null)
  const [lastRoomsRoom, setLastRoomsRoom] = useState<string | null>(null)
  const [lastDirectoryContact, setLastDirectoryContact] = useState<Contact | null>(null)

  // Track previous sidebarView to detect view changes
  const prevSidebarViewRef = useRef<SidebarView | null>(null)

  // Sync conflicting state when sidebarView changes (e.g., browser back/forward)
  // Only clear state if it's actually set to avoid unnecessary async operations
  useEffect(() => {
    const prevView = prevSidebarViewRef.current
    prevSidebarViewRef.current = sidebarView

    // Skip on initial render or same view
    if (prevView === null || prevView === sidebarView) return

    // Clear preview states when leaving search view
    if (prevView === 'search') searchStore.getState().setPreviewResult(null)

    // Read current state directly from stores to avoid stale closures
    const currentRoomJid = roomStore.getState().activeRoomJid
    const currentConversationId = chatStore.getState().activeConversationId

    // Clear conflicting state based on the new view
    // Only clear if the conflicting state is actually set (idempotent)
    switch (sidebarView) {
      case 'messages':
        if (currentRoomJid) setActiveRoom(null)
        break
      case 'rooms':
        if (currentConversationId) setActiveConversation(null)
        break
      case 'contacts':
        if (currentConversationId) setActiveConversation(null)
        if (currentRoomJid) setActiveRoom(null)
        break
      case 'admin':
        if (currentConversationId) setActiveConversation(null)
        if (currentRoomJid) setActiveRoom(null)
        break
      case 'settings':
      case 'search':
        if (currentConversationId) setActiveConversation(null)
        if (currentRoomJid) setActiveRoom(null)
        break
    }
  }, [sidebarView, setActiveConversation, setActiveRoom])

  /**
   * Navigate to a view with per-tab memory and side effects.
   * Auto-selects the first item if no previous selection exists.
   */
  const navigateToView = useCallback((newView: SidebarView) => {
    // Skip if we're already on this view (prevents duplicate navigation)
    if (sidebarView === newView) return

    // Save current tab's active content before switching
    // Read directly from stores to avoid stale hook values
    const currentConversationId = chatStore.getState().activeConversationId
    const currentRoomJid = roomStore.getState().activeRoomJid

    if (sidebarView === 'messages' && currentConversationId) {
      setLastMessagesConversation(currentConversationId)
      // Mark conversation as read and clear new message marker when leaving messages tab
      chatStore.getState().markAsRead(currentConversationId)
      chatStore.getState().clearFirstNewMessageId(currentConversationId)
    } else if (sidebarView === 'rooms' && currentRoomJid) {
      setLastRoomsRoom(currentRoomJid)
      // Mark room as read and clear new message marker when leaving rooms tab
      roomStore.getState().markAsRead(currentRoomJid)
      roomStore.getState().clearFirstNewMessageId(currentRoomJid)
    } else if (sidebarView === 'contacts' && selectedContact) {
      setLastDirectoryContact(selectedContact)
    } else if (sidebarView === 'search') {
      searchStore.getState().setPreviewResult(null)
    }

    // Navigate to the new view via router. Tab switches PUSH a history entry
    // (standard back stack) so Back retraces the views the user visited. The
    // same-view early return above is the only dedup we need here.
    // Auto-select first item if no per-tab memory exists (skip on small screens - let user choose from sidebar)
    const skipAutoSelect = isSmallScreen()

    switch (newView) {
      case 'messages': {
        setActiveRoom(null)
        // Use per-tab memory, or fall back to first non-archived conversation (sorted by most recent)
        // On small screens, skip auto-selection so user sees the sidebar first
        const targetConversation = skipAutoSelect ? lastMessagesConversation : (lastMessagesConversation ?? (() => {
          const chatState = chatStore.getState()
          const conversations = chatState.conversations
          if (!conversations || typeof conversations.values !== 'function') return undefined
          // Sort by lastMessage timestamp descending (most recent first) to match sidebar order
          const sorted = Array.from(conversations.values())
            .filter(c => !chatState.isArchived?.(c.id))
            .sort((a, b) => {
              const aTimestamp = a.lastMessage?.timestamp
              const bTimestamp = b.lastMessage?.timestamp
              const aTime = aTimestamp instanceof Date ? aTimestamp.getTime() : (aTimestamp ? new Date(aTimestamp).getTime() : 0)
              const bTime = bTimestamp instanceof Date ? bTimestamp.getTime() : (bTimestamp ? new Date(bTimestamp).getTime() : 0)
              return bTime - aTime
            })
          return sorted[0]?.id
        })())
        // Set store state AND navigate to URL
        // Always set conversation (even null) to clear any leftover archived conversation
        void activateConversation(targetConversation ?? null)
        navigateToMessages(targetConversation ?? undefined)
        break
      }
      case 'rooms': {
        setActiveConversation(null)
        // Use per-tab memory, or fall back to first joined room
        // On small screens, skip auto-selection so user sees the sidebar first
        const targetRoom = skipAutoSelect ? lastRoomsRoom : (lastRoomsRoom ?? (() => {
          const roomState = roomStore.getState()
          const joinedRooms = typeof roomState.joinedRooms === 'function' ? roomState.joinedRooms() : []
          const firstRoom = joinedRooms[0]
          return firstRoom?.jid
        })())
        // Set store state AND navigate to URL
        // Always set room (even null) to ensure clean state
        void activateRoom(targetRoom ?? null)
        navigateToRooms(targetRoom ?? undefined)
        break
      }
      case 'contacts':
        setActiveConversation(null)
        setActiveRoom(null)
        // On small screens, don't auto-restore last contact - let user choose
        navigateToContacts(skipAutoSelect ? undefined : (lastDirectoryContact?.jid ?? undefined))
        break
      case 'admin':
        setActiveConversation(null)
        setActiveRoom(null)
        navigateToAdmin(undefined)
        break
      case 'settings':
        setActiveConversation(null)
        setActiveRoom(null)
        // On small screens, don't auto-select a category - let user choose from sidebar
        navigateToSettings(skipAutoSelect ? undefined : 'profile')
        break
      case 'search':
        setActiveConversation(null)
        setActiveRoom(null)
        navigateToSearch()
        break
    }
  }, [sidebarView, selectedContact, lastMessagesConversation, lastRoomsRoom, lastDirectoryContact,
      setActiveConversation, setActiveRoom, activateConversation, activateRoom,
      navigateToMessages, navigateToRooms, navigateToContacts,
      navigateToAdmin, navigateToSettings, navigateToSearch])

  const perTabMemory: PerTabMemory = {
    lastMessagesConversation,
    lastRoomsRoom,
    lastDirectoryContact,
  }

  return {
    // Current state
    sidebarView,
    perTabMemory,

    // Navigation actions (with side effects)
    navigateToView,

    // Direct navigation functions (for session restore, without side effects)
    navigateToMessages,
    navigateToRooms,
    navigateToContacts,
    navigateToAdmin,
    navigateToSettings,
    navigateToSearch,
  }
}
