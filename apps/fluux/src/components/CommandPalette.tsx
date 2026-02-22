import { useState, useEffect, useLayoutEffect, useRef, useMemo, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MessageSquare,
  Hash,
  User,
  Plus,
  Settings,
  HelpCircle,
  Terminal,
  Archive,
  Bell,
  Users,
  Search,
} from 'lucide-react'
import { useChat, useRoom, useRoster, matchNameOrJid, getLocalPart } from '@fluux/sdk'
import { useChatStore, useConnectionStore } from '@fluux/sdk/react'
import type { PresenceStatus } from '@fluux/sdk'
import type { SidebarView } from './Sidebar'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '@/constants/ui'

// =============================================================================
// Types
// =============================================================================

type ItemType = 'conversation' | 'room' | 'contact' | 'action' | 'view'
type FilterMode = 'all' | 'commands' | 'contacts' | 'rooms'

interface CommandItem {
  id: string
  type: ItemType
  label: string
  sublabel?: string
  icon: React.ReactNode
  action: () => void
  keywords?: string[]
  presence?: PresenceStatus
}

interface ItemGroup {
  type: ItemType
  label: string
  items: CommandItem[]
}

interface CommandPaletteProps {
  isOpen: boolean
  onClose: () => void
  onSidebarViewChange: (view: SidebarView) => void
  onOpenSettings: () => void
  onToggleConsole: () => void
  onToggleShortcutHelp: () => void
  onCreateQuickChat: () => void
  onAddContact: () => void
  onStartConversation: (jid: string) => void
}

// =============================================================================
// Helper: Parse query for filter prefix
// =============================================================================

function parseQuery(query: string): { filterMode: FilterMode; searchQuery: string } {
  const trimmed = query.trim()
  if (trimmed.startsWith('>')) {
    return { filterMode: 'commands', searchQuery: trimmed.slice(1).trim().toLowerCase() }
  }
  if (trimmed.startsWith('@')) {
    return { filterMode: 'contacts', searchQuery: trimmed.slice(1).trim().toLowerCase() }
  }
  if (trimmed.startsWith('#')) {
    return { filterMode: 'rooms', searchQuery: trimmed.slice(1).trim().toLowerCase() }
  }
  return { filterMode: 'all', searchQuery: trimmed.toLowerCase() }
}

// =============================================================================
// Helper: Check if item matches search query
// =============================================================================

function itemMatchesQuery(item: CommandItem, searchQuery: string): boolean {
  // Check keywords
  if (item.keywords?.some((k) => k.toLowerCase().includes(searchQuery))) {
    return true
  }

  // For JID-based items, match name or username (not domain)
  if (['conversation', 'room', 'contact'].includes(item.type) && item.sublabel) {
    return matchNameOrJid(item.label, item.sublabel, searchQuery)
  }

  // For other items, match label
  return item.label.toLowerCase().includes(searchQuery)
}

// =============================================================================
// Helper: Filter items by type for a given filter mode
// =============================================================================

function getTypesForMode(mode: FilterMode): ItemType[] {
  switch (mode) {
    case 'commands':
      return ['action', 'view']
    case 'contacts':
      return ['conversation', 'contact']
    case 'rooms':
      return ['room']
    default:
      return ['conversation', 'contact', 'room', 'action', 'view']
  }
}

// =============================================================================
// Helper: Group items by type in display order
// =============================================================================

function groupItemsByType(items: CommandItem[], t: (key: string) => string): ItemGroup[] {
  const groups: ItemGroup[] = []
  const typeOrder: { type: ItemType; labelKey: string }[] = [
    { type: 'conversation', labelKey: 'sidebar.messages' },
    { type: 'room', labelKey: 'sidebar.rooms' },
    { type: 'contact', labelKey: 'sidebar.connections' },
    { type: 'view', labelKey: 'commandPalette.views' },
    { type: 'action', labelKey: 'commandPalette.actions' },
  ]

  for (const { type, labelKey } of typeOrder) {
    const typeItems = items.filter((i) => i.type === type)
    if (typeItems.length > 0) {
      groups.push({ type, label: t(labelKey), items: typeItems })
    }
  }

  return groups
}

// =============================================================================
// Component
// =============================================================================

