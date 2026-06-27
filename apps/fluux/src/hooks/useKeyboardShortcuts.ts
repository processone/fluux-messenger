import { useEffect, useRef } from 'react'
import { useModalStore } from '@/stores/modalStore'
import { chatStore, roomStore } from '@fluux/sdk'
import { useSettingsStore } from '../stores/settingsStore'
import { isAdvancedMode } from '@/stores/advancedModeStore'

export interface ShortcutDefinition {
  key: string
  modifiers?: ('ctrl' | 'meta' | 'shift' | 'alt')[]
  description: string
  category: 'navigation' | 'actions' | 'general'
  action: () => void
  /** If true, shortcut is shown in help but not intercepted (handled by system) */
  displayOnly?: boolean
}

type SidebarView = 'messages' | 'rooms' | 'directory' | 'archive' | 'events' | 'admin' | 'settings' | 'search'

interface UseKeyboardShortcutsOptions {
  onToggleShortcutHelp: () => void
  onToggleConsole: () => void
  onOpenSettings: () => void
  onQuitApp?: () => void
  onCreateQuickChat: () => void
  onOpenCommandPalette: () => void
  onOpenPresenceMenu: () => void
  sidebarView: SidebarView
  onSidebarViewChange: (view: SidebarView) => void
  navigateToMessages: (jid?: string) => void
  navigateToRooms: (jid?: string) => void
  /** Toggle find-on-page in the active conversation/room view */
  onFindOnPage?: () => void
  /** Navigate to next find-on-page match */
  onFindNext?: () => void
  /** Navigate to previous find-on-page match */
  onFindPrev?: () => void
  // Escape hierarchy state and handlers
  // Modals (command palette, shortcut help, presence menu, quick chat) are closed
  // by reading the modalStore directly in handleEscape — they are NOT passed here,
  // so ChatLayout no longer has to subscribe to modal state just to drive Escape.
  // Only the non-modal escape targets are passed in.
  escapeHierarchy?: {
    isConsoleOpen: boolean
    onCloseConsole: () => void
    isContactProfileOpen: boolean
    onCloseContactProfile: () => void
  }
}

// Keys that require Shift to type on some keyboards (don't check shiftKey for these)
// Includes numbers for AZERTY keyboards (French) where Shift is needed to type digits
const SHIFTED_KEYS = new Set([
  '?', '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '{', '}', '|', ':', '"', '<', '>', '~',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'
])

/**
 * Returns true if the event matches the shortcut definition
 */
function matchesShortcut(e: KeyboardEvent, shortcut: ShortcutDefinition): boolean {
  const modifiers = shortcut.modifiers || []

  // Check modifier keys
  const needsCtrl = modifiers.includes('ctrl')
  const needsMeta = modifiers.includes('meta')
  const needsShift = modifiers.includes('shift')
  const needsAlt = modifiers.includes('alt')

  // For cross-platform: ctrl on Windows/Linux, meta (Cmd) on Mac
  const isMod = needsCtrl || needsMeta
  const hasCorrectMod = isMod ? (e.ctrlKey || e.metaKey) : (!e.ctrlKey && !e.metaKey)

  if (!hasCorrectMod) return false
  if (needsAlt !== e.altKey) return false

  // Check the key
  const shortcutKey = shortcut.key

  // For number keys with Alt modifier, use e.code since Alt+number produces special chars on macOS
  // e.code gives physical key position: "Digit1", "Digit2", etc.
  // Also ignore shift since AZERTY keyboards require shift for numbers
  if (needsAlt && /^[0-9]$/.test(shortcutKey)) {
    return e.code === `Digit${shortcutKey}`
  }

  // For letter keys with Alt modifier, use e.code since Alt+letter produces special chars on macOS
  // e.code gives physical key position: "KeyA", "KeyB", etc.
  if (needsAlt && /^[a-zA-Z]$/.test(shortcutKey)) {
    return e.code === `Key${shortcutKey.toUpperCase()}`
  }

  // For shifted keys (like ?), allow shift even if not explicitly required
  const isShiftedKey = SHIFTED_KEYS.has(shortcutKey)
  if (!isShiftedKey && needsShift !== e.shiftKey) return false

  // Handle special case for '?' which requires shift on most keyboards
  if (shortcutKey === '?') {
    return e.key === '?' || (e.key === '/' && e.shiftKey)
  }

  // Case-insensitive comparison for letters
  return e.key.toLowerCase() === shortcutKey.toLowerCase()
}

