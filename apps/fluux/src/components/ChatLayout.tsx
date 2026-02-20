import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { Sidebar, type SidebarView } from './Sidebar'
import { ChatView } from './ChatView'
import { RoomView } from './RoomView'
import { ContactProfileView } from './ContactProfileView'
import { SettingsView } from './SettingsView'
import { AdminView } from './AdminView'
import { MemberList } from './MemberList'
import { XmppConsole } from './XmppConsole'
import { ShortcutHelp } from './ShortcutHelp'
import { CommandPalette } from './CommandPalette'
import { ToastContainer } from './ToastContainer'
import {
  // Vanilla stores for imperative .getState() access
  chatStore, consoleStore, adminStore, rosterStore,
  useRosterActions,
  type Contact, type Conversation, type AdminCategory
} from '@fluux/sdk'
// React hook wrappers for reactive subscriptions
import { useChatStore, useRoomStore, useRosterStore, useConnectionStore, useConsoleStore, useAdminStore } from '@fluux/sdk/react'
import { useNotificationBadge } from '@/hooks/useNotificationBadge'
import { useDesktopNotifications } from '@/hooks/useDesktopNotifications'
import { useWebPush } from '@/hooks/useWebPush'
import { useSoundNotification } from '@/hooks/useSoundNotification'
import { useEventsSoundNotification } from '@/hooks/useEventsSoundNotification'
import { useEventsDesktopNotifications } from '@/hooks/useEventsDesktopNotifications'
import { usePlatformState } from '@/hooks/usePlatformState'
import { useSDKErrorToasts } from '@/hooks/useSDKErrorToasts'
import { useFocusZones, useViewNavigation, isMobileWeb, useWindowVisibility, useRouteSync, type FocusZoneRefs } from '@/hooks'
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { useDeepLink } from '@/hooks/useDeepLink'
import { saveViewState, getSavedViewState, type ViewStateData } from '@/hooks/useSessionPersistence'
import { useWindowDrag } from '@/hooks'
import { LayoutProvider, useModals } from '@/contexts'
import { Wrench, ShieldOff } from 'lucide-react'

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

  // Platform state detection: wake/sleep, idle/activity, visibility
  usePlatformState()

  // Track window visibility for new message markers
  useWindowVisibility()

  // Surface SDK error events as toast notifications
  useSDKErrorToasts()

  // Handle XMPP URI deep links (xmpp:user@example.com?message)
  useDeepLink()

  return null
}

