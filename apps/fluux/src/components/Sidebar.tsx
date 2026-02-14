import React, { useState, useRef, useEffect, useCallback, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { useClickOutside, useWindowDrag, useRouteSync } from '@/hooks'
import { useModals } from '@/contexts'
import {
  useXMPP,
  useEvents,
  useAdmin,
  type Contact,
  type AdminCategory,
} from '@fluux/sdk'
import { useConnectionStore, useChatStore, useRoomStore } from '@fluux/sdk/react'
import { AdminDashboard } from './AdminDashboard'
import { BrowseRoomsModal } from './BrowseRoomsModal'
import { Avatar } from './Avatar'
import { Tooltip } from './Tooltip'
import { AddContactModal } from './AddContactModal'
import { JoinRoomModal } from './JoinRoomModal'
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
  UserMenu,
} from './sidebar-components'

// Re-export SidebarView for external use
export type { SidebarView }

interface SidebarProps {
  onSelectContact?: (contact: Contact) => void
  onStartChat?: (contact: Contact) => void
  onManageUser?: (jid: string) => void
  adminCategory?: AdminCategory | null
  onAdminCategoryChange?: (category: AdminCategory | null) => void
  // Focus zone ref for Tab cycling
  sidebarListRef?: RefObject<HTMLDivElement>
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
  const reconnectAttempt = useConnectionStore((s) => s.reconnectAttempt)
  const reconnectIn = useConnectionStore((s) => s.reconnectIn)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  // Get methods from client (not from store)
  const { client } = useXMPP()
  const disconnect = useCallback(() => client.disconnect(), [client])
  const cancelReconnect = useCallback(() => client.cancelReconnect(), [client])
  const { isAdmin } = useAdmin()
  // Use targeted store selectors instead of useChat()/useRoom() to avoid render loops.
  // Those hooks subscribe to many store properties (conversations array, messages, etc.)
  // which create new references during the post-connection initialization burst.
  const totalUnread = useChatStore((s) => {
    let sum = 0
    for (const conv of s.conversations.values()) sum += conv.unreadCount
    return sum
  })
  const { pendingCount } = useEvents()
  const totalMentionsCount = useRoomStore((s) => s.totalMentionsCount())
  const totalNotifiableUnreadCount = useRoomStore((s) => s.totalNotifiableUnreadCount())
  const { titleBarClass, dragRegionProps } = useWindowDrag()

  // Modal state from context - shared with ChatLayout
  const { state: modalState, actions: modalActions } = useModals()
  const showQuickChat = modalState.quickChat
  const showAddContact = modalState.addContact
  const showPresenceMenu = modalState.presenceMenu

