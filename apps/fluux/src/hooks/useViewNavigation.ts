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
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { chatStore, roomStore, type Contact } from '@fluux/sdk'
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
  navigateToArchive: (jid?: string, options?: NavigateOptions) => void
  navigateToEvents: (options?: NavigateOptions) => void
  navigateToAdmin: (category?: string, options?: NavigateOptions) => void
  navigateToSettings: (category?: string, options?: NavigateOptions) => void
}

/**
 * Hook that consolidates view navigation state and side effects.
 *
 * Extracts the following from ChatLayout:
 * - Per-tab memory (lastMessagesConversation, lastRoomsRoom, lastDirectoryContact)
 * - Side effects: marking as read when leaving, clearing conflicting state
 *
 * @param selectedContact - Currently selected contact in directory view
 */
export function useViewNavigation(selectedContact: Contact | null): ViewNavigationResult {
  // NOTE: Use direct store subscriptions instead of useChat()/useRoom() hooks.
  // Those hooks subscribe to activeMessages which changes frequently during MAM loading,
  // causing unnecessary re-renders of components using this hook (e.g., ChatLayout).
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)

  // Get routing functions from useRouteSync
  const {
    sidebarView,
    navigateToMessages,
    navigateToRooms,
    navigateToContacts,
    navigateToArchive,
    navigateToEvents,
    navigateToAdmin,
    navigateToSettings,
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
      case 'directory':
        if (currentConversationId) setActiveConversation(null)
        if (currentRoomJid) setActiveRoom(null)
        break
      case 'archive':
        if (currentRoomJid) setActiveRoom(null)
        break
      case 'admin':
        if (currentConversationId) setActiveConversation(null)
        if (currentRoomJid) setActiveRoom(null)
        break
      case 'settings':
        if (currentConversationId) setActiveConversation(null)
        if (currentRoomJid) setActiveRoom(null)
        break
      // events: no clearing needed
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
    } else if (sidebarView === 'directory' && selectedContact) {
      setLastDirectoryContact(selectedContact)
    }

    // Navigate to the new view via router
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
        setActiveConversation(targetConversation ?? null)
        navigateToMessages(targetConversation ?? undefined, { replace: true })
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
        setActiveRoom(targetRoom ?? null)
        navigateToRooms(targetRoom ?? undefined, { replace: true })
        break
      }
      case 'directory':
        setActiveConversation(null)
        setActiveRoom(null)
        // On small screens, don't auto-restore last contact - let user choose
        navigateToContacts(skipAutoSelect ? undefined : (lastDirectoryContact?.jid ?? undefined), { replace: true })
        break
      case 'archive': {
        setActiveRoom(null)
        // Use per-tab memory (from archive), or fall back to first archived conversation (sorted by most recent)
        // On small screens, skip auto-selection so user sees the sidebar first
        const targetArchive = skipAutoSelect ? undefined : (() => {
          const chatState = chatStore.getState()
          const conversations = chatState.conversations
          if (!conversations || typeof conversations.values !== 'function') return undefined
          // Sort by lastMessage timestamp descending (most recent first) to match sidebar order
          const sorted = Array.from(conversations.values())
            .filter(c => chatState.isArchived?.(c.id))
            .sort((a, b) => {
              const aTimestamp = a.lastMessage?.timestamp
              const bTimestamp = b.lastMessage?.timestamp
              const aTime = aTimestamp instanceof Date ? aTimestamp.getTime() : (aTimestamp ? new Date(aTimestamp).getTime() : 0)
              const bTime = bTimestamp instanceof Date ? bTimestamp.getTime() : (bTimestamp ? new Date(bTimestamp).getTime() : 0)
              return bTime - aTime
            })
          return sorted[0]?.id
        })()
        // Set store state AND navigate to URL
        // Always set conversation (even null) to clear any leftover non-archived conversation
        setActiveConversation(targetArchive ?? null)
        navigateToArchive(targetArchive, { replace: true })
        break
      }
      case 'events':
        // Events view has no main content - just show sidebar
        setActiveConversation(null)
        setActiveRoom(null)
        navigateToEvents({ replace: true })
        break
      case 'admin':
        setActiveConversation(null)
        setActiveRoom(null)
        navigateToAdmin(undefined, { replace: true })
        break
      case 'settings':
        setActiveConversation(null)
        setActiveRoom(null)
        // On small screens, don't auto-select a category - let user choose from sidebar
        navigateToSettings(skipAutoSelect ? undefined : 'profile', { replace: true })
        break
    }
  }, [
    sidebarView, selectedContact,
    lastMessagesConversation, lastRoomsRoom, lastDirectoryContact,
    setActiveConversation, setActiveRoom,
    navigateToMessages, navigateToRooms, navigateToContacts, navigateToArchive, navigateToEvents, navigateToAdmin, navigateToSettings
  ])

  // Memoize perTabMemory to prevent unnecessary re-renders
  const perTabMemory = useMemo<PerTabMemory>(() => ({
    lastMessagesConversation,
    lastRoomsRoom,
    lastDirectoryContact,
  }), [lastMessagesConversation, lastRoomsRoom, lastDirectoryContact])

  // Memoize the entire return value to prevent render loops in consumers
  return useMemo<ViewNavigationResult>(() => ({
    // Current state
    sidebarView,
    perTabMemory,

    // Navigation actions (with side effects)
    navigateToView,

    // Direct navigation functions (for session restore, without side effects)
    navigateToMessages,
    navigateToRooms,
    navigateToContacts,
    navigateToArchive,
    navigateToEvents,
    navigateToAdmin,
    navigateToSettings,
  }), [
    sidebarView, perTabMemory,
    navigateToView,
    navigateToMessages, navigateToRooms, navigateToContacts, navigateToArchive, navigateToEvents, navigateToAdmin, navigateToSettings,
  ])
}