function ChatLayoutContent() {
  // Detect render loops before they freeze the UI
  detectRenderLoop('ChatLayout')

  // Modal management from context
  const { state: modalState, actions: modalActions } = useModals()

  // NOTE: Subscribe directly to stores instead of using useChat()/useRoom() hooks.
  // Those hooks subscribe to activeMessages which changes frequently during MAM loading,
  // causing unnecessary re-renders of ChatLayout (which only needs IDs and setters).
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const addConversation = useChatStore((s) => s.addConversation)
  const activeRoomJid = useRoomStore((s) => s.activeRoomJid)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)

  // NOTE: Don't use useRoster() hook here - it subscribes to ALL contacts and triggers
  // re-renders when ANY contact's presence changes. Use useRosterActions() for actions
  // without state subscription, and focused selectors for specific contact state.
  const { removeContact, renameContact, fetchContactNickname } = useRosterActions()
  // NOTE: Don't use useConnection() hook - it subscribes to MANY state values (jid, error,
  // reconnectAttempt, ownAvatar, etc.) and re-renders when ANY changes. We only need status.
  const status = useConnectionStore((s) => s.status)
  // NOTE: Don't use useConsole() hook - it subscribes to `entries` which changes with every
  // XMPP packet, causing render loops. We only need isOpen and toggle.
  const consoleOpen = useConsoleStore((s) => s.isOpen)
  const toggleConsole = useCallback(() => {
    consoleStore.getState().toggle()
  }, [])
  // NOTE: Don't use useAdmin() hook - it subscribes to many values. Use focused selectors.
  const adminSession = useAdminStore((s) => s.currentSession)
  const adminCategory = useAdminStore((s) => s.activeCategory)
  const clearAdminSession = useCallback(() => {
    adminStore.getState().setCurrentSession(null)
    adminStore.getState().setTargetJid(null)
  }, [])
  const setAdminCategory = useCallback((category: AdminCategory | null) => {
    adminStore.getState().setActiveCategory(category)
  }, [])
  const navigateToUserAdmin = useCallback((userJid: string): string | null => {
    const store = adminStore.getState()
    const domain = userJid.split('@')[1]?.split('/')[0]
    if (!domain) return null
    const adminVhosts = store.vhosts
    if (adminVhosts.length > 0 && !adminVhosts.includes(domain)) return null
    store.setSelectedVhost(domain)
    store.setPendingSelectedUserJid(userJid)
    store.setActiveCategory('users')
    return domain
  }, [])
  // Modal state from useModals() hook via LayoutContext
  // showShortcutHelp and showCommandPalette are used in this component
  // quickChat, addContact, and presenceMenu are only used by Sidebar (which gets them from context)
  const { shortcutHelp: showShortcutHelp, commandPalette: showCommandPalette } = modalState

  // Selected contact JID from directory (for profile view)
  // Store only the JID, derive contact from store so presence updates in real-time
  // Use focused selector that only re-renders when THIS specific contact changes
  const [selectedContactJid, setSelectedContactJid] = useState<string | null>(null)
  const selectedContact = useRosterStore((s) =>
    selectedContactJid ? s.contacts.get(selectedContactJid) ?? null : null
  )

  // Room occupants panel state (persisted across view switches)
  const [showRoomOccupants, setShowRoomOccupants] = useState(false)

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
  } = useViewNavigation(selectedContact)

  // Get settingsCategory to determine if settings has explicit content selected
  const { settingsCategory } = useRouteSync()


  // Ref for main container to enable focus for keyboard shortcuts
  const containerRef = useRef<HTMLDivElement>(null)

  // Focus zone refs for Tab cycling - create refs at top level (stable across renders)
  const sidebarListRef = useRef<HTMLDivElement>(null)
  const mainContentRef = useRef<HTMLElement>(null)
  const composerRef = useRef<HTMLElement>(null)

  // Memoize the refs object so it's stable across renders
  // Without this, useFocusZones would recreate callbacks on every render
  const focusZoneRefs = useMemo<FocusZoneRefs>(() => ({
    sidebarList: sidebarListRef,
    mainContent: mainContentRef,
    composer: composerRef,
  }), [])

  // Enable Tab cycling between focus zones
  useFocusZones(focusZoneRefs)

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
      setActiveConversation(savedViewState.activeConversationId)
      setActiveRoom(savedViewState.activeRoomJid)

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
  }, [setActiveConversation, setActiveRoom, navigateToMessages, navigateToRooms, navigateToContacts, navigateToArchive, navigateToEvents, navigateToAdmin, navigateToSettings])

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
    if (activeConversationId || activeRoomJid || selectedContactJid) return
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
      setActiveConversation(firstConversation.id)
      navigateToMessages(firstConversation.id)
    }
  }, [status, sidebarView, activeConversationId, activeRoomJid, selectedContactJid, conversationCount, setActiveConversation, navigateToMessages])

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
  const handleSelectContact = useCallback((contact: Contact) => {
    // Clear active conversation/room to show the contact profile
    setActiveConversation(null)
    setActiveRoom(null)
    setSelectedContactJid(contact.jid)
    clearAdminSession()
    setAdminCategory(null)
  }, [setActiveConversation, setActiveRoom, clearAdminSession, setAdminCategory])

  // On mobile, show main content area only when there's actual content to display
  // For admin: only 'users' and 'rooms' categories have main view content
  // 'stats' and 'announcements' just expand to show commands in the sidebar
  const adminHasMainContent = adminSession || adminCategory === 'users' || adminCategory === 'rooms'
  // Settings: only show content when a category is explicitly selected (on mobile, let user choose from sidebar first)
  const settingsHasContent = sidebarView === 'settings' && !!settingsCategory
  const hasActiveContent = !!(activeConversationId || activeRoomJid || selectedContact || adminHasMainContent || settingsHasContent)

  // Toggle shortcut help overlay
  const toggleShortcutHelp = useCallback(() => {
    modalActions.toggle('shortcutHelp')
  }, [modalActions])

  // Toggle command palette (Cmd-K opens and closes)
  const toggleCommandPalette = useCallback(() => {
    modalActions.toggle('commandPalette')
  }, [modalActions])

  // Handle sidebar view changes - delegates to useViewNavigation hook
  // Phase 3: Per-tab memory and side effects now handled by the hook
  const handleSidebarViewChange = useCallback((newView: SidebarView) => {
    // Clear selected contact when switching views
    setSelectedContactJid(null)

    // Navigate using the hook (handles per-tab memory and mark-as-read)
    navigateToView(newView)

    // When switching to a non-admin view, close the admin panel
    if (newView !== 'admin') {
      clearAdminSession()
      setAdminCategory(null)
    }
  }, [navigateToView, clearAdminSession, setAdminCategory])

  // Handle creating quick chat from keyboard shortcut
  const handleCreateQuickChat = useCallback(() => {
    navigateToRooms()
    modalActions.open('quickChat')
  }, [navigateToRooms, modalActions])

  // Handle adding contact from command palette
  const handleAddContact = useCallback(() => {
    navigateToContacts()
    modalActions.open('addContact')
  }, [navigateToContacts, modalActions])

  // Global keyboard shortcuts with escape hierarchy
  // Handle toggling presence menu from keyboard shortcut
  const handleTogglePresenceMenu = useCallback(() => {
    modalActions.toggle('presenceMenu')
  }, [modalActions])

  // Handle fully quitting desktop app (Linux/Windows)
  const handleQuitApp = useCallback(() => {
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
  }, [])

  // Handler for closing contact profile (used by keyboard shortcuts)
  const handleContactBack = () => setSelectedContactJid(null)

  // Handle mobile back from admin view - clear category to show sidebar
  const handleAdminBack = useCallback(() => {
    clearAdminSession()
    setAdminCategory(null)
  }, [clearAdminSession, setAdminCategory])

  // Handle mobile back from settings view - go back to settings sidebar (no category selected)
  const handleSettingsBack = useCallback(() => {
    navigateToSettings()
  }, [navigateToSettings])

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

  const handleChatBack = () => setActiveConversation(null)
  const handleRoomBack = () => setActiveRoom(null)

  // Handle starting a conversation from contact profile or double-click
  const handleStartConversation = useCallback((contact: Contact) => {
    const chatState = chatStore.getState()

    // Check if conversation is archived - if so, open in archive view
    if (chatState.isArchived(contact.jid)) {
      // Navigate to archive view to show the archived conversation
      handleSidebarViewChange('archive')
      setActiveConversation(contact.jid)
      setActiveRoom(null)
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
    setActiveConversation(contact.jid)
    setActiveRoom(null)
    // selectedContact will be cleared by useEffect
  }, [addConversation, setActiveConversation, setActiveRoom, handleSidebarViewChange])

  // Handle removing a contact
  const handleRemoveContact = useCallback(async (jid: string) => {
    await removeContact(jid)
    setSelectedContactJid(null)
  }, [removeContact])

  // Handle renaming a contact
  const handleRenameContact = useCallback(async (jid: string, name: string) => {
    await renameContact(jid, name)
    // selectedContact now derives from store, so it updates automatically
  }, [renameContact])

  // Handle fetching contact nickname (PEP XEP-0172)
  const handleFetchContactNickname = useCallback(async (jid: string) => {
    return fetchContactNickname(jid)
  }, [fetchContactNickname])

  // Handle admin category change from sidebar
  const handleAdminCategoryChange = useCallback((category: AdminCategory | null) => {
    // Clear any active admin session when changing category
    if (category) {
      clearAdminSession()
    }
    setAdminCategory(category)
  }, [clearAdminSession, setAdminCategory])

  // Handle managing a user from roster context menu
  const handleManageUser = useCallback((jid: string) => {
    // Set up navigation to admin user management for this user
    const domain = navigateToUserAdmin(jid)
    if (domain) {
      // Clear any active admin session before navigating
      clearAdminSession()
      // Switch to admin view - navigateToView handles per-tab memory
      navigateToView('admin')
    }
  }, [navigateToUserAdmin, clearAdminSession, navigateToView])

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
            <SettingsView onBack={handleSettingsBack} />
          ) : activeRoomJid ? (
            <RoomView onBack={handleRoomBack} mainContentRef={focusZoneRefs.mainContent} composerRef={focusZoneRefs.composer} showOccupants={showRoomOccupants} onShowOccupantsChange={setShowRoomOccupants} />
          ) : activeConversationId ? (
            <ChatView onBack={handleChatBack} onSwitchToMessages={(conversationId) => navigateToMessages(conversationId)} mainContentRef={focusZoneRefs.mainContent} composerRef={focusZoneRefs.composer} />
          ) : selectedContact ? (
            <ContactProfileView
              contact={selectedContact}
              onStartConversation={() => handleStartConversation(selectedContact)}
              onRemoveContact={() => handleRemoveContact(selectedContact.jid)}
              onRenameContact={(name) => handleRenameContact(selectedContact.jid, name)}
              onFetchNickname={handleFetchContactNickname}
              onBack={handleContactBack}
            />
          ) : (adminSession || adminCategory) ? (
            <AdminView activeCategory={adminCategory} onBack={handleAdminBack} />
          ) : sidebarView === 'admin' ? (
            <AdminEmptyState />
          ) : (
            <EmptyState sidebarView={sidebarView} />
          )}
        </main>

        {/* Right Sidebar - Members (only for group chats) */}
        <MemberList />
      </div>

      {/* XMPP Console Panel */}
      <XmppConsole />

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

