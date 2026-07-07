import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { TextInput } from './ui/TextInput'
import { useTranslation } from 'react-i18next'
import {
  MessageSquare,
  Hash,
  Plus,
  Settings,
  HelpCircle,
  Terminal,
  Users,
  Search,
} from 'lucide-react'
import { useChat, useRoom, useRoster, matchNameOrJid, getLocalPart, searchStore } from '@fluux/sdk'
import { formatLocalizedPreview } from '@/utils/messagePreviewText'
import { detectRenderLoop } from '@/utils/renderLoopDetector'
import { useChatStore, useConnectionStore, useRoomStore } from '@fluux/sdk/react'
import type { PresenceStatus } from '@fluux/sdk'
import type { SidebarView } from './Sidebar'
import { Avatar } from './Avatar'
import { useSettingsStore } from '@/stores/settingsStore'
import { isAdvancedMode } from '@/stores/advancedModeStore'
import { ModalOverlay } from './ModalOverlay'

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
  lastMessagePreview?: string
  lastMessageBody?: string // Raw body for search matching
  /** Icon for non-entity rows (views, actions). Entity rows render an Avatar instead. */
  icon?: React.ReactNode
  /** Identifier for the entity avatar's consistent color (raw JID, matches the sidebar). */
  avatarIdentifier?: string
  /** Avatar image URL for an entity row (contact or room avatar), when available. */
  avatarUrl?: string
  /** Unread message count for conversation/room rows (drives the Unread section + badge). */
  unreadCount?: number
  /** Mention count for room rows (ranks a mentioned room above merely-unread ones). */
  mentionsCount?: number
  /** Last-message time (ms) for recency ordering in the attention group. */
  sortTimestamp?: number
  action: () => void
  keywords?: string[]
  presence?: PresenceStatus
}

interface ItemGroup {
  key: string
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
    if (matchNameOrJid(item.label, item.sublabel, searchQuery)) return true
  }

  // Check last message body for conversations/rooms
  if (item.lastMessageBody?.toLowerCase().includes(searchQuery)) {
    return true
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
    { type: 'contact', labelKey: 'sidebar.contacts' },
    { type: 'view', labelKey: 'commandPalette.views' },
    { type: 'action', labelKey: 'commandPalette.actions' },
  ]

  for (const { type, labelKey } of typeOrder) {
    const typeItems = items.filter((i) => i.type === type)
    if (typeItems.length > 0) {
      groups.push({ key: type, type, label: t(labelKey), items: typeItems })
    }
  }

  return groups
}

// Unread ranking tier for a room row: mentions outrank plain unread, which outrank read.
function roomTier(item: CommandItem): number {
  if ((item.mentionsCount ?? 0) > 0) return 0
  if ((item.unreadCount ?? 0) > 0) return 1
  return 2
}

// =============================================================================
// Helper: Build groups for the empty-query default view (unread-first)
// =============================================================================

// Cap on the number of items promoted into the top "Needs attention" group.
const ATTENTION_CAP = 6

// Most-recent-first; items without a timestamp sort last.
const byRecency = (a: CommandItem, b: CommandItem) => (b.sortTimestamp ?? 0) - (a.sortTimestamp ?? 0)

