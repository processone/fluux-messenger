import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { Sidebar, type SidebarView } from './Sidebar'
import { ChatView } from './ChatView'
import { RoomView } from './RoomView'
import { OccupantPanel } from './OccupantPanel'
import { MemberList } from './MemberList'

// Lazy-loaded views (not on critical path — preloaded after initial render)
const ContactProfileView = lazy(() => import('./ContactProfileView').then(m => ({ default: m.ContactProfileView })))
const SettingsView = lazy(() => import('./SettingsView').then(m => ({ default: m.SettingsView })))
const AdminView = lazy(() => import('./AdminView').then(m => ({ default: m.AdminView })))
const XmppConsole = lazy(() => import('./XmppConsole').then(m => ({ default: m.XmppConsole })))
const SearchContextView = lazy(() => import('./SearchContextView').then(m => ({ default: m.SearchContextView })))
const ActivityContextView = lazy(() => import('./ActivityContextView').then(m => ({ default: m.ActivityContextView })))
import { ShortcutHelp } from './ShortcutHelp'
import { CommandPalette } from './CommandPalette'
import { ToastContainer } from './ToastContainer'
import {
  // Vanilla stores for imperative .getState() access
  chatStore, roomStore, consoleStore, adminStore, rosterStore, searchStore, activityLogStore,
  useRosterActions, useContactIdentities,
  type Contact, type Conversation, type AdminCategory
} from '@fluux/sdk'
// React hook wrappers for reactive subscriptions
import { useChatStore, useRoomStore, useRosterStore, useConnectionStore, useConsoleStore, useAdminStore, useSearchStore, useActivityLogStore } from '@fluux/sdk/react'
import { useNotificationBadge } from '@/hooks/useNotificationBadge'
import { useDesktopNotifications } from '@/hooks/useDesktopNotifications'
import { useWebPush } from '@/hooks/useWebPush'
import { useSoundNotification } from '@/hooks/useSoundNotification'
import { useEventsSoundNotification } from '@/hooks/useEventsSoundNotification'
import { useEventsDesktopNotifications } from '@/hooks/useEventsDesktopNotifications'
import { useSDKErrorToasts } from '@/hooks/useSDKErrorToasts'
import { useFocusZones, useViewNavigation, isMobileWeb, isSmallScreen, useWindowVisibility, useRouteSync, type FocusZoneRefs } from '@/hooks'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useDeepLink } from '@/hooks/useDeepLink'
import { saveViewState, getSavedViewState, type ViewStateData } from '@/hooks/useSessionPersistence'
import { useWindowDrag } from '@/hooks'
import { LayoutProvider, useModals } from '@/contexts'
import { Server, ShieldOff, MessageCircle, Hash, Users, Archive, Bell, Search, Settings, type LucideIcon } from 'lucide-react'

/**
 * ChatLayout wrapper that provides LayoutContext to all children.
 * The actual layout logic is in ChatLayoutContent.
 */
export function ChatLayout() {
  return (
    <LayoutProvider>
      <ChatLayoutContent />
    </LayoutProvider>
  )
}

/**
 * Isolated component for global side-effect hooks that don't produce UI.
 *
 * These hooks subscribe to frequently-changing state (message counts, unread badges,
 * notification events). By isolating them here, their re-renders don't cascade to
 * the ChatLayout tree. Re-rendering a null component is essentially free.
 *
 * Previously, these hooks lived in ChatLayoutContent, causing 100+ re-renders/sec
 * during MAM loading because useNotificationBadge subscribes to per-message state.
 */
function GlobalEffects() {
  // Update dock/favicon badge with unread count
  useNotificationBadge()

  // Play sound for new messages
  useSoundNotification()

  // Play sound for new events (subscription requests)
  useEventsSoundNotification()

  // Show desktop notifications for new events
  useEventsDesktopNotifications()

  // Show desktop notifications for new messages
  useDesktopNotifications()

  // Register for web push notifications (browser only, skipped in Tauri)
  useWebPush()

  // Track window visibility for new message markers
  useWindowVisibility()

  // Surface SDK error events as toast notifications
  useSDKErrorToasts()

  // Handle XMPP URI deep links (xmpp:user@example.com?message)
  useDeepLink()

  return null
}

/** Lightweight skeleton fallback for lazy-loaded views to prevent layout shift */
function ViewLoadingFallback() {
  return (
    <div className="h-full flex flex-col bg-fluux-chat">
      <div className="h-12 px-4 flex items-center border-b border-fluux-bg" />
      <div className="flex-1" />
    </div>
  )
}