/**
 * Hook to handle global keyboard shortcuts.
 * Returns the list of registered shortcuts for display in help screen.
 *
 * IMPORTANT: Uses getState() to read conversation/room data in callbacks
 * to avoid subscribing to rapidly changing data that causes render loops
 * during MAM loading.
 */
export function useKeyboardShortcuts(options: UseKeyboardShortcutsOptions): ShortcutDefinition[] {
  const {
    onToggleShortcutHelp,
    onToggleConsole,
    onOpenSettings,
    onQuitApp,
    onCreateQuickChat,
    onOpenCommandPalette,
    onOpenPresenceMenu,
    sidebarView,
    onSidebarViewChange,
    navigateToMessages,
    navigateToRooms,
    onFindOnPage,
    onFindNext,
    onFindPrev,
    escapeHierarchy,
  } = options

  const platform = getPlatform()
  const supportsQuitShortcut = platform === 'windows' || platform === 'linux'
  const quitShortcut: ShortcutDefinition | null = supportsQuitShortcut && onQuitApp
    ? {
      key: 'q',
      modifiers: ['meta'],
      description: 'shortcuts.quitApp',
      category: 'general',
      action: onQuitApp,
    }
    : null

  // NOTE: Use the vanilla stores instead of useChat()/useRoom() hooks.
  // Those hooks subscribe to conversations/rooms which change during MAM loading,
  // causing unnecessary re-renders. getState() reads create no subscriptions.
  // activateConversation/activateRoom hydrate the message cache before setting
  // active, so the switched-to view never renders empty.
  const setActiveConversation = (id: string | null) =>
    chatStore.getState().activateConversation(id)
  const setActiveRoom = (roomJid: string | null) =>
    roomStore.getState().activateRoom(roomJid)

  // Navigate to next conversation/room with unread messages
  // Conversations are checked first (priority for direct messages), then rooms sorted by recent activity
  // NOTE: Uses getState() to read current data without creating subscriptions
  const goToNextUnread = () => {
    // Read current state without subscribing
    const conversations = Array.from(chatStore.getState().conversations.values())
      .filter(c => !chatStore.getState().archivedConversations.has(c.id))
      .sort((a, b) => {
        const aTime = a.lastMessage?.timestamp instanceof Date ? a.lastMessage.timestamp.getTime() : 0
        const bTime = b.lastMessage?.timestamp instanceof Date ? b.lastMessage.timestamp.getTime() : 0
        return bTime - aTime
      })
    const activeConversationId = chatStore.getState().activeConversationId
    const activeRoomJid = roomStore.getState().activeRoomJid
    const joinedRooms = roomStore.getState().joinedRooms()

    // First check conversations (sorted by most recent activity)
    const unreadConv = conversations.find(c =>
      c.unreadCount > 0 && c.id !== activeConversationId
    )
    if (unreadConv) {
      void setActiveRoom(null)
      void setActiveConversation(unreadConv.id)
      navigateToMessages(unreadConv.id)
      return
    }

    // Then check rooms - build list and sort by most recent activity
    const unreadRooms = joinedRooms
      .filter(r => (r.mentionsCount > 0 || r.unreadCount > 0) && r.jid !== activeRoomJid)
      .map(room => {
        // Get timestamp from last message (safely handle empty/missing messages)
        const messages = room.messages || []
        const lastMessage = messages[messages.length - 1]
        const timestamp = lastMessage?.timestamp instanceof Date
          ? lastMessage.timestamp.getTime()
          : (lastMessage?.timestamp ? new Date(lastMessage.timestamp).getTime() : 0)
        return { room, timestamp }
      })
      .sort((a, b) => b.timestamp - a.timestamp) // Most recent first

    if (unreadRooms.length > 0) {
      void setActiveConversation(null)
      void setActiveRoom(unreadRooms[0].room.jid)
      navigateToRooms(unreadRooms[0].room.jid)
    }
  }

  // Navigate to previous item in current sidebar view (stops at top, no wrap)
  // NOTE: Uses getState() to read current data without creating subscriptions
  const goToPreviousItem = () => {
    if (sidebarView === 'messages' || sidebarView === 'archive') {
      // Read current state without subscribing
      const conversations = Array.from(chatStore.getState().conversations.values())
        .filter(c => !chatStore.getState().archivedConversations.has(c.id))
        .sort((a, b) => {
          const aTime = a.lastMessage?.timestamp instanceof Date ? a.lastMessage.timestamp.getTime() : 0
          const bTime = b.lastMessage?.timestamp instanceof Date ? b.lastMessage.timestamp.getTime() : 0
          return bTime - aTime
        })
      const activeConversationId = chatStore.getState().activeConversationId

      // Navigate through conversations - stop at top
      if (conversations.length === 0) return
      const currentIndex = conversations.findIndex(c => c.id === activeConversationId)
      if (currentIndex <= 0) return // Already at top or not found
      void setActiveRoom(null)
      void setActiveConversation(conversations[currentIndex - 1].id)
    } else if (sidebarView === 'rooms') {
      // Read current state without subscribing
      // Use allRooms() (sorted by lastInteractedAt) filtered to joined — matches sidebar visual order
      const joinedRooms = roomStore.getState().allRooms().filter(r => r.joined)
      const activeRoomJid = roomStore.getState().activeRoomJid

      // Navigate through joined rooms - stop at top
      if (joinedRooms.length === 0) return
      const currentIndex = joinedRooms.findIndex(r => r.jid === activeRoomJid)
      if (currentIndex <= 0) return // Already at top or not found
      void setActiveConversation(null)
      void setActiveRoom(joinedRooms[currentIndex - 1].jid)
    }
  }

  // Navigate to next item in current sidebar view (stops at bottom, no wrap)
  // NOTE: Uses getState() to read current data without creating subscriptions
  const goToNextItem = () => {
    if (sidebarView === 'messages' || sidebarView === 'archive') {
      // Read current state without subscribing
      const conversations = Array.from(chatStore.getState().conversations.values())
        .filter(c => !chatStore.getState().archivedConversations.has(c.id))
        .sort((a, b) => {
          const aTime = a.lastMessage?.timestamp instanceof Date ? a.lastMessage.timestamp.getTime() : 0
          const bTime = b.lastMessage?.timestamp instanceof Date ? b.lastMessage.timestamp.getTime() : 0
          return bTime - aTime
        })
      const activeConversationId = chatStore.getState().activeConversationId

      // Navigate through conversations - stop at bottom
      if (conversations.length === 0) return
      const currentIndex = conversations.findIndex(c => c.id === activeConversationId)
      // If not found (-1), select first; if at end, stay there
      if (currentIndex < 0) {
        void setActiveRoom(null)
        void setActiveConversation(conversations[0].id)
      } else if (currentIndex < conversations.length - 1) {
        void setActiveRoom(null)
        void setActiveConversation(conversations[currentIndex + 1].id)
      }
      // At bottom: do nothing
    } else if (sidebarView === 'rooms') {
      // Read current state without subscribing
      // Use allRooms() (sorted by lastInteractedAt) filtered to joined — matches sidebar visual order
      const joinedRooms = roomStore.getState().allRooms().filter(r => r.joined)
      const activeRoomJid = roomStore.getState().activeRoomJid

      // Navigate through joined rooms - stop at bottom
      if (joinedRooms.length === 0) return
      const currentIndex = joinedRooms.findIndex(r => r.jid === activeRoomJid)
      // If not found (-1), select first; if at end, stay there
      if (currentIndex < 0) {
        void setActiveConversation(null)
        void setActiveRoom(joinedRooms[0].jid)
      } else if (currentIndex < joinedRooms.length - 1) {
        void setActiveConversation(null)
        void setActiveRoom(joinedRooms[currentIndex + 1].jid)
      }
      // At bottom: do nothing
    }
  }

  // Handle escape key with hierarchy (closes innermost context first)
  const handleEscape = () => {
    // Priority order: modals first, then panels, then focus states.
    // 1-4. Modals (highest priority) — read non-reactively from the store so the
    // components that own these modals don't subscribe reactively just to drive
    // Escape (that subscription is what re-rendered the sidebar column on a modal
    // toggle). Same four modals, same priority as before.
    const modals = useModalStore.getState()
    if (modals.commandPalette) { modals.close('commandPalette'); return true }
    if (modals.shortcutHelp) { modals.close('shortcutHelp'); return true }
    if (modals.presenceMenu) { modals.close('presenceMenu'); return true }
    if (modals.quickChat) { modals.close('quickChat'); return true }

    const esc = escapeHierarchy

    // 5. Console panel
    if (esc?.isConsoleOpen) {
      esc.onCloseConsole()
      return true
    }

    // 6. Contact Profile view
    if (esc?.isContactProfileOpen) {
      esc.onCloseContactProfile()
      return true
    }

    // 8. Blur focused input (composer, search, etc.)
    const activeElement = document.activeElement as HTMLElement
    if (activeElement && (
      activeElement.tagName === 'INPUT' ||
      activeElement.tagName === 'TEXTAREA' ||
      activeElement.isContentEditable
    )) {
      activeElement.blur()
      return true
    }

    return false
  }

  // Define all shortcuts
  const shortcuts: ShortcutDefinition[] = [
    {
      key: '?',
      modifiers: ['ctrl'],
      description: 'shortcuts.showKeyboardShortcuts',
      category: 'general',
      action: onToggleShortcutHelp,
    },
    {
      key: 'F12',
      modifiers: [],
      description: 'shortcuts.toggleXmppConsole',
      category: 'general',
      // Read advanced-mode non-reactively at key-press time to avoid a render
      // subscription. The console is an advanced-only surface: pressing F12
      // while advanced mode is off is a no-op (avoids the open-then-close flash
      // that would occur if the close-on-disable effect ran immediately after).
      action: () => { if (isAdvancedMode()) onToggleConsole() },
    },
    {
      key: 'l',
      modifiers: ['meta', 'shift'],
      description: 'shortcuts.toggleLightDarkMode',
      category: 'general',
      action: () => {
        const { themeMode, setThemeMode } = useSettingsStore.getState()
        if (themeMode === 'light') {
          setThemeMode('dark')
        } else if (themeMode === 'dark') {
          setThemeMode('light')
        } else {
          // 'system' — toggle to the opposite of the current effective mode
          const isSystemLight = window.matchMedia('(prefers-color-scheme: light)').matches
          setThemeMode(isSystemLight ? 'dark' : 'light')
        }
      },
    },
    {
      key: 'i',
      modifiers: ['ctrl', 'alt'],
      description: 'shortcuts.javascriptConsole',
      category: 'general',
      action: () => {},
      displayOnly: true, // Handled by browser/Tauri
    },
    {
      key: 'u',
      modifiers: ['meta'],
      description: 'shortcuts.nextUnread',
      category: 'navigation',
      action: goToNextUnread,
    },
    {
      key: '1',
      modifiers: ['alt'],
      description: 'shortcuts.messagesView',
      category: 'navigation',
      action: () => onSidebarViewChange('messages'),
    },
    {
      key: '2',
      modifiers: ['alt'],
      description: 'shortcuts.roomsView',
      category: 'navigation',
      action: () => onSidebarViewChange('rooms'),
    },
    {
      key: '3',
      modifiers: ['alt'],
      description: 'shortcuts.connectionsView',
      category: 'navigation',
      action: () => onSidebarViewChange('directory'),
    },
    {
      key: '4',
      modifiers: ['alt'],
      description: 'shortcuts.archiveView',
      category: 'navigation',
      action: () => onSidebarViewChange('archive'),
    },
    {
      key: '5',
      modifiers: ['alt'],
      description: 'shortcuts.eventsView',
      category: 'navigation',
      action: () => onSidebarViewChange('events'),
    },
    {
      key: '0',
      modifiers: ['alt'],
      description: 'shortcuts.adminView',
      category: 'navigation',
      action: () => onSidebarViewChange('admin'),
    },
    {
      key: 'f',
      modifiers: ['meta'],
      description: 'shortcuts.findInConversation',
      category: 'navigation',
      action: () => { onFindOnPage?.() },
    },
    {
      key: 'g',
      modifiers: ['meta'],
      description: 'shortcuts.nextMatch',
      category: 'navigation',
      action: () => { onFindNext?.() },
    },
    {
      key: 'g',
      modifiers: ['meta', 'shift'],
      description: 'shortcuts.previousMatch',
      category: 'navigation',
      action: () => { onFindPrev?.() },
    },
    {
      key: 'f',
      modifiers: ['meta', 'shift'],
      description: 'shortcuts.searchView',
      category: 'navigation',
      action: () => onSidebarViewChange('search'),
    },
    {
      key: '6',
      modifiers: ['alt'],
      description: 'shortcuts.searchView',
      category: 'navigation',
      action: () => onSidebarViewChange('search'),
    },
    {
      key: 'ArrowUp',
      modifiers: ['meta', 'alt'],
      description: 'shortcuts.previousItem',
      category: 'navigation',
      action: goToPreviousItem,
    },
    {
      key: 'ArrowDown',
      modifiers: ['meta', 'alt'],
      description: 'shortcuts.nextItem',
      category: 'navigation',
      action: goToNextItem,
    },
    {
      key: ',',
      modifiers: ['meta'],
      description: 'shortcuts.settings',
      category: 'general',
      action: () => {
        // Navigate to settings view (toggle: go back to messages if already in settings)
        if (sidebarView === 'settings') {
          onSidebarViewChange('messages')
        } else {
          onOpenSettings()
        }
      },
    },
    {
      key: 'y',
      modifiers: ['alt'],
      description: 'shortcuts.changeStatus',
      category: 'actions',
      // onOpenPresenceMenu toggles via the store (open if closed, close if open).
      action: onOpenPresenceMenu,
    },
    {
      key: 'n',
      modifiers: ['meta'],
      description: 'shortcuts.createQuickChat',
      category: 'actions',
      action: onCreateQuickChat,
    },
    {
      key: 'k',
      modifiers: ['meta'],
      description: 'shortcuts.goTo',
      category: 'general',
      // onOpenCommandPalette toggles via the store (open if closed, close if open).
      action: onOpenCommandPalette,
    },
    ...(quitShortcut ? [quitShortcut] : []),
    {
      key: 'Escape',
      modifiers: [],
      description: 'shortcuts.closeModalPanelBlur',
      category: 'general',
      action: handleEscape,
    },
  ]

  const shortcutsRef = useRef<ShortcutDefinition[]>(shortcuts)
  shortcutsRef.current = shortcuts

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in input fields (except for specific ones)
      const target = e.target as HTMLElement
      const isInputField = target.tagName === 'INPUT' ||
                          target.tagName === 'TEXTAREA' ||
                          target.isContentEditable

      // Skip navigation shortcuts when command palette is open (it handles its own
      // keyboard nav). Read non-reactively from the store at keypress time.
      const isCommandPaletteOpen = useModalStore.getState().commandPalette

      for (const shortcut of shortcutsRef.current) {
        // Skip display-only shortcuts - let browser/system handle them
        if (shortcut.displayOnly) continue

        if (matchesShortcut(e, shortcut)) {
          // Skip navigation category shortcuts when command palette is open
          if (isCommandPaletteOpen && shortcut.category === 'navigation') {
            continue
          }

          // Allow some shortcuts even in input fields
          const isAltArrow = (shortcut.key === 'ArrowUp' || shortcut.key === 'ArrowDown') &&
                             shortcut.modifiers?.includes('alt')
          const isCmdK = shortcut.key.toLowerCase() === 'k' &&
                         (shortcut.modifiers?.includes('meta') || shortcut.modifiers?.includes('ctrl'))
          const isCmdU = shortcut.key.toLowerCase() === 'u' &&
                         (shortcut.modifiers?.includes('meta') || shortcut.modifiers?.includes('ctrl'))
          const isCmdF = shortcut.key.toLowerCase() === 'f' &&
                         (shortcut.modifiers?.includes('meta') || shortcut.modifiers?.includes('ctrl'))
          const isCmdG = shortcut.key.toLowerCase() === 'g' &&
                         (shortcut.modifiers?.includes('meta') || shortcut.modifiers?.includes('ctrl'))
          const isCmdShiftL = shortcut.key.toLowerCase() === 'l' &&
                         (shortcut.modifiers?.includes('meta') || shortcut.modifiers?.includes('ctrl')) &&
                         shortcut.modifiers?.includes('shift')
          const isCmdQ = shortcut.key.toLowerCase() === 'q' &&
                         (shortcut.modifiers?.includes('meta') || shortcut.modifiers?.includes('ctrl'))
          const isAltNumber = /^[0-9]$/.test(shortcut.key) && shortcut.modifiers?.includes('alt')
          const allowInInput = shortcut.key === '?' || shortcut.key === 'F12' || shortcut.key === 'Escape' || isAltArrow || isAltNumber || isCmdK || isCmdU || isCmdF || isCmdG || isCmdShiftL || isCmdQ

          if (!isInputField || allowInInput) {
            e.preventDefault()
            shortcut.action()
            return
          }
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  return shortcuts
}

/**
 * Detect platform for display formatting
 */
function getPlatform(): 'mac' | 'windows' | 'linux' {
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('mac')) return 'mac'
  if (platform.includes('win')) return 'windows'
  return 'linux'
}

/**
 * Format shortcut key for display (platform-aware)
 * Mac: ⌘ ⇧ ? (with spaces between symbols)
 * Windows/Linux: Ctrl+Shift+?
 */
export function formatShortcutKey(shortcut: ShortcutDefinition): string {
  const platform = getPlatform()
  const isMac = platform === 'mac'
  const parts: string[] = []

  const modifiers = shortcut.modifiers || []

  // On Mac, use symbols; on Windows/Linux, use text
  if (modifiers.includes('ctrl') || modifiers.includes('meta')) {
    parts.push(isMac ? '⌘' : 'Ctrl')
  }
  if (modifiers.includes('alt')) {
    parts.push(isMac ? '⌥' : 'Alt')
  }
  if (modifiers.includes('shift')) {
    parts.push(isMac ? '⇧' : 'Shift')
  }

  // Format special keys
  let keyDisplay = shortcut.key
  const keyLower = shortcut.key.toLowerCase()

  switch (keyLower) {
    case 'arrowup': keyDisplay = '↑'; break
    case 'arrowdown': keyDisplay = '↓'; break
    case 'arrowleft': keyDisplay = '←'; break
    case 'arrowright': keyDisplay = '→'; break
    case 'escape': keyDisplay = 'Esc'; break
    case 'enter': keyDisplay = isMac ? '↵' : 'Enter'; break
    case ' ': keyDisplay = 'Space'; break
    case 'backspace': keyDisplay = isMac ? '⌫' : 'Backspace'; break
    case 'delete': keyDisplay = isMac ? '⌦' : 'Delete'; break
    case 'tab': keyDisplay = isMac ? '⇥' : 'Tab'; break
    // Function keys stay as-is
    default:
      if (keyLower.startsWith('f') && !isNaN(parseInt(keyLower.slice(1)))) {
        keyDisplay = shortcut.key.toUpperCase()
      }
  }

  parts.push(keyDisplay)

  // Mac: space between symbols for readability
  // Windows/Linux: + between parts
  return parts.join(isMac ? ' ' : '+')
}
