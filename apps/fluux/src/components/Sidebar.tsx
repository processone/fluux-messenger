import React, { useState, useRef, useEffect, useCallback, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { detectRenderLoop, trackSelectorChange } from '@/utils/renderLoopDetector'
import { useClickOutside, useWindowDrag, useRouteSync, useFollowUnarchivedActive } from '@/hooks'
import { useModalStore } from '@/stores/modalStore'
import { useUpdateAffordance } from '@/stores/appUpdateStore'
import {
  useXMPP,
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
import { NewMessageModal } from './NewMessageModal'
import { SettingsSidebar, type SettingsCategory, DEFAULT_SETTINGS_CATEGORY } from './settings-components'
import {
  MessageCircle,
  Hash,
  ChevronDown,
  Settings,
  Plus,
  Users,
  Archive,
  Server,
  Zap,
  Search,
  LogIn,
  Ban,
  UserPlus,
  RefreshCw,
  CircleArrowUp,
} from 'lucide-react'
import { performLogout } from '@/utils/performLogout'

// Import extracted sidebar components
import {
  type SidebarView,
  SidebarZoneContext,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_WIDTH_KEY,
  IconRailNavLink,
  IconRailButton,
  StatusOrPresence,
  ConversationList,
  ArchiveList,
  ContactList,
  RoomsList,
  SearchView,
  UserMenu,
} from './sidebar-components'

// Re-export SidebarView for external use
export type { SidebarView }

interface SidebarProps {
  onSelectContact?: (contact: Contact) => void
  onStartChat?: (contact: Contact) => void
  onStartChatWithJid?: (jid: string) => void
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

export function Sidebar({ onSelectContact, onStartChat, onStartChatWithJid, onManageUser, adminCategory, onAdminCategoryChange, sidebarListRef, activeContactJid, onViewChange }: SidebarProps) {
  detectRenderLoop('Sidebar')
  const { t } = useTranslation()
  // Get current view from URL
  const { sidebarView, settingsCategory, navigateToSettings, navigateToContacts } = useRouteSync()
  // Use focused selectors instead of useConnection() to avoid re-renders when unrelated values change
  // (e.g., ownResources updates shouldn't re-render the entire sidebar)
  const jid = useConnectionStore((s) => s.jid)
  const ownAvatar = useConnectionStore((s) => s.ownAvatar)
  const ownNickname = useConnectionStore((s) => s.ownNickname)
  // Get methods from client (not from store)
  const { client } = useXMPP()
  const disconnect = (options?: { invalidateFastToken?: boolean }) =>
    client.disconnect(options)
  const isAdmin = useAdminStore((s) => s.isAdmin)
  // Use targeted store selectors instead of useChat()/useRoom() to avoid render loops.
  // Those hooks subscribe to many store properties (conversations array, messages, etc.)
  // which create new references during the post-connection initialization burst.
  const totalUnread = useChatStore((s) => {
    let sum = 0
    for (const meta of s.conversationMeta.values()) sum += meta.unreadCount
    return sum
  })
  const pendingRequestCount = useEventsStore((s) => s.subscriptionRequests.length)
  const roomTabTone = useRoomStore((s) => s.roomTabIndicator())

  // Diagnostic: track every selector value per render. Dev-only (guarded inside
  // trackSelectorChange). Helps pinpoint unstable selectors causing render loops.
  trackSelectorChange('Sidebar', 'jid', jid)
  trackSelectorChange('Sidebar', 'ownAvatar', ownAvatar)
  trackSelectorChange('Sidebar', 'ownNickname', ownNickname)
  trackSelectorChange('Sidebar', 'isAdmin', isAdmin)
  trackSelectorChange('Sidebar', 'totalUnread', totalUnread)
  trackSelectorChange('Sidebar', 'roomTabTone', roomTabTone)
  const { dragRegionProps } = useWindowDrag()

  // Per-modal subscriptions: the Sidebar owns these three modals and re-renders
  // only when one of THEM toggles, not when ChatLayout's modals (command palette,
  // shortcut help) open/close. Actions are stable store methods.
  const showQuickChat = useModalStore((s) => s.quickChat)
  const showAddContact = useModalStore((s) => s.addContact)
  const showNewMessage = useModalStore((s) => s.newMessage)
  const showPresenceMenu = useModalStore((s) => s.presenceMenu)
  const modalOpen = useModalStore((s) => s.open)
  const modalClose = useModalStore((s) => s.close)

  // Cross-platform "an update is available" affordance (web PWA reload / desktop
  // update modal). Hidden unless an update is actually ready.
  const { visible: updateAvailable, activate: activateUpdate } = useUpdateAffordance()

  // Archive toggle state — reset when leaving messages view
  const [showArchived, setShowArchived] = useState(false)
  useEffect(() => {
    if (sidebarView !== 'messages') setShowArchived(false)
  }, [sidebarView])

  // When the conversation you're viewing gets unarchived (by writing in it or
  // receiving a message), return to the active list so it stays in context
  // instead of vanishing from the filtered archive list.
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const isActiveArchived = useChatStore(
    (s) => s.activeConversationId != null && s.archivedConversations.has(s.activeConversationId),
  )
  const showActiveList = useCallback(() => setShowArchived(false), [])
  useFollowUnarchivedActive({ activeConversationId, isActiveArchived, showArchived, onShowActive: showActiveList })

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
      className="relative bg-fluux-sidebar chrome-sidebar flex select-none flex-shrink-0"
      style={{ width: isDesktop ? sidebarWidth : '100%' }}
    >
      {/* Icon Rail — top clearance is now provided by the desktop AppBar
          (which hosts the macOS traffic lights), so the rail just needs a small
          top padding rather than the old traffic-light gap. */}
      <div className="icon-rail flex flex-col items-center pt-3 pb-safe-3 gap-2">
        {/* Fluux logo - enable with VITE_SHOW_LOGO=true */}
        {import.meta.env.VITE_SHOW_LOGO === 'true' && (
          <img
            src="/logo.png"
            alt="Fluux"
            className="size-7 mb-2 opacity-80"
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
          tone="strong"
        />
        <IconRailNavLink
          icon={Hash}
          label={t('sidebar.rooms')}
          view="rooms"
          pathPrefix="/rooms"
          onNavigate={onViewChange}
          showBadge={roomTabTone !== 'none'}
          tone={roomTabTone === 'accent' ? 'accent' : 'neutral'}
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
        {/* Update available — user-triggered (web reload / desktop update modal) */}
        {updateAvailable && (
          <IconRailButton
            icon={CircleArrowUp}
            label={t('sidebar.updateAvailable')}
            active={false}
            accent
            onClick={activateUpdate}
          />
        )}
        {/* Contacts - relocated to bottom cluster; badge shows pending subscription requests */}
        <IconRailNavLink
          icon={Users}
          label={t('sidebar.contacts')}
          view="directory"
          pathPrefix="/contacts"
          onNavigate={onViewChange}
          badgeCount={pendingRequestCount}
          badgeLabel={pendingRequestCount > 0 ? `${t('sidebar.contacts')} (${pendingRequestCount})` : undefined}
        />
        {/* Admin - only visible for server administrators */}
        {isAdmin && (
          <IconRailNavLink
            icon={Server}
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
        <div className="h-14 px-4 flex items-center border-b border-fluux-bg shadow-sm" {...dragRegionProps}>
          <h1 className="flex-1 font-semibold text-fluux-text truncate">
            {sidebarView === 'messages' ? (showArchived ? t('messages.archivedTitle') : t('sidebar.messages'))
              : sidebarView === 'rooms' ? t('sidebar.rooms')
              : sidebarView === 'directory' ? t('sidebar.contacts')
              : sidebarView === 'admin' ? t('sidebar.admin')
              : sidebarView === 'settings' ? t('sidebar.settings')
              : t('sidebar.search', 'Search')}
          </h1>
          {sidebarView === 'directory' && (
            <div className="relative ms-auto" ref={contactDropdownRef}>
              <Tooltip content={t('common.options')} position="bottom">
                <button
                  onClick={() => setShowContactDropdown(!showContactDropdown)}
                  className="p-1 text-fluux-muted hover:text-fluux-text flex items-center"
                >
                  <Users className="size-5" />
                  <ChevronDown className="size-3 -ms-0.5" />
                </button>
              </Tooltip>
              {showContactDropdown && (
                <div className="absolute end-0 mt-1 w-52 fluux-popover rounded-lg py-1 z-50">
                  <button
                    onClick={() => { setShowContactDropdown(false); modalOpen('addContact') }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <UserPlus className="size-4 text-fluux-muted" />
                    <span>{t('sidebar.addContact')}</span>
                  </button>
                  <div className="border-t border-fluux-hover my-1" />
                  <button
                    onClick={() => { setShowContactDropdown(false); navigateToSettings('blocked') }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Ban className="size-4 text-fluux-muted" />
                    <span>{t('sidebar.blockedUsers')}</span>
                  </button>
                </div>
              )}
            </div>
          )}
          {sidebarView === 'messages' && (
            <>
              <Tooltip content={showArchived ? t('messages.showActive') : t('messages.showArchived')} position="bottom">
                <button
                  type="button"
                  onClick={() => setShowArchived((v) => !v)}
                  aria-label={showArchived ? t('messages.showActive') : t('messages.showArchived')}
                  className={`p-1 flex items-center ${showArchived ? 'text-fluux-brand' : 'text-fluux-muted hover:text-fluux-text'}`}
                >
                  <Archive className="size-5" />
                </button>
              </Tooltip>
              <Tooltip content={t('newMessage.title')} position="bottom">
                <button
                  type="button"
                  onClick={() => modalOpen('newMessage')}
                  aria-label={t('newMessage.title')}
                  className="ms-auto p-1 text-fluux-muted hover:text-fluux-text flex items-center"
                >
                  <Plus className="size-5" />
                </button>
              </Tooltip>
            </>
          )}
          {sidebarView === 'rooms' && (
            <div className="relative ms-auto" ref={roomDropdownRef}>
              <Tooltip content={t('sidebar.joinRoom')} position="bottom">
                <button
                  onClick={() => setShowRoomDropdown(!showRoomDropdown)}
                  className="p-1 text-fluux-muted hover:text-fluux-text flex items-center"
                >
                  <Plus className="size-5" />
                  <ChevronDown className="size-3 -ms-0.5" />
                </button>
              </Tooltip>
              {showRoomDropdown && (
                <div className="absolute end-0 mt-1 w-52 fluux-popover rounded-lg py-1 z-50">
                  <button
                    onClick={() => { setShowRoomDropdown(false); modalOpen('quickChat') }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Zap className="size-4 text-amber-500" />
                    <span>{t('rooms.quickChat')}</span>
                  </button>
                  <button
                    onClick={() => { setShowRoomDropdown(false); setShowCreateRoom(true) }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Hash className="size-4 text-fluux-muted" />
                    <span>{t('rooms.permanentRoom')}</span>
                  </button>
                  <div className="border-t border-fluux-hover my-1" />
                  <button
                    onClick={() => { setShowRoomDropdown(false); setShowJoinRoom(true) }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <LogIn className="size-4 text-fluux-muted" />
                    <span>{t('rooms.joinRoom')}</span>
                  </button>
                  <button
                    onClick={() => { setShowRoomDropdown(false); setShowBrowseRooms(true) }}
                    className="w-full px-3 py-2 text-start text-sm hover:bg-fluux-hover flex items-center gap-2"
                  >
                    <Search className="size-4 text-fluux-muted" />
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
                    <RefreshCw className={`size-4 text-fluux-muted ${isCatchingUpRooms ? 'animate-spin' : ''}`} />
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
              <div key={sidebarView} className="h-full md:h-auto" style={{ animation: 'sidebar-view-enter var(--fluux-duration-fast) var(--fluux-ease-standard)' }}>
              {sidebarView === 'messages' ? (
                showArchived ? <ArchiveList /> : <ConversationList />
              ) : sidebarView === 'directory' ? (
                <ContactList onStartChat={onStartChat} onSelectContact={onSelectContact} onManageUser={onManageUser} activeContactJid={activeContactJid} />
              ) : sidebarView === 'rooms' ? (
                <RoomsList />
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
              ) : null}
              </div>
            </SidebarZoneContext.Provider>
          </div>
        </div>

        {/* User Panel - avatar spans both rows */}
        <div className="px-2 pt-2 pb-safe-2 bg-fluux-sidebar border-t border-fluux-bg">
          <div className="flex items-center gap-2 min-w-0">
            {/* Large avatar - clickable for profile settings */}
            <Tooltip content={t('sidebar.viewProfile')} position="top">
              <div
                role="button"
                tabIndex={0}
                onClick={() => { modalClose('presenceMenu'); navigateToSettings('profile') }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); modalClose('presenceMenu'); navigateToSettings('profile') } }}
                className="flex-shrink-0 me-1 rounded-full hover:ring-2 hover:ring-fluux-muted/30 transition-all cursor-pointer"
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
                <button
                  type="button"
                  onClick={() => { modalClose('presenceMenu'); navigateToSettings('profile') }}
                  className="block w-full text-start text-sm font-medium text-fluux-text truncate cursor-pointer hover:underline"
                >
                  {ownNickname || jid?.split('@')[0]}
                </button>
              </Tooltip>
              <StatusOrPresence isOpen={showPresenceMenu} onOpenChange={(open) => open ? modalOpen('presenceMenu') : modalClose('presenceMenu')} />
            </div>
            {/* Menu button — always available, including while reconnecting,
                so logout stays reachable. Cancelling the reconnection lives
                inline in the status line (StatusDisplay). */}
            <UserMenu onLogout={(shouldCleanLocalData) =>
              performLogout({ disconnect, jid, shouldCleanLocalData })
            } />
          </div>
        </div>
      </div>

      {/* Resize Handle - desktop only */}
      <Tooltip content={t('sidebar.resizeHint')} position="right" delay={800}>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-hidden="true"
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
        <AddContactModal onClose={() => modalClose('addContact')} />
      )}

      {/* New Message Modal */}
      {showNewMessage && (
        <NewMessageModal
          onClose={() => modalClose('newMessage')}
          onPick={(jid) => onStartChatWithJid?.(jid)}
          onAddContact={() => { modalClose('newMessage'); modalOpen('addContact') }}
          onManageContacts={() => navigateToContacts()}
        />
      )}

      {/* Create Room Modal */}
      {showCreateRoom && (
        <CreateRoomModal onClose={() => setShowCreateRoom(false)} />
      )}

      {/* Quick Chat Modal */}
      {showQuickChat && (
        <CreateQuickChatModal onClose={() => modalClose('quickChat')} />
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