function ChatLayoutContent() {
  // Detect render loops before they freeze the UI
  detectRenderLoop('ChatLayout')

  // Preload lazy-loaded view chunks after initial paint so they're cached before navigation
  useEffect(() => {
    const timer = setTimeout(() => {
      void import('./SettingsView')
      void import('./AdminView')
      void import('./ContactProfileView')
      void import('./XmppConsole')
    }, 2000)
    return () => clearTimeout(timer)
  }, [])

  // Modal management from context
  const { state: modalState, actions: modalActions } = useModals()

  // NOTE: Subscribe directly to stores instead of using useChat()/useRoom() hooks.
  // Those hooks subscribe to activeMessages which changes frequently during MAM loading,
  // causing unnecessary re-renders of ChatLayout (which only needs IDs and setters).
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  // Hydrating activation: loads the message cache before setting active, so the
  // view never renders empty and the unread marker sees historical context.
  // Use these (not the raw setters) whenever activating with a non-null id.
  const activateConversation = useChatStore((s) => s.activateConversation)
  const addConversation = useChatStore((s) => s.addConversation)
  const activeRoomJid = useRoomStore((s) => s.activeRoomJid)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)
  const activateRoom = useRoomStore((s) => s.activateRoom)
  const searchPreviewResult = useSearchStore((s) => s.previewResult)
  const activityPreviewEvent = useActivityLogStore((s) => s.previewEvent)

  // NOTE: Don't use useRoster() hook here - it subscribes to ALL contacts and triggers
  // re-renders when ANY contact's presence changes. Use useRosterActions() for actions
  // without state subscription, and focused selectors for specific contact state.
  const { addContact, removeContact, renameContact, fetchContactNickname, fetchVCard } = useRosterActions()
  // NOTE: Don't use useConnection() hook - it subscribes to MANY state values (jid, error,
  // reconnectAttempt, ownAvatar, etc.) and re-renders when ANY changes. We only need status.
  const status = useConnectionStore((s) => s.status)
  // NOTE: Don't use useConsole() hook - it subscribes to `entries` which changes with every
  // XMPP packet, causing render loops. We only need isOpen and toggle.
  const consoleOpen = useConsoleStore((s) => s.isOpen)
  const toggleConsole = () => {
    consoleStore.getState().toggle()
  }
  // NOTE: Don't use useAdmin() hook - it subscribes to many values. Use focused selectors.
  const adminSession = useAdminStore((s) => s.currentSession)
  const adminCategory = useAdminStore((s) => s.activeCategory)
  const adminIsAdmin = useAdminStore((s) => s.isAdmin)
  const clearAdminSession = () => {
    adminStore.getState().setCurrentSession(null)
    adminStore.getState().setTargetJid(null)
  }
  const setAdminCategory = (category: AdminCategory | null) => {
    adminStore.getState().setActiveCategory(category)
  }
  const navigateToUserAdmin = (userJid: string): string | null => {
    const store = adminStore.getState()
    const domain = userJid.split('@')[1]?.split('/')[0]
    if (!domain) return null
    const adminVhosts = store.vhosts
    if (adminVhosts.length > 0 && !adminVhosts.includes(domain)) return null
    store.setSelectedVhost(domain)
    store.setPendingSelectedUserJid(userJid)
    store.setActiveCategory('users')
    return domain
  }
  // Modal state from useModals() hook via LayoutContext
  // showShortcutHelp and showCommandPalette are used in this component
  // quickChat, addContact, and presenceMenu are only used by Sidebar (which gets them from context)
  const { shortcutHelp: showShortcutHelp, commandPalette: showCommandPalette } = modalState

  // Selected contact JID from directory (for profile view)
  // Store only the JID, derive contact from store so presence updates in real-time
  // Use focused selector that only re-renders when THIS specific contact changes
  const [selectedContactJid, setSelectedContactJid] = useState<string | null>(null)
  const selectedRosterContact = useRosterStore((s) =>
    selectedContactJid ? s.contacts.get(selectedContactJid) ?? null : null
  )

  // Room occupants panel state (persisted across view switches)
  const [showRoomOccupants, setShowRoomOccupants] = useState(false)

  // Get URL-derived state for store sync and settings detection
  const { sidebarView: urlSidebarView, settingsCategory, activeJid } = useRouteSync()

  // Derive selectedContact from React state (selectedContactJid) with URL fallback (activeJid).
  // On mobile, React state and URL can briefly desync during navigation, causing the layout
  // to flash between profile and contact list. Using the URL as a fallback prevents this blink.
  const effectiveContactJid = selectedContactJid ?? (urlSidebarView === 'directory' && activeJid ? activeJid : null)
  // For non-roster users (e.g. room occupants), create a minimal Contact object
  const selectedContact = selectedRosterContact ?? (effectiveContactJid ? {
    jid: effectiveContactJid,
    name: effectiveContactJid.split('@')[0],
    presence: 'offline' as const,
    subscription: 'none' as const,
  } : null)
  const isSelectedContactInRoster = !!selectedRosterContact

  // Phase 3: Use consolidated navigation hook for per-tab memory and modal management
  const {
    sidebarView,
    navigateToView,
    // Direct navigation functions for session restore
    navigateToMessages,
    navigateToRooms,
    navigateToContacts,
    navigateToArchive,
    navigateToEvents,
    navigateToAdmin,
    navigateToSettings,
    navigateToSearch,
  } = useViewNavigation(selectedContact)


  // Ref for main container to enable focus for keyboard shortcuts
  const containerRef = useRef<HTMLDivElement>(null)

  // Focus zone refs for Tab cycling - create refs at top level (stable across renders)
  const sidebarListRef = useRef<HTMLDivElement>(null)
  const mainContentRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLElement>(null)

  // Refs object - stable across renders since refs don't change
  const focusZoneRefs: FocusZoneRefs = {
    sidebarList: sidebarListRef,
    mainContent: mainContentRef,
    composer: composerRef,
  }

  // Enable Tab cycling between focus zones
  useFocusZones(focusZoneRefs)

  // Ref for find-on-page handle in the active ChatView/RoomView
  const findOnPageRef = useRef<import('@/hooks/useFindOnPage').FindOnPageHandle | null>(null)

  // Track if view state was restored from session storage
  const viewRestoredRef = useRef(false)

  // Restore view state on mount (before connection is established)
  // Phase 2: Uses router navigation to restore view
  useEffect(() => {
    if (viewRestoredRef.current) return
    viewRestoredRef.current = true

    const savedViewState = getSavedViewState()
    if (savedViewState) {
      // Restore active conversation/room
      // IMPORTANT: Always set both values (even if null) to override any stale
      // zustand-persisted values. Session storage represents the actual UI state.
      void activateConversation(savedViewState.activeConversationId)
      void activateRoom(savedViewState.activeRoomJid)

      // Restore selected contact JID directly (no need for pending resolution)
      if (savedViewState.selectedContactJid) {
        setSelectedContactJid(savedViewState.selectedContactJid)
      }

      // Restore room occupants panel state
      if (savedViewState.showRoomOccupants !== undefined) {
        setShowRoomOccupants(savedViewState.showRoomOccupants)
      }

      // Navigate to the saved sidebar view (including settings)
      switch (savedViewState.sidebarView) {
        case 'messages':
          navigateToMessages(savedViewState.activeConversationId ?? undefined)
          break
        case 'rooms':
          navigateToRooms(savedViewState.activeRoomJid ?? undefined)
          break
        case 'directory':
          navigateToContacts(savedViewState.selectedContactJid ?? undefined)
          break
        case 'archive':
          navigateToArchive(savedViewState.activeConversationId ?? undefined)
          break
        case 'events':
          navigateToEvents()
          break
        case 'admin':
          navigateToAdmin()
          break
        case 'settings':
          navigateToSettings()
          break
      }
    }
  }, [activateConversation, activateRoom, navigateToMessages, navigateToRooms, navigateToContacts, navigateToArchive, navigateToEvents, navigateToAdmin, navigateToSettings])

  // Save view state when it changes (only when online)
  useEffect(() => {
    if (status !== 'online') return

    const viewState: ViewStateData = {
      sidebarView,
      activeConversationId: activeConversationId ?? null,
      activeRoomJid: activeRoomJid ?? null,
      selectedContactJid: selectedContactJid,
      showRoomOccupants,
    }
    saveViewState(viewState)
  }, [status, sidebarView, activeConversationId, activeRoomJid, selectedContactJid, showRoomOccupants])

  // Clear selected contact when conversation or room becomes active
  useEffect(() => {
    if (activeConversationId || activeRoomJid) {
      setSelectedContactJid(null)
    }
  }, [activeConversationId, activeRoomJid])

  // Sync URL-derived state → store state when URL changes (handles browser back/forward/popstate).
  // When Android edge swipe triggers history.back(), React Router re-renders with the new URL,
  // but Zustand store state is stale. This effect closes the loop.
  // Skip the initial render — on mount, the store is the source of truth (e.g., session restore
  // sets store state before the URL catches up). Only react to subsequent URL changes.
  const prevUrlStateRef = useRef<{ activeJid: string | null; sidebarView: SidebarView } | null>(null)
  useEffect(() => {
    const prev = prevUrlStateRef.current
    prevUrlStateRef.current = { activeJid, sidebarView }
    if (prev === null) return
    // Only sync when the URL actually changed. The effect also re-runs when
    // store-side deps (selectedContactJid) change, but navigate() is
    // transition-deferred in React Router v7: a handler that updates stores and
    // navigates commits the store changes first, while the URL still points at
    // the previous route. Syncing against that stale URL re-activates the
    // entity the handler just cleared (e.g. profile click bouncing back to the
    // conversation).
    if (prev.activeJid === activeJid && prev.sidebarView === sidebarView) return
    // Leaving the directory view clears the contact profile — without this,
    // browser back from /contacts/:jid keeps showing ContactProfileView while
    // the URL and sidebar already say otherwise (mirror of the directory branch)
    if (sidebarView !== 'directory' && selectedContactJid !== null) {
      setSelectedContactJid(null)
    }
    if (sidebarView === 'messages') {
      const currentStoreId = chatStore.getState().activeConversationId
      if (activeJid !== currentStoreId) {
        void activateConversation(activeJid)
      }
    } else if (sidebarView === 'rooms') {
      const currentStoreJid = roomStore.getState().activeRoomJid
      if (activeJid !== currentStoreJid) {
        void activateRoom(activeJid)
      }
    } else if (sidebarView === 'directory') {
      if (activeJid !== selectedContactJid) {
        setSelectedContactJid(activeJid)
      }
    } else if (sidebarView === 'archive') {
      const currentStoreId = chatStore.getState().activeConversationId
      if (activeJid !== currentStoreId) {
        void activateConversation(activeJid)
      }
    }
  }, [activeJid, sidebarView, activateConversation, activateRoom, selectedContactJid])

  // Auto-select first conversation on initial connection if none selected
  // This handles the case when app launches fresh (no session restore)
  // Also triggers when conversations load from MAM after connection
  // NOTE: Skip auto-selection on mobile web - users should see the sidebar first
  const hasAutoSelectedRef = useRef(false)
  // IMPORTANT: Only subscribe to conversation COUNT, not the entire Map.
  // Subscribing to conversations directly causes re-renders whenever ANY conversation
  // is updated (e.g., lastMessage updates during MAM loading), leading to render loops.
  const conversationCount = useChatStore((s) => s.conversations?.size ?? 0)

  useEffect(() => {
    // Only run once when we're online, on messages view, with conversations available
    if (status !== 'online' || hasAutoSelectedRef.current) return
    if (sidebarView !== 'messages') return
    // Only check the value owned by this tab — cross-tab clearing is handled by
    // useViewNavigation. A stale activeRoomJid/selectedContactJid from another tab
    // shouldn't block Messages auto-select.
    if (activeConversationId) return
    if (conversationCount === 0) return

    // Skip auto-selection on mobile web - let user choose from sidebar
    if (isMobileWeb()) {
      hasAutoSelectedRef.current = true // Mark as handled to prevent future attempts
      return
    }

    // Get conversations from store
    const chatState = chatStore.getState()
    const convs = chatState.conversations
    if (!convs || typeof convs.values !== 'function') return

    // Find first non-archived conversation (sorted by most recent)
    const sorted = Array.from(convs.values())
      .filter(c => !chatState.isArchived?.(c.id))
      .sort((a, b) => {
        const aTimestamp = a.lastMessage?.timestamp
        const bTimestamp = b.lastMessage?.timestamp
        const aTime = aTimestamp instanceof Date ? aTimestamp.getTime() : (aTimestamp ? new Date(aTimestamp).getTime() : 0)
        const bTime = bTimestamp instanceof Date ? bTimestamp.getTime() : (bTimestamp ? new Date(bTimestamp).getTime() : 0)
        return bTime - aTime
      })

    const firstConversation = sorted[0]
    if (firstConversation) {
      hasAutoSelectedRef.current = true
      void activateConversation(firstConversation.id)
      navigateToMessages(firstConversation.id)
    }
  }, [status, sidebarView, activeConversationId, conversationCount, activateConversation, navigateToMessages])

  // Auto-select first joined room on initial connection if none selected.
  // Mirrors the messages auto-select above. Required because navigateToView('rooms')
  // can fire before joinedRooms is populated, leaving activeRoomJid null with no retry.
  const hasAutoSelectedRoomRef = useRef(false)
  // Subscribe to a stable count rather than the rooms Map to avoid re-renders during
  // background sync (presence updates, MAM, etc.).
  const roomCount = useRoomStore((s) => s.rooms?.size ?? 0)

  useEffect(() => {
    if (status !== 'online' || hasAutoSelectedRoomRef.current) return
    if (sidebarView !== 'rooms') return
    if (activeRoomJid) return
    if (roomCount === 0) return

    if (isMobileWeb()) {
      hasAutoSelectedRoomRef.current = true
      return
    }

    const roomState = roomStore.getState()
    const allRooms = typeof roomState.allRooms === 'function' ? roomState.allRooms() : []
    const joined = allRooms.filter(r => r.joined || r.isJoining)
    const firstRoom = joined[0]
    if (firstRoom) {
      hasAutoSelectedRoomRef.current = true
      void activateRoom(firstRoom.jid)
      navigateToRooms(firstRoom.jid)
    }
  }, [status, sidebarView, activeRoomJid, roomCount, activateRoom, navigateToRooms])

  // Ensure container has focus for keyboard shortcuts on mount and when window becomes visible
  useEffect(() => {
    // Focus container on mount (handles case where keychain dialog steals focus)
    // Use setTimeout to ensure the element is mounted and any dialogs have closed
    const focusTimer = setTimeout(() => {
      containerRef.current?.focus()
    }, 100)

    // Re-focus when window becomes visible (e.g., after switching apps)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        containerRef.current?.focus()
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [])

  // Handle selecting a contact from the directory
  const handleSelectContact = (contact: Contact) => {
    // Clear active conversation/room to show the contact profile
    setActiveConversation(null)
    setActiveRoom(null)
    setSelectedContactJid(contact.jid)
    navigateToContacts(contact.jid, { replace: true })
    clearAdminSession()
    setAdminCategory(null)
  }

  // On mobile, show main content area only when there's actual content to display
  // For admin: 'users', 'rooms', and 'stats' categories have main view content
  // ('stats' renders the ServerOverview dashboard); 'announcements' just expands
  // to show commands in the sidebar
  const adminHasMainContent = adminSession || adminCategory === 'users' || adminCategory === 'rooms' || adminCategory === 'stats'
  // Settings: only show content when a category is explicitly selected (on mobile, let user choose from sidebar first)
  const settingsHasContent = sidebarView === 'settings' && !!settingsCategory
  const hasActiveContent = !!(activeConversationId || activeRoomJid || selectedContact || adminHasMainContent || settingsHasContent || searchPreviewResult || activityPreviewEvent)

  // Toggle shortcut help overlay
  const toggleShortcutHelp = () => {
    modalActions.toggle('shortcutHelp')
  }

  // Toggle command palette (Cmd-K opens and closes)
  const toggleCommandPalette = () => {
    modalActions.toggle('commandPalette')
  }

  // Handle sidebar view changes - delegates to useViewNavigation hook
  // Phase 3: Per-tab memory and side effects now handled by the hook
  const handleSidebarViewChange = (newView: SidebarView) => {
    // Clear selected contact when switching views
    setSelectedContactJid(null)

    // Navigate using the hook (handles per-tab memory and mark-as-read)
    navigateToView(newView)

    // When switching to a non-admin view, close the admin panel
    if (newView !== 'admin') {
      clearAdminSession()
      setAdminCategory(null)
    }
  }

  // Handle creating quick chat from keyboard shortcut
  const handleCreateQuickChat = () => {
    navigateToRooms()
    modalActions.open('quickChat')
  }

  // Handle adding contact from command palette
  const handleAddContact = () => {
    navigateToContacts()
    modalActions.open('addContact')
  }

  // Global keyboard shortcuts with escape hierarchy
  // Handle toggling presence menu from keyboard shortcut
  const handleTogglePresenceMenu = () => {
    modalActions.toggle('presenceMenu')
  }

  // Handle fully quitting desktop app (Linux/Windows)
  const handleQuitApp = () => {
    const platform = navigator.platform.toLowerCase()
    const isWindowsOrLinux = platform.includes('win') || platform.includes('linux')
    if (!isWindowsOrLinux) return

    const requestQuit = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('exit_app')
      } catch {
        // Not in Tauri environment, ignore
      }
    }

    void requestQuit()
  }

  // Handler for closing contact profile (used by keyboard shortcuts and back button)
  const handleContactBack = () => {
    setSelectedContactJid(null)
    navigateToContacts(undefined, { replace: true })
  }

  // Handle mobile back from admin view - clear category to show sidebar
  const handleAdminBack = () => {
    clearAdminSession()
    setAdminCategory(null)
    navigateToAdmin(undefined, { replace: true })
  }

  // Handle mobile back from settings view - go back to settings sidebar (no category selected)
  const handleSettingsBack = () => {
    navigateToSettings(undefined, { replace: true })
  }

  const shortcuts = useKeyboardShortcuts({
    onToggleShortcutHelp: toggleShortcutHelp,
    onToggleConsole: toggleConsole,
    onOpenSettings: () => navigateToSettings(),
    onQuitApp: handleQuitApp,
    onCreateQuickChat: handleCreateQuickChat,
    onOpenCommandPalette: toggleCommandPalette,
    onOpenPresenceMenu: handleTogglePresenceMenu,
    sidebarView,
    onSidebarViewChange: handleSidebarViewChange,
    navigateToMessages,
    navigateToRooms,
    onFindOnPage: () => {
      const handle = findOnPageRef.current
      if (handle?.isOpen) {
        handle.close()
      } else {
        handle?.open()
      }
    },
    onFindNext: () => findOnPageRef.current?.goToNext(),
    onFindPrev: () => findOnPageRef.current?.goToPrev(),
    escapeHierarchy: {
      isCommandPaletteOpen: showCommandPalette,
      onCloseCommandPalette: () => modalActions.close('commandPalette'),
      isShortcutHelpOpen: showShortcutHelp,
      onCloseShortcutHelp: () => modalActions.close('shortcutHelp'),
      isPresenceMenuOpen: modalState.presenceMenu,
      onClosePresenceMenu: () => modalActions.close('presenceMenu'),
      isQuickChatOpen: modalState.quickChat,
      onCloseQuickChat: () => modalActions.close('quickChat'),
      isConsoleOpen: consoleOpen,
      onCloseConsole: toggleConsole,
      isContactProfileOpen: selectedContact !== null,
      onCloseContactProfile: handleContactBack,
    },
  })

  // Note: We intentionally don't disconnect on window close/hide.
  // On desktop (Tauri), clicking close hides the window but keeps the app running.
  // The XMPP connection stays active in the background for notifications.
  // Disconnect only happens via explicit user action (menu) or app quit.

  const handleChatBack = () => {
    setActiveConversation(null)
    navigateToMessages(undefined, { replace: true })
  }

  const handleRoomBack = () => {
    setActiveRoom(null)
    navigateToRooms(undefined, { replace: true })
  }

  const handleSearchInConversation = (conversationId: string) => {
    searchStore.getState().setSearchScope(conversationId)
    navigateToSearch()
  }

  // Handle starting a conversation from contact profile or double-click
  const handleStartConversation = (contact: Contact) => {
    const chatState = chatStore.getState()

    // Check if conversation is archived - if so, open in archive view
    if (chatState.isArchived(contact.jid)) {
      // Navigate to archive view to show the archived conversation
      handleSidebarViewChange('archive')
      void activateConversation(contact.jid)
      setActiveRoom(null)
      navigateToArchive(contact.jid, { replace: true })
      return
    }

    if (chatState.hasConversation(contact.jid)) {
      // Conversation exists - update name in case contact was renamed
      chatState.updateConversationName(contact.jid, contact.name)
    } else {
      // Create new conversation
      const conversation: Conversation = {
        id: contact.jid,
        name: contact.name,
        type: 'chat',
        unreadCount: 0,
      }
      addConversation(conversation)
    }
    // Navigate first, THEN set conversation - otherwise handleSidebarViewChange
    // will overwrite our selection with the "last conversation" restore logic
    handleSidebarViewChange('messages')
    void activateConversation(contact.jid)
    setActiveRoom(null)
    // Update URL to reflect the selected conversation (replace since tab switch already pushed/replaced)
    navigateToMessages(contact.jid, { replace: true })
    // selectedContact will be cleared by useEffect
  }

  // Handle starting a chat from a JID (e.g., from occupant panel context menu)
  const handleStartChatWithJid = (jid: string) => {
    const chatState = chatStore.getState()
    if (chatState.isArchived(jid)) {
      handleSidebarViewChange('archive')
      void activateConversation(jid)
      setActiveRoom(null)
      navigateToArchive(jid, { replace: true })
      return
    }
    if (!chatState.hasConversation(jid)) {
      const conversation: Conversation = {
        id: jid,
        name: jid,
        type: 'chat',
        unreadCount: 0,
      }
      addConversation(conversation)
    }
    handleSidebarViewChange('messages')
    void activateConversation(jid)
    setActiveRoom(null)
    navigateToMessages(jid, { replace: true })
  }

  // Handle showing user profile from occupant panel context menu
  const handleShowProfileFromRoom = (jid: string) => {
    setActiveConversation(null)
    setActiveRoom(null)
    // Navigate first (which clears selectedContactJid), then set JID
    handleSidebarViewChange('directory')
    setSelectedContactJid(jid)
    navigateToContacts(jid, { replace: true })
  }

  // Handle adding a contact (subscription request)
  const handleAddContactFromProfile = async (jid: string) => {
    await addContact(jid)
  }

  // Handle removing a contact
  const handleRemoveContact = async (jid: string) => {
    await removeContact(jid)
    setSelectedContactJid(null)
  }

  // Handle renaming a contact
  const handleRenameContact = async (jid: string, name: string) => {
    await renameContact(jid, name)
    // selectedContact now derives from store, so it updates automatically
  }

  // Handle fetching contact nickname (PEP XEP-0172)
  const handleFetchContactNickname = async (jid: string) => {
    return fetchContactNickname(jid)
  }

  // Handle fetching contact vCard (XEP-0054)
  const handleFetchVCard = async (jid: string) => {
    return fetchVCard(jid)
  }

  // Handle admin category change from sidebar
  const handleAdminCategoryChange = (category: AdminCategory | null) => {
    // Clear any active admin session when changing category
    if (category) {
      clearAdminSession()
    }
    setAdminCategory(category)
  }

  // Admin "home": on a wide screen, default to the server overview (stats) when
  // entering the admin panel with nothing selected. Runs before paint to avoid a
  // flash of the empty placeholder. Mobile keeps the list-first convention so the
  // category list shows first, and non-admins still see the access-denied state.
  useLayoutEffect(() => {
    if (sidebarView !== 'admin' || isSmallScreen()) return
    if (!adminIsAdmin || adminCategory || adminSession) return
    adminStore.getState().setActiveCategory('stats')
  }, [sidebarView, adminIsAdmin, adminCategory, adminSession])

  // Handle managing a user from roster context menu
  const handleManageUser = (jid: string) => {
    // Set up navigation to admin user management for this user
    const domain = navigateToUserAdmin(jid)
    if (domain) {
      // Clear any active admin session before navigating
      clearAdminSession()
      // Switch to admin view - navigateToView handles per-tab memory
      navigateToView('admin')
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="flex flex-col h-full bg-fluux-bg text-fluux-text no-focus-ring"
    >
      {/* Global side-effect hooks isolated from ChatLayout re-renders */}
      <GlobalEffects />

      {/* Main content area */}
      <div className="flex flex-1 min-h-0">
        {/* Left Sidebar - Conversations */}
        {/* Hidden on mobile when conversation or room is active, full width on mobile */}
        <div className={`${hasActiveContent ? 'hidden md:flex' : 'flex'} w-full md:w-auto`}>
          <Sidebar
            onSelectContact={handleSelectContact}
            onStartChat={handleStartConversation}
            onManageUser={handleManageUser}
            adminCategory={adminCategory}
            onAdminCategoryChange={handleAdminCategoryChange}
            sidebarListRef={focusZoneRefs.sidebarList}
            activeContactJid={selectedContact?.jid}
            onViewChange={handleSidebarViewChange}
          />
        </div>

        {/* Main Content Area */}
        {/* Hidden on mobile when no conversation/room selected */}
        <main className={`${hasActiveContent ? 'flex' : 'hidden md:flex'} flex-1 flex-col bg-fluux-chat min-w-0 min-h-0`}>
          {sidebarView === 'settings' ? (
            <Suspense fallback={<ViewLoadingFallback />}>
              <SettingsView onBack={handleSettingsBack} />
            </Suspense>
          ) : activeRoomJid && showRoomOccupants && isSmallScreen() ? (
            <FullScreenOccupantPanel onClose={() => setShowRoomOccupants(false)} onStartChat={handleStartChatWithJid} onShowProfile={handleShowProfileFromRoom} />
          ) : activeRoomJid ? (
            <RoomView onBack={handleRoomBack} mainContentRef={focusZoneRefs.mainContent} composerRef={focusZoneRefs.composer} showOccupants={showRoomOccupants} onShowOccupantsChange={setShowRoomOccupants} onStartChat={handleStartChatWithJid} onShowProfile={handleShowProfileFromRoom} findOnPageRef={findOnPageRef} onSearchInConversation={handleSearchInConversation} />
          ) : activeConversationId ? (
            <ChatView onBack={handleChatBack} onSwitchToMessages={(conversationId) => navigateToMessages(conversationId)} mainContentRef={focusZoneRefs.mainContent} composerRef={focusZoneRefs.composer} findOnPageRef={findOnPageRef} onSearchInConversation={handleSearchInConversation} onShowProfile={handleShowProfileFromRoom} />
          ) : selectedContact ? (
            <Suspense fallback={<ViewLoadingFallback />}>
              <ContactProfileView
                contact={selectedContact}
                isInRoster={isSelectedContactInRoster}
                onStartConversation={() => handleStartConversation(selectedContact)}
                onAddContact={() => handleAddContactFromProfile(selectedContact.jid)}
                onRemoveContact={() => handleRemoveContact(selectedContact.jid)}
                onRenameContact={(name) => handleRenameContact(selectedContact.jid, name)}
                onFetchNickname={handleFetchContactNickname}
                onFetchVCard={handleFetchVCard}
                onBack={handleContactBack}
              />
            </Suspense>
          ) : (adminSession || adminCategory) ? (
            <Suspense fallback={<ViewLoadingFallback />}>
              <AdminView activeCategory={adminCategory} onBack={handleAdminBack} />
            </Suspense>
          ) : sidebarView === 'admin' ? (
            <AdminEmptyState />
          ) : searchPreviewResult ? (
            <Suspense fallback={<ViewLoadingFallback />}>
              <SearchContextView onBack={() => searchStore.getState().setPreviewResult(null)} />
            </Suspense>
          ) : activityPreviewEvent ? (
            <Suspense fallback={<ViewLoadingFallback />}>
              <ActivityContextView onBack={() => activityLogStore.getState().setPreviewEvent(null)} />
            </Suspense>
          ) : (
            <EmptyState sidebarView={sidebarView} />
          )}
        </main>

        {/* Right Sidebar - Members (only for group chats) */}
        <MemberList />
      </div>

      {/* XMPP Console Panel */}
      <Suspense fallback={null}>
        <XmppConsole />
      </Suspense>

      {/* Keyboard Shortcuts Help Overlay */}
      {showShortcutHelp && (
        <ShortcutHelp
          shortcuts={shortcuts}
          onClose={() => modalActions.close('shortcutHelp')}
        />
      )}

      {/* Command Palette */}
      <CommandPalette
        isOpen={showCommandPalette}
        onClose={() => modalActions.close('commandPalette')}
        onSidebarViewChange={handleSidebarViewChange}
        onOpenSettings={() => navigateToSettings()}
        onToggleConsole={toggleConsole}
        onToggleShortcutHelp={toggleShortcutHelp}
        onCreateQuickChat={handleCreateQuickChat}
        onAddContact={handleAddContact}
        onStartConversation={(jid) => {
          const contact = rosterStore.getState().contacts.get(jid)
          if (contact) handleStartConversation(contact)
        }}
      />

      {/* Toast Notifications */}
      <ToastContainer />
    </div>
  )
}