function buildDefaultGroups(items: CommandItem[], t: (key: string) => string): ItemGroup[] {
  const groups: ItemGroup[] = []

  const conversations = items.filter((i) => i.type === 'conversation')
  const roomItems = items.filter((i) => i.type === 'room')

  // Top group: unread DMs + rooms with a mention/whisper, interleaved by recency, capped.
  const unreadConvs = conversations.filter((i) => (i.unreadCount ?? 0) > 0)
  const mentionRooms = roomItems.filter((i) => (i.mentionsCount ?? 0) > 0)
  const attention = [...unreadConvs, ...mentionRooms].sort(byRecency).slice(0, ATTENTION_CAP)
  if (attention.length > 0) {
    groups.push({ key: 'attention', type: 'conversation', label: t('commandPalette.attention'), items: attention })
  }
  const promotedIds = new Set(attention.map((i) => i.id))

  // Read DMs stay in their own group below.
  const readConvs = conversations.filter((i) => (i.unreadCount ?? 0) === 0).slice(0, 5)
  if (readConvs.length > 0) {
    groups.push({ key: 'conversation', type: 'conversation', label: t('sidebar.messages'), items: readConvs })
  }

  // Rooms group: everything not already promoted, tier-sorted (mention overflow lands at tier 0).
  const rooms = roomItems
    .filter((i) => !promotedIds.has(i.id))
    .sort((a, b) => roomTier(a) - roomTier(b))
    .slice(0, 4)
  if (rooms.length > 0) {
    groups.push({ key: 'room', type: 'room', label: t('sidebar.rooms'), items: rooms })
  }

  // Contacts without an active conversation are intentionally omitted from the
  // default view — it surfaces things you already have a thread with (or a
  // view/action). Such contacts remain reachable by typing a name (or the
  // `@` prefix), which routes through the search/filter path below.

  const views = items.filter((i) => i.type === 'view').slice(0, 3)
  if (views.length > 0) {
    groups.push({ key: 'view', type: 'view', label: t('commandPalette.views'), items: views })
  }

  const actions = items.filter((i) => i.type === 'action').slice(0, 3)
  if (actions.length > 0) {
    groups.push({ key: 'action', type: 'action', label: t('commandPalette.actions'), items: actions })
  }

  return groups
}

// =============================================================================
// Component
// =============================================================================

/**
 * Top-level wrapper. Returns null when closed so the heavy hooks inside
 * `CommandPaletteContent` (`useChat`, `useRoom`, `useRoster`) are NOT
 * subscribed when the palette isn't visible. The palette is always mounted
 * by ChatLayout, so without this guard it would re-render on every chat /
 * room store update during background MAM sync.
 */
export function CommandPalette(props: CommandPaletteProps) {
  if (!props.isOpen) return null
  return <CommandPaletteContent {...props} />
}