export function CommandPalette({
  isOpen,
  onClose,
  onSidebarViewChange,
  onOpenSettings,
  onToggleConsole,
  onToggleShortcutHelp,
  onCreateQuickChat,
  onAddContact,
  onStartConversation,
}: CommandPaletteProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0) // Ref for synchronous access in event handlers
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const ignoreMouseRef = useRef(false)
  const [isKeyboardNav, setIsKeyboardNav] = useState(false) // Track keyboard navigation mode
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null) // Track mouse position to detect real movement

  // Wrapper to update both state and ref together
  const updateSelectedIndex = useCallback((indexOrFn: number | ((prev: number) => number)) => {
    setSelectedIndex((prev) => {
      const newIndex = typeof indexOrFn === 'function' ? indexOrFn(prev) : indexOrFn
      selectedIndexRef.current = newIndex
      return newIndex
    })
  }, [])

  // Data from stores
  const { conversations, archivedConversations, isArchived } = useChat()
  const { joinedRooms, bookmarkedRooms, setActiveRoom } = useRoom()
  const { contacts } = useRoster()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const { setActiveConversation } = useChatStore()

  // Stable callbacks that don't change between renders
  const closeAndNavigate = useCallback(
    (view: SidebarView) => {
      onSidebarViewChange(view)
      onClose()
    },
    [onSidebarViewChange, onClose]
  )

  const selectConversation = useCallback(
    (jid: string) => {
      // Navigate first, THEN set conversation - otherwise handleSidebarViewChange
      // will overwrite our selection with the "last conversation" restore logic
      // Archived conversations open in the archive tab
      const targetView = isArchived(jid) ? 'archive' : 'messages'
      closeAndNavigate(targetView)
      void setActiveConversation(jid)
      void setActiveRoom(null)
    },
    [setActiveConversation, setActiveRoom, closeAndNavigate, isArchived]
  )

  const selectRoom = useCallback(
    (jid: string) => {
      // Navigate first, THEN set room - otherwise handleSidebarViewChange
      // will overwrite our selection with the "last room" restore logic
      closeAndNavigate('rooms')
      void setActiveRoom(jid)
      void setActiveConversation(null)
    },
    [setActiveRoom, setActiveConversation, closeAndNavigate]
  )

  // =============================================================================
  // Build all command items
  // =============================================================================

  const allItems = useMemo((): CommandItem[] => {
    const items: CommandItem[] = []
    const conversationJids = new Set(conversations.map((c) => c.id))

    // 1. Conversations (contacts with active chats, sorted by recency)
    for (const conv of conversations) {
      if (conv.type !== 'chat') continue
      const contact = contacts.find((c) => c.jid === conv.id)
      items.push({
        id: `conv-${conv.id}`,
        type: 'conversation',
        label: contact?.name || conv.name,
        sublabel: conv.id,
        icon: <MessageSquare className="w-4 h-4" />,
        action: () => selectConversation(conv.id),
        keywords: [getLocalPart(conv.id), 'message', 'chat'],
        presence: contact?.presence ?? 'offline',
      })
    }

    // 2. Contacts without active conversations (alphabetically)
    // Note: contacts may have archived conversations
    const archivedJids = new Set(archivedConversations.map((c) => c.id))
    const otherContacts = contacts
      .filter((c) => !conversationJids.has(c.jid))
      .sort((a, b) => a.name.localeCompare(b.name))

    for (const contact of otherContacts) {
      const hasArchivedConversation = archivedJids.has(contact.jid)
      items.push({
        id: `contact-${contact.jid}`,
        type: 'contact',
        label: contact.name,
        sublabel: contact.jid,
        icon: <User className="w-4 h-4" />,
        action: () => {
          if (hasArchivedConversation) {
            // Open existing archived conversation in archive view
            selectConversation(contact.jid)
          } else {
            // Start new conversation
            onStartConversation(contact.jid)
            onClose()
          }
        },
        keywords: [getLocalPart(contact.jid), 'contact', 'roster'],
        presence: contact.presence,
      })
    }

    // 3. Joined rooms
    for (const room of joinedRooms) {
      items.push({
        id: `room-${room.jid}`,
        type: 'room',
        label: room.name || room.jid.split('@')[0],
        sublabel: room.jid,
        icon: <Hash className="w-4 h-4" />,
        action: () => selectRoom(room.jid),
        keywords: [getLocalPart(room.jid), 'room', 'muc', 'group'],
      })
    }

    // 4. Bookmarked but not joined rooms
    for (const room of bookmarkedRooms.filter((r) => !r.joined)) {
      items.push({
        id: `bookmark-${room.jid}`,
        type: 'room',
        label: room.name || room.jid.split('@')[0],
        sublabel: `${room.jid} (${t('rooms.bookmarked')})`,
        icon: <Hash className="w-4 h-4 opacity-50" />,
        action: () => selectRoom(room.jid),
        keywords: [getLocalPart(room.jid), 'room', 'bookmark'],
      })
    }

    // 5. Views (navigation)
    const views: Array<{ id: string; label: string; icon: React.ReactNode; view: SidebarView; keywords: string[] }> = [
      { id: 'view-messages', label: t('sidebar.messages'), icon: <MessageSquare className="w-4 h-4" />, view: 'messages', keywords: ['messages', 'conversations', 'chat'] },
      { id: 'view-rooms', label: t('sidebar.rooms'), icon: <Hash className="w-4 h-4" />, view: 'rooms', keywords: ['rooms', 'channels', 'muc'] },
      { id: 'view-connections', label: t('sidebar.connections'), icon: <Users className="w-4 h-4" />, view: 'directory', keywords: ['connections', 'contacts', 'roster'] },
      { id: 'view-archive', label: t('sidebar.archive'), icon: <Archive className="w-4 h-4" />, view: 'archive', keywords: ['archive', 'hidden', 'old'] },
      { id: 'view-events', label: t('sidebar.events'), icon: <Bell className="w-4 h-4" />, view: 'events', keywords: ['events', 'notifications', 'requests'] },
    ]

    for (const v of views) {
      items.push({
        id: v.id,
        type: 'view',
        label: v.label,
        icon: v.icon,
        action: () => closeAndNavigate(v.view),
        keywords: v.keywords,
      })
    }

    // 6. Actions
    const actions: Array<{ id: string; label: string; icon: React.ReactNode; action: () => void; keywords: string[] }> = [
      { id: 'action-quick-chat', label: t('rooms.createQuickChat'), icon: <Plus className="w-4 h-4" />, action: () => { onCreateQuickChat(); onClose() }, keywords: ['new', 'create', 'quick', 'chat'] },
      { id: 'action-add-contact', label: t('contacts.addContact'), icon: <Plus className="w-4 h-4" />, action: () => { onAddContact(); onClose() }, keywords: ['new', 'add', 'contact', 'friend'] },
      { id: 'action-join-room', label: t('rooms.joinRoom'), icon: <Plus className="w-4 h-4" />, action: () => closeAndNavigate('rooms'), keywords: ['join', 'room', 'muc'] },
      { id: 'action-settings', label: t('sidebar.settings'), icon: <Settings className="w-4 h-4" />, action: () => { onOpenSettings(); onClose() }, keywords: ['settings', 'preferences', 'options'] },
      { id: 'action-shortcuts', label: t('shortcuts.title'), icon: <HelpCircle className="w-4 h-4" />, action: () => { onToggleShortcutHelp(); onClose() }, keywords: ['shortcuts', 'keyboard', 'help'] },
      { id: 'action-console', label: t('console.title'), icon: <Terminal className="w-4 h-4" />, action: () => { onToggleConsole(); onClose() }, keywords: ['console', 'xmpp', 'debug'] },
    ]

    for (const a of actions) {
      items.push({
        id: a.id,
        type: 'action',
        label: a.label,
        icon: a.icon,
        action: a.action,
        keywords: a.keywords,
      })
    }

    return items
  }, [
    conversations,
    contacts,
    joinedRooms,
    bookmarkedRooms,
    t,
    selectConversation,
    selectRoom,
    closeAndNavigate,
    onStartConversation,
    onClose,
    onCreateQuickChat,
    onAddContact,
    onOpenSettings,
    onToggleConsole,
    onToggleShortcutHelp,
    archivedConversations,
  ])

  // =============================================================================
  // Filter and group items (combined into single memo for simplicity)
  // =============================================================================

  const { flatItems, groupedItems, filterMode } = useMemo(() => {
    const { filterMode, searchQuery } = parseQuery(query)
    const allowedTypes = getTypesForMode(filterMode)

    let filtered: CommandItem[]

    if (!searchQuery && filterMode === 'all') {
      // Default view: show a balanced mix from each category
      const convs = allItems.filter((i) => i.type === 'conversation').slice(0, 5)
      const conts = allItems.filter((i) => i.type === 'contact').slice(0, 3)
      const rooms = allItems.filter((i) => i.type === 'room').slice(0, 4)
      const views = allItems.filter((i) => i.type === 'view').slice(0, 3)
      const actions = allItems.filter((i) => i.type === 'action').slice(0, 3)
      filtered = [...convs, ...conts, ...rooms, ...views, ...actions]
    } else if (!searchQuery) {
      // Filter mode without search: show all items of matching types
      filtered = allItems.filter((i) => allowedTypes.includes(i.type))
    } else {
      // Search mode: filter by type and query
      filtered = allItems
        .filter((i) => allowedTypes.includes(i.type))
        .filter((i) => itemMatchesQuery(i, searchQuery))
    }

    const grouped = groupItemsByType(filtered, t)
    const flat = grouped.flatMap((g) => g.items)

    return { flatItems: flat, groupedItems: grouped, filterMode }
  }, [allItems, query, t])

  // Clamp selected index to valid range
  const effectiveIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, flatItems.length - 1))

  // =============================================================================
  // Effects
  // =============================================================================

  // Reset state synchronously when palette opens (before paint, before user can interact)
  useLayoutEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      selectedIndexRef.current = 0
      setIsKeyboardNav(false)
      lastMousePosRef.current = null
      // Ignore mouse events briefly to prevent stale hover from setting wrong index
      ignoreMouseRef.current = true
    }
  }, [isOpen])

  // Focus input and re-enable mouse after paint
  useEffect(() => {
    if (isOpen) {
      inputRef.current?.focus()
      // Re-enable mouse after a frame to avoid stale hover events
      requestAnimationFrame(() => {
        ignoreMouseRef.current = false
      })
    }
  }, [isOpen])

  // Reset selection synchronously when query changes
  useLayoutEffect(() => {
    setSelectedIndex(0)
    selectedIndexRef.current = 0
  }, [query])

  // Scroll selected item into view
  useEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [effectiveIndex])

  // =============================================================================
  // Event handlers
  // =============================================================================

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Handle Cmd+K / Ctrl+K to toggle (close) the palette
    if (e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      onClose()
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        e.stopPropagation() // Prevent global shortcuts from firing
        setIsKeyboardNav(true) // Enter keyboard navigation mode
        updateSelectedIndex((i) => Math.min(i + 1, flatItems.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        e.stopPropagation() // Prevent global shortcuts from firing
        setIsKeyboardNav(true) // Enter keyboard navigation mode
        updateSelectedIndex((i) => Math.max(i - 1, 0))
        break
      case 'Enter': {
        e.preventDefault()
        e.stopPropagation() // Prevent global shortcuts from firing
        // Use ref for synchronous access to avoid race condition with state updates
        const currentIndex = Math.min(Math.max(0, selectedIndexRef.current), Math.max(0, flatItems.length - 1))
        flatItems[currentIndex]?.action()
        break
      }
      case 'Escape':
        e.preventDefault()
        e.stopPropagation() // Prevent global shortcuts from firing
        onClose()
        break
    }
  }

  const handleBackdropClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  // Handle mouse movement to exit keyboard navigation mode
  const handleMouseMove = (e: React.MouseEvent) => {
    // Only exit keyboard nav if mouse actually moved (not just scroll-triggered events)
    const lastPos = lastMousePosRef.current
    if (lastPos && (Math.abs(e.clientX - lastPos.x) > 3 || Math.abs(e.clientY - lastPos.y) > 3)) {
      setIsKeyboardNav(false)
    }
    lastMousePosRef.current = { x: e.clientX, y: e.clientY }
  }

  // =============================================================================
  // Render
  // =============================================================================

  if (!isOpen) return null

  // Pre-compute a map from item id to flat index (avoids O(n²) findIndex in render)
  const indexById = new Map(flatItems.map((item, i) => [item.id, i]))

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-[15vh] z-50"
      onClick={handleBackdropClick}
    >
      <div
        className="bg-fluux-sidebar rounded-lg shadow-2xl w-full max-w-lg mx-4 overflow-hidden border border-fluux-hover"
        onKeyDown={handleKeyDown}
      >
        {/* Search Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-fluux-hover">
          <Search className="w-5 h-5 text-fluux-muted flex-shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('commandPalette.placeholder')}
            className="flex-1 bg-transparent text-fluux-text placeholder:text-fluux-muted outline-none text-base"
          />
          <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 text-xs text-fluux-muted bg-fluux-bg rounded border border-fluux-hover">
            esc
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-2" onMouseMove={handleMouseMove}>
          {flatItems.length === 0 ? (
            <div className="px-4 py-8 text-center text-fluux-muted">
              {t('commandPalette.noResults')}
            </div>
          ) : (
            groupedItems.map((group) => (
              <div key={group.type}>
                <div className="px-4 py-1.5 text-xs font-semibold text-fluux-muted uppercase tracking-wide">
                  {group.label}
                </div>
                {group.items.map((item) => {
                  const itemIndex = indexById.get(item.id) ?? 0
                  const isSelected = itemIndex === effectiveIndex

                  return (
                    <button
                      key={item.id}
                      data-selected={isSelected}
                      onClick={item.action}
                      onMouseEnter={() => !ignoreMouseRef.current && !isKeyboardNav && updateSelectedIndex(itemIndex)}
                      className={`w-full flex items-center gap-3 px-4 py-2 text-left transition-colors
                        focus:outline-none focus-visible:!shadow-none border-l-2
                        ${isSelected
                          ? 'bg-fluux-brand/50 text-fluux-text border-fluux-brand font-medium'
                          : `text-fluux-text border-transparent ${isKeyboardNav ? '' : 'hover:bg-fluux-hover'}`
                        }`}
                    >
                      <span className={`flex-shrink-0 ${isSelected ? 'text-fluux-brand' : 'text-fluux-muted'}`}>
                        {item.icon}
                      </span>
                      {item.presence && (
                        <span
                          className={`w-2 h-2 rounded-full flex-shrink-0 ${forceOffline ? APP_OFFLINE_PRESENCE_COLOR : PRESENCE_COLORS[item.presence]}`}
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{item.label}</div>
                        {item.sublabel && (
                          <div className="text-xs text-fluux-muted truncate">{item.sublabel}</div>
                        )}
                      </div>
                      {isSelected && (
                        <kbd className="hidden sm:inline-flex items-center px-1.5 py-0.5 text-xs text-fluux-muted bg-fluux-bg rounded border border-fluux-hover">
                          ↵
                        </kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-fluux-hover text-xs text-fluux-muted">
          <div className="flex items-center gap-3 mb-1.5">
            {filterMode === 'all' ? (
              <>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-fluux-bg rounded border border-fluux-hover font-mono">@</kbd>
                  {t('commandPalette.filterContacts')}
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-fluux-bg rounded border border-fluux-hover font-mono">#</kbd>
                  {t('commandPalette.filterRooms')}
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 bg-fluux-bg rounded border border-fluux-hover font-mono">&gt;</kbd>
                  {t('commandPalette.filterCommands')}
                </span>
              </>
            ) : (
              <span className="text-fluux-brand">
                {filterMode === 'contacts' && t('commandPalette.filteringContacts')}
                {filterMode === 'rooms' && t('commandPalette.filteringRooms')}
                {filterMode === 'commands' && t('commandPalette.filteringCommands')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-4">
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-fluux-bg rounded border border-fluux-hover">↑</kbd>
              <kbd className="px-1 py-0.5 bg-fluux-bg rounded border border-fluux-hover">↓</kbd>
              {t('commandPalette.navigate')}
            </span>
            <span className="flex items-center gap-1">
              <kbd className="px-1 py-0.5 bg-fluux-bg rounded border border-fluux-hover">↵</kbd>
              {t('commandPalette.select')}
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