/**
 * Full-screen occupant panel for mobile. Wraps OccupantPanel with the
 * necessary store subscriptions isolated from ChatLayout.
 */
function FullScreenOccupantPanel({ onClose, onStartChat, onShowProfile }: {
  onClose: () => void
  onStartChat?: (jid: string) => void
  onShowProfile?: (jid: string) => void
}) {
  const activeRoom = useRoomStore((s) => {
    const jid = s.activeRoomJid
    return jid ? s.rooms.get(jid) : undefined
  })
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  // Presence-immune identity map (name/avatar) — same fix as RoomView: using
  // useContactIdentities instead of the full roster keeps occupant rows from
  // re-rendering on every presence stanza.
  const contactsByJid = useContactIdentities()

  if (!activeRoom) return null

  return (
    <OccupantPanel
      room={activeRoom}
      contactsByJid={contactsByJid}
      ownAvatar={ownAvatar}
      onClose={onClose}
      onStartChat={onStartChat}
      onShowProfile={onShowProfile}
      fullScreen
    />
  )
}

function EmptyState({ sidebarView }: { sidebarView: SidebarView }) {
  const { t } = useTranslation()

  // Icon matches the icon-rail glyph for each view, using the same lucide set
  // as the rest of the app (no hand-rolled Material SVG paths).
  const getEmptyStateContent = (): { Icon: LucideIcon; title: string; description: string; hint?: string } => {
    switch (sidebarView) {
      case 'messages':
        return {
          Icon: MessageCircle,
          title: t('emptyState.messages.title'),
          description: t('emptyState.messages.description'),
        }
      case 'rooms':
        return {
          Icon: Hash,
          title: t('emptyState.rooms.title'),
          description: t('emptyState.rooms.description'),
        }
      case 'directory':
        return {
          Icon: Users,
          title: t('emptyState.directory.title'),
          description: t('emptyState.directory.description'),
          hint: t('emptyState.directory.hint'),
        }
      case 'archive':
        return {
          Icon: Archive,
          title: t('emptyState.archive.title'),
          description: t('emptyState.archive.description'),
        }
      case 'events':
        return {
          Icon: Bell,
          title: t('emptyState.events.title'),
          description: t('emptyState.events.description'),
        }
      case 'admin':
        return {
          Icon: Server,
          title: t('emptyState.admin.title'),
          description: t('emptyState.admin.description'),
        }
      case 'search':
        return {
          Icon: Search,
          title: t('emptyState.search.title'),
          description: t('emptyState.search.description'),
        }
      case 'settings':
        // Settings view always has content, this shouldn't be reached
        return {
          Icon: Settings,
          title: t('settings.title'),
          description: '',
        }
      default:
        return {
          Icon: MessageCircle,
          title: t('emptyState.messages.title'),
          description: t('emptyState.messages.description'),
        }
    }
  }

  const { Icon, title, description, hint } = getEmptyStateContent()

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted px-6 text-center">
      <div className="size-24 bg-fluux-sidebar rounded-full flex items-center justify-center mb-4">
        <Icon className="size-12" />
      </div>
      <h2 className="text-xl font-semibold text-fluux-text mb-2">{title}</h2>
      <p className="max-w-sm">{description}</p>
      {hint && <p className="max-w-sm mt-2">{hint}</p>}
    </div>
  )
}

