import React, { useState, useRef, useEffect, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop, trackSelectorChange } from '@/utils/renderLoopDetector'
import { useClickOutside, useWindowDrag, useRouteSync } from '@/hooks'
import { useModals } from '@/contexts'
import {
  useXMPP,
  connectionStore,
  type Contact,
  type AdminCategory,
} from '@fluux/sdk'
import { useConnectionStore, useChatStore, useRoomStore, useEventsStore, useAdminStore } from '@fluux/sdk/react'
import { AdminDashboard } from './AdminDashboard'
import { BrowseRoomsModal } from './BrowseRoomsModal'
import { JoinRoomModal } from './JoinRoomModal'
import { Avatar } from './Avatar'
import { Tooltip } from './Tooltip'
import { AddContactModal } from './AddContactModal'
import { CreateRoomModal } from './CreateRoomModal'
import { CreateQuickChatModal } from './CreateQuickChatModal'
import { SettingsSidebar, type SettingsCategory, DEFAULT_SETTINGS_CATEGORY } from './settings-components'
import {
  MessageCircle,
  Hash,
  X,
  ChevronDown,
  Settings,
  Plus,
  Users,
  Bell,
  Archive,
  Wrench,
  Zap,
  Search,
  LogIn,
  Ban,
  UserPlus,
  RefreshCw,
} from 'lucide-react'
import { clearSession } from '@/hooks/useSessionPersistence'
import { deleteCredentials } from '@/utils/keychain'
import { clearLocalData } from '@/utils/clearLocalData'

// Import extracted sidebar components
import {
  type SidebarView,
  SidebarZoneContext,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_KEY,
  IconRailNavLink,
  PresenceSelector,
  StatusDisplay,
  ConversationList,
  ArchiveList,
  ContactList,
  RoomsList,
  EventsView,
  ActivityLogView,
  SearchView,
  UserMenu,
} from './sidebar-components'

// Re-export SidebarView for external use
export type { SidebarView }

const LOGOUT_DISCONNECT_TIMEOUT_MS = 2500
const LOGOUT_KEYCHAIN_TIMEOUT_MS = 2500

interface SidebarProps {
  onSelectContact?: (contact: Contact) => void
  onStartChat?: (contact: Contact) => void
  onManageUser?: (jid: string) => void
  adminCategory?: AdminCategory | null
  onAdminCategoryChange?: (category: AdminCategory | null) => void
  // Focus zone ref for Tab cycling
  sidebarListRef?: RefObject<HTMLDivElement | null>
  // Active contact JID for highlighting in directory view
  activeContactJid?: string | null
  // Handler for view changes - ensures all state cleanup happens in one place
  onViewChange: (view: SidebarView) => void
}