function EmptyState({ sidebarView }: { sidebarView: SidebarView }) {
  const { t } = useTranslation()

  // Get icon and content based on current tab
  const getEmptyStateContent = () => {
    switch (sidebarView) {
      case 'messages':
        return {
          icon: (
            <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
            </svg>
          ),
          title: t('emptyState.messages.title'),
          description: t('emptyState.messages.description'),
        }
      case 'rooms':
        return {
          icon: (
            <svg className="w-12 h-12" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 9h16M4 15h16M10 3l-2 18M16 3l-2 18"/>
            </svg>
          ),
          title: t('emptyState.rooms.title'),
          description: t('emptyState.rooms.description'),
        }
      case 'directory':
        return {
          icon: (
            <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
            </svg>
          ),
          title: t('emptyState.directory.title'),
          description: t('emptyState.directory.description'),
          hint: t('emptyState.directory.hint'),
        }
      case 'archive':
        return {
          icon: (
            <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z"/>
            </svg>
          ),
          title: t('emptyState.archive.title'),
          description: t('emptyState.archive.description'),
        }
      case 'events':
        return {
          icon: (
            <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
            </svg>
          ),
          title: t('emptyState.events.title'),
          description: t('emptyState.events.description'),
        }
      case 'admin':
        return {
          icon: (
            <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          ),
          title: t('emptyState.admin.title'),
          description: t('emptyState.admin.description'),
        }
      case 'settings':
        // Settings view always has content, this shouldn't be reached
        return {
          icon: (
            <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
              <path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/>
            </svg>
          ),
          title: t('settings.title'),
          description: '',
        }
      default:
        return {
          icon: (
            <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H6l-2 2V4h16v12z"/>
            </svg>
          ),
          title: t('emptyState.messages.title'),
          description: t('emptyState.messages.description'),
        }
    }
  }

  const content = getEmptyStateContent()

  return (
    <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted px-6 text-center">
      <div className="w-24 h-24 bg-fluux-sidebar rounded-full flex items-center justify-center mb-4">
        {content.icon}
      </div>
      <h2 className="text-xl font-semibold text-fluux-text mb-2">{content.title}</h2>
      <p className="max-w-sm">{content.description}</p>
      {content.hint && <p className="max-w-sm mt-2">{content.hint}</p>}
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
          <Wrench className="w-5 h-5 text-fluux-muted" />
          <h2 className="font-semibold text-fluux-text">{t('admin.title')}</h2>
        </div>
      </div>

      {/* Content - show access denied or select command prompt */}
      <div className="flex-1 flex flex-col items-center justify-center text-fluux-muted p-4">
        {isAdmin ? (
          <>
            <Wrench className="w-12 h-12 mb-2 opacity-50" />
            <p>{t('admin.selectCommand')}</p>
          </>
        ) : (
          <>
            <ShieldOff className="w-12 h-12 mb-3 opacity-50" />
            <p className="font-medium text-fluux-text mb-1">{t('admin.noAccess.title')}</p>
            <p className="text-center max-w-md">{t('admin.noAccess.description')}</p>
          </>
        )}
      </div>
    </div>
  )
}