  // Local UI state (not shared)
  const [showJoinRoom, setShowJoinRoom] = useState(false)
  const [showBrowseRooms, setShowBrowseRooms] = useState(false)
  const [showRoomDropdown, setShowRoomDropdown] = useState(false)
  const roomDropdownRef = useRef<HTMLDivElement>(null)

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
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    setIsResizing(true)
  }, [])

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
  const handleDoubleClick = useCallback(() => {
    setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)
    localStorage.setItem(SIDEBAR_WIDTH_KEY, SIDEBAR_DEFAULT_WIDTH.toString())
  }, [])

  // Close room dropdown when clicking outside
  const closeRoomDropdown = useCallback(() => setShowRoomDropdown(false), [])
  useClickOutside(roomDropdownRef, closeRoomDropdown, showRoomDropdown)

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
        <div className={`h-12 ${titleBarClass} px-4 flex items-center border-b border-fluux-bg shadow-sm`} {...dragRegionProps}>
          <h1 className="font-semibold text-fluux-text truncate">
            {sidebarView === 'messages' ? t('sidebar.messages')
              : sidebarView === 'rooms' ? t('sidebar.rooms')
              : sidebarView === 'directory' ? t('sidebar.connections')
              : sidebarView === 'archive' ? t('sidebar.archive')
              : sidebarView === 'admin' ? t('sidebar.admin')
              : sidebarView === 'settings' ? t('sidebar.settings')
              : t('sidebar.events')}
          </h1>
          {sidebarView === 'directory' && (
            <Tooltip content={t('sidebar.addContact')} position="bottom">
              <button
                onClick={() => modalActions.open('addContact')}
                className="ml-auto p-1 text-fluux-muted hover:text-fluux-text"
              >
                <Plus className="w-5 h-5" />
              </button>
            </Tooltip>
          )}
          {sidebarView === 'rooms' && (
            <div className="relative ml-auto" ref={roomDropdownRef}>
              <Tooltip content={t('sidebar.joinRoom')} position="bottom">
                <button
                  onClick={() => setShowRoomDropdown(!showRoomDropdown)}
                  className="p-1 text-fluux-muted hover:text-fluux-text flex items-center"
                >
                  <Plus className="w-5 h-5" />
                  <ChevronDown className="w-3 h-3 -ml-0.5" />
                </button>
              </Tooltip>
              {showRoomDropdown && (
                <div className="absolute right-0 mt-1 w-52 bg-fluux-bg rounded-lg shadow-xl border border-fluux-hover py-1 z-50">
                  <button
                    onClick={() => { setShowRoomDropdown(false); modalActions.open('quickChat') }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Zap className="w-4 h-4 text-amber-500" />
                    <span>{t('rooms.quickChat')}</span>
                  </button>
                  <div className="border-t border-fluux-hover my-1" />
                  <button
                    onClick={() => { setShowRoomDropdown(false); setShowJoinRoom(true) }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Hash className="w-4 h-4 text-fluux-muted" />
                    <span>{t('rooms.permanentRoom')}</span>
                  </button>
                  <button
                    onClick={() => { setShowRoomDropdown(false); setShowBrowseRooms(true) }}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Search className="w-4 h-4 text-fluux-muted" />
                    <span>{t('rooms.browseRooms')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Content */}
        <div
          ref={sidebarListRef}
          tabIndex={0}
          className="focus-zone flex-1 overflow-y-auto p-1"
        >
          <SidebarZoneContext.Provider value={sidebarListRef}>
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
            ) : sidebarView === 'settings' ? (
              <SettingsSidebar
                activeCategory={(settingsCategory as SettingsCategory) || DEFAULT_SETTINGS_CATEGORY}
                onCategoryChange={(category) => navigateToSettings(category)}
              />
            ) : (
              <EventsView />
            )}
          </SidebarZoneContext.Provider>
        </div>

        {/* User Panel - avatar spans both rows */}
        <div className="px-2 py-2 bg-fluux-sidebar border-t border-fluux-bg">
          <div className="flex items-center gap-3">
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
                  fallbackColor="#23a559"
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
              {status === 'online' ? (
                <PresenceSelector isOpen={showPresenceMenu} onOpenChange={(open) => open ? modalActions.open('presenceMenu') : modalActions.close('presenceMenu')} />
              ) : (
                <StatusDisplay status={status} reconnectIn={reconnectIn} reconnectAttempt={reconnectAttempt} />
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
                if (shouldCleanLocalData) {
                  await clearLocalData()
                } else {
                  clearSession()
                  await deleteCredentials()
                }
                disconnect()
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
          className={`hidden md:block absolute top-0 right-0 w-1 h-full z-50 transition-colors
                      ${isResizing ? 'bg-fluux-brand/40' : isResizeHover ? 'bg-fluux-brand/20' : ''}`}
        />
      </Tooltip>

      {/* Add Contact Modal */}
      {showAddContact && (
        <AddContactModal onClose={() => modalActions.close('addContact')} />
      )}

      {/* Join Room Modal */}
      {showJoinRoom && (
        <JoinRoomModal onClose={() => setShowJoinRoom(false)} />
      )}

      {/* Quick Chat Modal */}
      {showQuickChat && (
        <CreateQuickChatModal onClose={() => modalActions.close('quickChat')} />
      )}

      {/* Browse Rooms Modal */}
      {showBrowseRooms && (
        <BrowseRoomsModal onClose={() => setShowBrowseRooms(false)} />
      )}
    </aside>
  )
}