/**
 * Admin empty state with header - shown when admin tab is selected but no category is chosen.
 * Has the same header structure as AdminView for consistency.
 * Shows a "no access" message if user is not an admin.
 */
function AdminEmptyState() {
  const { t } = useTranslation()
  const { titleBarClass } = useWindowDrag()
  const isAdmin = useAdminStore((s) => s.isAdmin)

  return (
    <div className="flex-1 flex flex-col bg-fluux-sidebar">
      {/* Header - no close button on root admin screen */}
      <div className={`flex items-center px-4 py-3 ${titleBarClass} border-b border-fluux-bg`}>
        <div className="flex items-center gap-2">
          <Server className="size-5 text-fluux-muted" />
          <h2 className="font-semibold text-fluux-text">{t('admin.title')}</h2>
        </div>
      </div>

      {/* Content - show access denied or select command prompt */}
      <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted p-4">
        {isAdmin ? (
          <>
            <Server className="size-12 mb-2 opacity-50" />
            <p>{t('admin.selectCommand')}</p>
          </>
        ) : (
          <>
            <ShieldOff className="size-12 mb-3 opacity-50" />
            <p className="font-medium text-fluux-text mb-1">{t('admin.noAccess.title')}</p>
            <p className="text-center max-w-md">{t('admin.noAccess.description')}</p>
          </>
        )}
      </div>
    </div>
  )
}