export function Sidebar({ onSelectContact, onStartChat, onManageUser, adminCategory, onAdminCategoryChange, sidebarListRef, activeContactJid, onViewChange }: SidebarProps) {
  detectRenderLoop('Sidebar')
  const { t } = useTranslation()
  // Get current view from URL
  const { sidebarView, settingsCategory, navigateToSettings } = useRouteSync()
  // Use focused selectors instead of useConnection() to avoid re-renders when unrelated values change
  // (e.g., ownResources updates shouldn't re-render the entire sidebar)
  const jid = useConnectionStore((s) => s.jid)
  const status = useConnectionStore((s) => s.status)
  const isVerifying = useConnectionStore((s) => s.isVerifying)

  // Suppress brief 'verifying' flashes: only show verifying after a 2s delay.
  const [showVerifying, setShowVerifying] = useState(false)
  useEffect(() => {
    if (isVerifying) {
      const timer = setTimeout(() => setShowVerifying(true), 2000)
      return () => clearTimeout(timer)
    }
    setShowVerifying(false)
  }, [isVerifying])
  const reconnectAttempt = useConnectionStore((s) => s.reconnectAttempt)
  const reconnectTargetTime = useConnectionStore((s) => s.reconnectTargetTime)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  // Get methods from client (not from store)
  const { client } = useXMPP()
  const disconnect = () => client.disconnect()
  const cancelReconnect = () => client.cancelReconnect()
  const isAdmin = useAdminStore((s) => s.isAdmin)
  // Use targeted store selectors instead of useChat()/useRoom() to avoid render loops.
  // Those hooks subscribe to many store properties (conversations array, messages, etc.)
  // which create new references during the post-connection initialization burst.
  const totalUnread = useChatStore((s) => {
    let sum = 0
    for (const meta of s.conversationMeta.values()) sum += meta.unreadCount
    return sum
  })
  const pendingCount = useEventsStore((s) =>
    s.subscriptionRequests.length +
    new Set(s.strangerMessages.map((m) => m.from)).size +
    s.mucInvitations.length +
    s.systemNotifications.length
  )
  const totalMentionsCount = useRoomStore((s) => s.totalMentionsCount())
  const totalNotifiableUnreadCount = useRoomStore((s) => s.totalNotifiableUnreadCount())

  // Diagnostic: track every selector value per render. Dev-only (guarded inside
  // trackSelectorChange). Helps pinpoint unstable selectors causing render loops.
  trackSelectorChange('Sidebar', 'jid', jid)
  trackSelectorChange('Sidebar', 'status', status)
  trackSelectorChange('Sidebar', 'isVerifying', isVerifying)
  trackSelectorChange('Sidebar', 'reconnectAttempt', reconnectAttempt)
  trackSelectorChange('Sidebar', 'reconnectTargetTime', reconnectTargetTime)
  trackSelectorChange('Sidebar', 'ownAvatar', ownAvatar)
  trackSelectorChange('Sidebar', 'ownNickname', ownNickname)
  trackSelectorChange('Sidebar', 'isAdmin', isAdmin)
  trackSelectorChange('Sidebar', 'totalUnread', totalUnread)
  trackSelectorChange('Sidebar', 'pendingCount', pendingCount)
  trackSelectorChange('Sidebar', 'totalMentionsCount', totalMentionsCount)
  trackSelectorChange('Sidebar', 'totalNotifiableUnreadCount', totalNotifiableUnreadCount)
  const { titleBarClass, dragRegionProps } = useWindowDrag()

  // Modal state from context - shared with ChatLayout
  const { state: modalState, actions: modalActions } = useModals()
  const showQuickChat = modalState.quickChat
  const showAddContact = modalState.addContact
  const showPresenceMenu = modalState.presenceMenu

  // Local UI state (not shared)
  const [showCreateRoom, setShowCreateRoom] = useState(false)
  const [showBrowseRooms, setShowBrowseRooms] = useState(false)
  const [showJoinRoom, setShowJoinRoom] = useState(false)
  const [showRoomDropdown, setShowRoomDropdown] = useState(false)
  const [isCatchingUpRooms, setIsCatchingUpRooms] = useState(false)
  const roomDropdownRef = useRef<HTMLDivElement>(null)
  const [showContactDropdown, setShowContactDropdown] = useState(false)
  const contactDropdownRef = useRef<HTMLDivElement>(null)

  // Sidebar resize state
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    return saved ? parseInt(saved, 10) : SIDEBAR_DEFAULT_WIDTH
  })
  const [isResizing, setIsResizing] = useState(false)
  const [isResizeHover, setIsResizeHover] = useState(false)
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 768)
  const sidebarRef = useRef<HTMLElement>(null)

  // Track desktop/mobile breakpoint
  useEffect(() => {
    const mediaQuery = window.matchMedia('(min-width: 768px)')
    const handleChange = (e: MediaQueryListEvent) => setIsDesktop(e.matches)
    mediaQuery.addEventListener('change', handleChange)
    return () => mediaQuery.removeEventListener('change', handleChange)
  }, [])

  // Handle resize drag
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }

  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, e.clientX))
      setSidebarWidth(newWidth)
    }

    const handleMouseUp = () => {
      setIsResizing(false)
      localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString())
    }

    // Set cursor globally during resize
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)

    return () => {
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizing, sidebarWidth])

  // Save width when it changes (debounced by mouseup)
  useEffect(() => {
    if (!isResizing) {
      localStorage.setItem(SIDEBAR_WIDTH_KEY, sidebarWidth.toString())
    }
  }, [sidebarWidth, isResizing])

  // Double-click to reset to default width
  const handleDoubleClick = () => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
    localStorage.setItem(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH.toString())
  }

  // Close dropdowns when clicking outside
  const closeRoomDropdown = () => setShowRoomDropdown(false)
  useClickOutside(roomDropdownRef, closeRoomDropdown, showRoomDropdown)
  const closeContactDropdown = () => setShowContactDropdown(false)
  useClickOutside(contactDropdownRef, closeContactDropdown, showContactDropdown)

  // totalUnread is computed directly via useChatStore selector above

  return (
    <aside
      ref={sidebarRef}
      className="relative bg-fluux-sidebar flex select-none flex-shrink-0"
      style={{ width: isDesktop ? sidebarWidth : '100%' }}
    >
      {/* Icon Rail - with padding for macOS traffic lights */}
      <div className="w-14 bg-fluux-bg flex flex-col items-center pt-8 pb-3 gap-2">
        {/* Fluux logo - enable with VITE_SHOW_LOGO=true */}
        {import.meta.env.VITE_SHOW_LOGO === 'true' && (
          <img
            src="/logo.png"
            alt="Fluux"
            className="w-7 h-7 mb-2 opacity-80"
            draggable={false}
          />
        )}
        <IconRailNavLink
          icon={MessageCircle}
          label={t('sidebar.messages')}
          view="messages"
          pathPrefix="/messages"
          onNavigate={onViewChange}
          showBadge={totalUnread > 0}
        />
        <IconRailNavLink
          icon={Hash}
          label={t('sidebar.rooms')}
          view="rooms"
          pathPrefix="/rooms"
          onNavigate={onViewChange}
          showBadge={totalMentionsCount > 0 || totalNotifiableUnreadCount > 0}
        />
        {/* Archive */}
        <IconRailNavLink
          icon={Archive}
          label={t('sidebar.archive')}
          view="archive"
          pathPrefix="/archive"
          onNavigate={onViewChange}
        />
        <IconRailNavLink
          icon={Users}
          label={t('sidebar.connections')}
          view="directory"
          pathPrefix="/contacts"
          onNavigate={onViewChange}
        />
        {/* Events/Notifications */}
        <IconRailNavLink
          icon={Bell}
          label={t('sidebar.events')}
          view="events"
          pathPrefix="/events"
          onNavigate={onViewChange}
          showBadge={pendingCount > 0}
        />
        {/* Search */}
        <IconRailNavLink
          icon={Search}
          label={t('sidebar.search', 'Search')}
          view="search"
          pathPrefix="/search"
          onNavigate={onViewChange}
        />
        <div className="flex-1" />
        {/* Admin - only visible for server administrators */}
        {isAdmin && (
          <IconRailNavLink
            icon={Wrench}
            label={t('sidebar.admin')}
            view="admin"
            pathPrefix="/admin"
            onNavigate={onViewChange}
          />
        )}
        {/* Settings - now a regular view like others */}
        <IconRailNavLink
          icon={Settings}
          label={t('sidebar.settings')}
          view="settings"
          pathPrefix="/settings"
          onNavigate={onViewChange}
        />
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header - with drag region for window movement */}
        <div className={`h-14 ${titleBarClass} px-4 flex items-center border-b border-fluux-bg shadow-sm`} {...dragRegionProps}>
          <h1 className="flex-1 font-semibold text-fluux-text truncate">
            {sidebarView === 'messages' ? t('sidebar.messages')
              : sidebarView === 'rooms' ? t('sidebar.rooms')
              : sidebarView === 'directory' ? t('sidebar.connections')
              : sidebarView === 'archive' ? t('sidebar.archive')
              : sidebarView === 'admin' ? t('sidebar.admin')
              : sidebarView === 'settings' ? t('sidebar.settings')
              : sidebarView === 'search' ? t('sidebar.search', 'Search')
              : t('sidebar.events')}
          </h1>
          {sidebarView === 'directory' && (
            <div className="relative ms-auto" ref={contactDropdownRef}>
              <Tooltip content={t('common.options')} position="bottom">
                <button
                  onClick={() => setShowContactDropdown(!showContactDropdown)}
                  className="p-1 text-fluux-muted hover:text-fluux-text flex items-center"
                >
                  <Users className="w-5 h-5" />
                  <ChevronDown className="w-3 h-3 -ms-0.5" />
                </button>
              </Tooltip>
              {showContactDropdown && (
                <div className="absolute end-0 mt-1 w-52 bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50">
                  <button
                    onClick={() => { setShowContactDropdown(false); modalActions.open('addContact') }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <UserPlus className="w-4 h-4 text-fluux-muted" />
                    <span>{t('sidebar.addContact')}</span>
                  </button>
                  <div className="border-t border-fluux-hover my-1" />
                  <button
                    onClick={() => { setShowContactDropdown(false); navigateToSettings('blocked') }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Ban className="w-4 h-4 text-fluux-muted" />
                    <span>{t('sidebar.blockedUsers')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {sidebarView === 'rooms' && (
            <div className="relative ms-auto" ref={roomDropdownRef}>
              <Tooltip content={t('sidebar.joinRoom')} position="bottom">
                <button
                  onClick={() => setShowRoomDropdown(!showRoomDropdown)}
                  className="p-1 text-fluux-muted hover:text-fluux-text flex items-center"
                >
                  <Plus className="w-5 h-5" />
                  <ChevronDown className="w-3 h-3 -ms-0.5" />
                </button>
              </Tooltip>
              {showRoomDropdown && (
                <div className="absolute end-0 mt-1 w-52 bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50">
                  <button
                    onClick={() => { setShowRoomDropdown(false); modalActions.open('quickChat') }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Zap className="w-4 h-4 text-amber-500" />
                    <span>{t('rooms.quickChat')}</span>
                  </button>
                  <button
                    onClick={() => { setShowRoomDropdown(false); setShowCreateRoom(true) }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Hash className="w-4 h-4 text-fluux-muted" />
                    <span>{t('rooms.permanentRoom')}</span>
                  </button>
                  <div className="border-t border-fluux-hover my-1" />
                  <button
                    onClick={() => { setShowRoomDropdown(false); setShowJoinRoom(true) }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <LogIn className="w-4 h-4 text-fluux-muted" />
                    <span>{t('rooms.joinRoom')}</span>
                  </button>
                  <button
                    onClick={() => { setShowRoomDropdown(false); setShowBrowseRooms(true) }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Search className="w-4 h-4 text-fluux-muted" />
                    <span>{t('rooms.browseRooms')}</span>
                  </button>
                  <div className="border-t border-fluux-hover my-1" />
                  <button
                    onClick={() => {
                      setShowRoomDropdown(false)
                      if (isCatchingUpRooms) return
                      setIsCatchingUpRooms(true)
                      void client.mam.forceCatchUpAllRooms().finally(() => setIsCatchingUpRooms(false))
                    }}
                    disabled={isCatchingUpRooms}
                    className={`w-full px-3 py-2 text-start text-sm flex items-center gap-2 ${
                      isCatchingUpRooms ? 'text-fluux-muted cursor-wait' : 'hover:bg-fluux-hover'
                    }`}
                  >
                    <RefreshCw className={`w-4 h-4 text-fluux-muted ${isCatchingUpRooms ? 'animate-spin' : ''}`} />
                    <span>{t('rooms.catchUpAll')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Content — outer div carries focus ring, inner div scrolls */}
        <div
          ref={sidebarListRef}
          tabIndex={0}
          className="focus-zone flex-1 min-h-0 p-0.5"
        >
          <div className="sidebar-scroll h-full overflow-y-auto rounded-sm py-0.5 px-0.5">
            <SidebarZoneContext.Provider value={sidebarListRef}>
              <div key={sidebarView} style={{ animation: 'sidebar-view-enter 150ms ease-out' }}>
              {sidebarView === 'messages' ? (
                <ConversationList />
              ) : sidebarView === 'directory' ? (
                <ContactList onStartChat={onStartChat} onSelectContact={onSelectContact} onManageUser={onManageUser} activeContactJid={activeContactJid} />
              ) : sidebarView === 'rooms' ? (
                <RoomsList />
              ) : sidebarView === 'archive' ? (
                <ArchiveList />
              ) : sidebarView === 'admin' ? (
                <AdminDashboard
                  activeCategory={adminCategory ?? null}
                  onCategoryChange={onAdminCategoryChange ?? (() => {})}
                />
              ) : sidebarView === 'search' ? (
                <SearchView />
              ) : sidebarView === 'settings' ? (
                <SettingsSidebar
                  activeCategory={(settingsCategory as SettingsCategory) || DEFAULT_SETTINGS_CATEGORY}
                  onCategoryChange={(category) => navigateToSettings(category)}
                />
              ) : (
                <>
                  <EventsView />
                  <ActivityLogView />
                </>
              )}
              </div>
            </SidebarZoneContext.Provider>
          </div>
        </div>

        {/* User Panel - avatar spans both rows */}
        <div className="px-2 py-2 bg-fluux-sidebar border-t border-fluux-bg">
          <div className="flex items-center gap-3 min-w-0">
            {/* Large avatar - clickable for profile settings */}
            <Tooltip content={t('sidebar.viewProfile')} position="top">
              <div
                onClick={() => { modalActions.close('presenceMenu'); navigateToSettings('profile') }}
                className="flex-shrink-0 rounded-full hover:ring-2 hover:ring-fluux-muted/30 transition-all cursor-pointer"
              >
                <Avatar
                  identifier={jid || ''}
                  name={ownNickname || jid?.split('@')[0]}
                  avatarUrl={ownAvatar || undefined}
                  size="lg"
                  fallbackColor="var(--fluux-bg-accent)"
                />
              </div>
            </Tooltip>
            {/* Name and status stacked vertically */}
            <div className="flex-1 min-w-0 space-y-0.5">
              <Tooltip content={t('sidebar.viewProfile')} position="top">
                <p
                  onClick={() => { modalActions.close('presenceMenu'); navigateToSettings('profile') }}
                  className="text-sm font-medium text-fluux-text truncate cursor-pointer hover:underline"
                >
                  {ownNickname || jid?.split('@')[0]}
                </p>
              </Tooltip>
              {status === 'online' && !showVerifying ? (
                <PresenceSelector isOpen={showPresenceMenu} onOpenChange={(open) => open ? modalActions.open('presenceMenu') : modalActions.close('presenceMenu')} />
              ) : (
                <StatusDisplay status={showVerifying ? 'verifying' : status} reconnectTargetTime={reconnectTargetTime} reconnectAttempt={reconnectAttempt} />
              )}
            </div>
            {/* Menu button */}
            {status === 'reconnecting' ? (
              <Tooltip content={t('status.cancelReconnection')} position="top">
                <button
                  onClick={cancelReconnect}
                  className="p-2 text-fluux-muted hover:text-fluux-red rounded hover:bg-fluux-hover flex-shrink-0"
                >
                  <X className="w-4 h-4" />
                </button>
              </Tooltip>
            ) : (
              <UserMenu onLogout={async (shouldCleanLocalData) => {
                // Always attempt disconnect first.
                const disconnectSettled = await Promise.race([
                  disconnect().then(() => 'done' as const).catch(() => 'error' as const),
                  new Promise<'timeout'>((resolve) => {
                    setTimeout(() => resolve('timeout'), LOGOUT_DISCONNECT_TIMEOUT_MS)
                  }),
                ])
                if (disconnectSettled === 'timeout') {
                  console.warn(
                    `[Fluux] Logout: disconnect timed out after ${LOGOUT_DISCONNECT_TIMEOUT_MS}ms, continuing cleanup`
                  )
                }

                // Clear persisted session immediately so the UI can leave ChatLayout
                // even if OS keychain or storage cleanup stalls on this platform.
                clearSession()

                if (shouldCleanLocalData) {
                  // clearLocalData() clears session at the end of cleanup.
                  await clearLocalData().catch(() => {})
                } else {
                  // Reset connection store so App re-renders and routes to LoginScreen.
                  // (clearLocalData already resets stores in the clean path.)
                  connectionStore.getState().reset()

                  const keychainSettled = await Promise.race([
                    deleteCredentials().then(() => 'done' as const).catch(() => 'error' as const),
                    new Promise<'timeout'>((resolve) => {
                      setTimeout(() => resolve('timeout'), LOGOUT_KEYCHAIN_TIMEOUT_MS)
                    }),
                  ])
                  if (keychainSettled === 'timeout') {
                    console.warn(
                      `[Fluux] Logout: keychain cleanup timed out after ${LOGOUT_KEYCHAIN_TIMEOUT_MS}ms`
                    )
                  }
                }
              }} />
            )}
          </div>
        </div>
      </div>

      {/* Resize Handle - desktop only */}
      <Tooltip content={t('sidebar.resizeHint')} position="right" delay={800}>
        <div
          onMouseDown={handleMouseDown}
          onDoubleClick={handleDoubleClick}
          onMouseEnter={() => setIsResizeHover(true)}
          onMouseLeave={() => setIsResizeHover(false)}
          style={{ cursor: 'ew-resize' }}
          className={`hidden md:block absolute top-0 end-0 w-1 h-full z-50 transition-colors
                      ${isResizing ? 'bg-fluux-brand/40' : isResizeHover ? 'bg-fluux-brand/20' : ''}`}
        />
      </Tooltip>

      {/* Add Contact Modal */}
      {showAddContact && (
        <AddContactModal onClose={() => modalActions.close('addContact')} />
      )}

      {/* Create Room Modal */}
      {showCreateRoom && (
        <CreateRoomModal onClose={() => setShowCreateRoom(false)} />
      )}

      {/* Quick Chat Modal */}
      {showQuickChat && (
        <CreateQuickChatModal onClose={() => modalActions.close('quickChat')} />
      )}

      {/* Join Room Modal */}
      {showJoinRoom && (
        <JoinRoomModal onClose={() => setShowJoinRoom(false)} />
      )}

      {/* Browse Rooms Modal */}
      {showBrowseRooms && (
        <BrowseRoomsModal onClose={() => setShowBrowseRooms(false)} />
      )}
    </aside>
  )
}