function CommandPaletteContent({
  onClose,
  onSidebarViewChange,
  onOpenSettings,
  onToggleConsole,
  onToggleShortcutHelp,
  onCreateQuickChat,
  onAddContact,
  onStartConversation,
}: CommandPaletteProps) {
  detectRenderLoop('CommandPalette')
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedIndexRef = useRef(0) // Ref for synchronous access in event handlers
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const ignoreMouseRef = useRef(true) // start true; cleared after first paint to avoid stale-hover index changes
  const [isKeyboardNav, setIsKeyboardNav] = useState(false) // Track keyboard navigation mode
  const lastMousePosRef = useRef<{ x: number; y: number } | null>(null) // Track mouse position to detect real movement

  // Wrapper to update both state and ref together
  const updateSelectedIndex = (indexOrFn: number | ((prev: number) => number)) => {
    setSelectedIndex((prev) => {
      const newIndex = typeof indexOrFn === 'function' ? indexOrFn(prev) : indexOrFn
      selectedIndexRef.current = newIndex
      return newIndex
    })
  }

  // Data from stores
  const { conversations, archivedConversations } = useChat()
  const { joinedRooms, bookmarkedRooms, setActiveRoom } = useRoom()
  const { contacts } = useRoster()
  const connectionStatus = useConnectionStore((s) => s.status)
  const forceOffline = connectionStatus !== 'online'
  const { setActiveConversation } = useChatStore()
  // The entity currently open in the main pane — never propose "go to where you
  // already are". Read as narrow selectors (change only on navigation, which
  // closes the palette anyway).
  const activeConversationId = useChatStore((s) => s.activeConversationId)
  const activeRoomJid = useRoomStore((s) => s.activeRoomJid)
  // Narrow read: only re-render on a density change. Drives the entity avatar
  // size and the action/view icon box; row padding + gap come from CSS keyed on
  // `[data-density]` (the `.command-row` class) so a flip needs no row work.
  const densityMode = useSettingsStore((s) => s.densityMode)
  const isCompact = densityMode === 'compact'
  const avatarSize = isCompact ? 'xs' : 'sm'
  const iconBoxClass = isCompact ? 'size-6' : 'size-8'
  const iconGlyphClass = isCompact ? '[&_svg]:size-4' : '[&_svg]:size-5'

  // Navigation callbacks
  const closeAndNavigate = (view: SidebarView) => {
    onSidebarViewChange(view)
    onClose()
  }

  const selectConversation = (jid: string) => {
    // Navigate first, THEN set conversation - otherwise handleSidebarViewChange
    // will overwrite our selection with the "last conversation" restore logic
    // Archived conversations open in the messages tab (via the archive toggle)
    closeAndNavigate('messages')
    void setActiveConversation(jid)
    void setActiveRoom(null)
  }

  const selectRoom = (jid: string) => {
    // Navigate first, THEN set room - otherwise handleSidebarViewChange
    // will overwrite our selection with the "last room" restore logic
    closeAndNavigate('rooms')
    void setActiveRoom(jid)
    void setActiveConversation(null)
  }

  // =============================================================================
  // Build all command items
  // =============================================================================

  const allItems = ((): CommandItem[] => {
    const items: CommandItem[] = []
    const conversationJids = new Set(conversations.map((c) => c.id))

    // 1. Conversations (contacts with active chats, sorted by recency)
    for (const conv of conversations) {
      if (conv.type !== 'chat') continue
      if (conv.id === activeConversationId) continue // don't propose the open conversation
      const contact = contacts.find((c) => c.jid === conv.id)
      const preview = conv.lastMessage ? formatLocalizedPreview(conv.lastMessage, t) : undefined
      items.push({
        id: `conv-${conv.id}`,
        type: 'conversation',
        label: contact?.name || conv.name,
        sublabel: conv.id,
        lastMessagePreview: preview,
        lastMessageBody: conv.lastMessage?.body,
        unreadCount: conv.unreadCount,
        sortTimestamp: conv.lastMessage?.timestamp?.getTime(),
        avatarIdentifier: conv.id,
        avatarUrl: contact?.avatar,
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
        avatarIdentifier: contact.jid,
        avatarUrl: contact.avatar,
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
      if (room.jid === activeRoomJid) continue // don't propose the open room
      const preview = room.lastMessage ? formatLocalizedPreview(room.lastMessage, t) : undefined
      items.push({
        id: `room-${room.jid}`,
        type: 'room',
        label: room.name || getLocalPart(room.jid),
        sublabel: room.jid,
        lastMessagePreview: preview,
        lastMessageBody: room.lastMessage?.body,
        unreadCount: room.unreadCount,
        mentionsCount: room.mentionsCount,
        sortTimestamp: room.lastMessage?.timestamp?.getTime(),
        avatarIdentifier: room.jid,
        avatarUrl: room.avatar,
        action: () => selectRoom(room.jid),
        keywords: [getLocalPart(room.jid), 'room', 'muc', 'group'],
      })
    }

    // 4. Bookmarked but not joined rooms
    for (const room of bookmarkedRooms.filter((r) => !r.joined)) {
      items.push({
        id: `bookmark-${room.jid}`,
        type: 'room',
        label: room.name || getLocalPart(room.jid),
        sublabel: `${room.jid} (${t('rooms.bookmarked')})`,
        avatarIdentifier: room.jid,
        avatarUrl: room.avatar,
        action: () => selectRoom(room.jid),
        keywords: [getLocalPart(room.jid), 'room', 'bookmark'],
      })
    }

    // 5. Views (navigation)
    const views: Array<{ id: string; label: string; icon: React.ReactNode; view: SidebarView; keywords: string[] }> = [
      { id: 'view-messages', label: t('sidebar.messages'), icon: <MessageSquare />, view: 'messages', keywords: ['messages', 'conversations', 'chat'] },
      { id: 'view-rooms', label: t('sidebar.rooms'), icon: <Hash />, view: 'rooms', keywords: ['rooms', 'channels', 'muc'] },
      { id: 'view-connections', label: t('sidebar.contacts'), icon: <Users />, view: 'contacts', keywords: ['connections', 'contacts', 'roster'] },
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
      { id: 'action-quick-chat', label: t('rooms.createQuickChat'), icon: <Plus />, action: () => { onCreateQuickChat(); onClose() }, keywords: ['new', 'create', 'quick', 'chat'] },
      { id: 'action-add-contact', label: t('contacts.addContact'), icon: <Plus />, action: () => { onAddContact(); onClose() }, keywords: ['new', 'add', 'contact', 'friend'] },
      { id: 'action-join-room', label: t('rooms.joinRoom'), icon: <Plus />, action: () => closeAndNavigate('rooms'), keywords: ['join', 'room', 'muc'] },
      { id: 'action-settings', label: t('sidebar.settings'), icon: <Settings />, action: () => { onOpenSettings(); onClose() }, keywords: ['settings', 'preferences', 'options'] },
      { id: 'action-shortcuts', label: t('shortcuts.title'), icon: <HelpCircle />, action: () => { onToggleShortcutHelp(); onClose() }, keywords: ['shortcuts', 'keyboard', 'help'] },
      // Console is an advanced-only surface: hide the entry when advanced mode is off.
      ...(isAdvancedMode() ? [{ id: 'action-console', label: t('console.title'), icon: <Terminal />, action: () => { onToggleConsole(); onClose() }, keywords: ['console', 'xmpp', 'debug'] }] : []),
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
  })()

  // =============================================================================
  // Filter and group items (combined into single memo for simplicity)
  // =============================================================================

  const { flatItems, groupedItems, filterMode, isDefaultView } = (() => {
    const { filterMode, searchQuery } = parseQuery(query)
    const allowedTypes = getTypesForMode(filterMode)
    const isDefaultView = !searchQuery && filterMode === 'all'

    let grouped: ItemGroup[]
    if (isDefaultView) {
      // Default view: unread-first grouping (Unread DMs on top, then the rest)
      grouped = buildDefaultGroups(allItems, t)
    } else if (!searchQuery) {
      // Filter mode without search: show all items of matching types
      grouped = groupItemsByType(allItems.filter((i) => allowedTypes.includes(i.type)), t)
    } else {
      // Search mode: filter by type and query
      grouped = groupItemsByType(
        allItems
          .filter((i) => allowedTypes.includes(i.type))
          .filter((i) => itemMatchesQuery(i, searchQuery)),
        t,
      )
    }

    // Append "Search messages" gateway when user has typed a query
    if (searchQuery && filterMode !== 'commands') {
      const gatewayItem: CommandItem = {
        id: 'search-gateway',
        type: 'action',
        label: t('commandPalette.searchMessages', { query: searchQuery }),
        icon: <Search />,
        action: () => {
          searchStore.getState().search(searchQuery)
          closeAndNavigate('search')
        },
        keywords: [],
      }
      // Append to existing actions group, or create one
      const actionsGroup = grouped.find((g) => g.type === 'action')
      if (actionsGroup) {
        actionsGroup.items.push(gatewayItem)
      } else {
        grouped.push({ key: 'action', type: 'action', label: t('commandPalette.actions'), items: [gatewayItem] })
      }
    }

    const flat = grouped.flatMap((g) => g.items)

    return { flatItems: flat, groupedItems: grouped, filterMode, isDefaultView }
  })()

  // Clamp selected index to valid range
  const effectiveIndex = Math.min(Math.max(0, selectedIndex), Math.max(0, flatItems.length - 1))

  // =============================================================================
  // Effects
  // =============================================================================

  // Content mounts when the palette opens, so on-open setup runs in mount effects.
  // useState initial values already reset query/index/keyboard-nav; we just need
  // to suppress mouseEnter from any stale hover and focus the input.
  useEffect(() => {
    inputRef.current?.focus()
    requestAnimationFrame(() => {
      ignoreMouseRef.current = false
    })
  }, [])

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

  const handleKeyDown = (e: React.KeyboardEvent, { close }: { close: () => void }) => {
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
        close()
        break
    }
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

  // Pre-compute a map from item id to flat index (avoids O(n²) findIndex in render)
  const indexById = new Map(flatItems.map((item, i) => [item.id, i]))

  return (
    <ModalOverlay
      onClose={onClose}
      align="top"
      width="max-w-lg"
      panelClassName="overflow-hidden"
      panelInClass="command-palette-in"
      focusRef={inputRef}
      closeOnEscape={false}
      panelProps={{ role: 'dialog', 'aria-modal': true }}
      onPanelKeyDown={handleKeyDown}
    >
        {/* Search Input — contained, rounded field with a soft accent focus ring
            that wraps the whole field (icon + input + esc), matching the
            composer card's `:focus-within` treatment. The palette auto-focuses
            the input, so the ring is effectively always on while open, giving a
            clear "type here" affordance. The ring lives on the wrapper via the
            `command-search-field` class (Tailwind's `/opacity` modifiers no-op
            on our `hsl()`-string accent token, so a plain CSS rule is used). The
            inner input carries `no-focus-ring` so the global 2px outline doesn't
            draw a second, tighter box around just the text field. */}
        <div className="p-3 border-b border-fluux-hover">
          <div className="command-search-field flex items-center gap-3 px-3 py-2 rounded-lg border border-fluux-hover bg-fluux-bg/40
            transition-[box-shadow,border-color] duration-150">
            <Search className="size-5 text-fluux-muted flex-shrink-0" />
            <TextInput
              ref={inputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('commandPalette.placeholder')}
              className="flex-1 bg-transparent text-fluux-text placeholder:text-fluux-muted outline-none no-focus-ring text-base"
            />
            <kbd className="hidden sm:inline-flex items-center gap-1 px-2 py-0.5 text-xs text-fluux-muted bg-fluux-bg rounded border border-fluux-hover">
              esc
            </kbd>
          </div>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[60vh] overflow-y-auto py-2" onMouseMove={handleMouseMove}>
          {flatItems.length === 0 ? (
            <div className="px-4 py-8 text-center text-fluux-muted">
              {t('commandPalette.noResults')}
            </div>
          ) : (
            groupedItems.map((group) => (
              <div key={group.key}>
                <div className="px-4 command-group-label text-xs font-semibold text-fluux-muted uppercase tracking-wide font-display">
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
                      className={`w-full flex items-center command-row px-4 text-start transition-colors
                        focus:outline-none focus-visible:!shadow-none border-s-2
                        ${isSelected
                          ? 'text-fluux-text border-fluux-brand font-medium'
                          : `text-fluux-text border-transparent ${isKeyboardNav ? '' : 'hover:bg-fluux-hover'}`
                        }`}
                    >
                      {item.avatarIdentifier !== undefined ? (
                        <Avatar
                          size={avatarSize}
                          identifier={item.avatarIdentifier}
                          name={item.label}
                          avatarUrl={item.avatarUrl}
                          presence={item.presence}
                          forceOffline={forceOffline}
                          presenceBorderColor="border-fluux-chat"
                          fallbackIcon={
                            item.type === 'room'
                              ? <Hash className={isCompact ? 'size-3.5' : 'size-4'} />
                              : undefined
                          }
                        />
                      ) : (
                        <span
                          className={`flex items-center justify-center flex-shrink-0 ${iconBoxClass} ${iconGlyphClass}
                            ${isSelected ? 'text-fluux-brand' : 'text-fluux-muted'}`}
                        >
                          {item.icon}
                        </span>
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="truncate">{item.label}</div>
                        {item.sublabel && (
                          <div className="text-xs text-fluux-muted truncate">{item.sublabel}</div>
                        )}
                        {item.lastMessagePreview && (
                          <div className="text-xs text-fluux-muted/70 truncate italic">
                            {item.lastMessagePreview.length > 60
                              ? item.lastMessagePreview.slice(0, 60) + '…'
                              : item.lastMessagePreview}
                          </div>
                        )}
                      </div>
                      {isDefaultView && (item.unreadCount ?? 0) > 0 && (
                        <span
                          className={`ms-2 flex-shrink-0 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full text-xs font-semibold ${
                            (item.mentionsCount ?? 0) > 0
                              ? 'bg-fluux-brand text-white'
                              : 'bg-fluux-hover text-fluux-text'
                          }`}
                        >
                          {item.unreadCount}
                        </span>
                      )}
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
    </ModalOverlay>
  )
}
