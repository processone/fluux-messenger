import { useEffect, useCallback, useMemo, useRef } from 'react'
import { chatStore, roomStore } from '@fluux/sdk'
import { useChatStore, useRoomStore } from '@fluux/sdk/react'

export interface ShortcutDefinition {
  key: string
  modifiers?: ('ctrl' | 'meta' | 'shift' | 'alt')[]
  description: string
  category: 'navigation' | 'actions' | 'general'
  action: () => void
  /** If true, shortcut is shown in help but not intercepted (handled by system) */
  displayOnly?: boolean
}

type SidebarView = 'messages' | 'rooms' | 'directory' | 'archive' | 'events' | 'admin' | 'settings'

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
  // Escape hierarchy state and handlers
  escapeHierarchy?: {
    isCommandPaletteOpen: boolean
    onCloseCommandPalette: () => void
    isShortcutHelpOpen: boolean
    onCloseShortcutHelp: () => void
    isPresenceMenuOpen: boolean
    onClosePresenceMenu: () => void
    isQuickChatOpen: boolean
    onCloseQuickChat: () => void
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
    escapeHierarchy,
  } = options

  const platform = getPlatform()
  const supportsQuitShortcut = platform === 'windows' || platform === 'linux'
  const quitShortcut = useMemo<ShortcutDefinition | null>(() => (
    supportsQuitShortcut && onQuitApp
      ? {
        key: 'q',
        modifiers: ['meta'],
        description: 'Quit app',
        category: 'general',
        action: onQuitApp,
      }
      : null
  ), [supportsQuitShortcut, onQuitApp])

  // NOTE: Use direct store subscriptions instead of useChat()/useRoom() hooks.
  // Those hooks subscribe to conversations/rooms which change during MAM loading,
  // causing unnecessary re-renders. We only need the setters as stable references.
  const setActiveConversation = useChatStore((s) => s.setActiveConversation)
  const setActiveRoom = useRoomStore((s) => s.setActiveRoom)

  // Navigate to next conversation/room with unread messages
  // Conversations are checked first (priority for direct messages), then rooms sorted by recent activity
  // NOTE: Uses getState() to read current data without creating subscriptions
  const goToNextUnread = useCallback(() => {
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
      setActiveRoom(null)
      setActiveConversation(unreadConv.id)
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
      setActiveConversation(null)
      setActiveRoom(unreadRooms[0].room.jid)
      navigateToRooms(unreadRooms[0].room.jid)
    }
  }, [setActiveConversation, setActiveRoom, navigateToMessages, navigateToRooms])

  // Navigate to previous item in current sidebar view (stops at top, no wrap)
  // NOTE: Uses getState() to read current data without creating subscriptions
  const goToPreviousItem = useCallback(() => {
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
      setActiveRoom(null)
      setActiveConversation(conversations[currentIndex - 1].id)
    } else if (sidebarView === 'rooms') {
      // Read current state without subscribing
      const joinedRooms = roomStore.getState().joinedRooms()
      const activeRoomJid = roomStore.getState().activeRoomJid

      // Navigate through joined rooms - stop at top
      if (joinedRooms.length === 0) return
      const currentIndex = joinedRooms.findIndex(r => r.jid === activeRoomJid)
      if (currentIndex <= 0) return // Already at top or not found
      setActiveConversation(null)
      setActiveRoom(joinedRooms[currentIndex - 1].jid)
    }
  }, [sidebarView, setActiveConversation, setActiveRoom])

  // Navigate to next item in current sidebar view (stops at bottom, no wrap)
  // NOTE: Uses getState() to read current data without creating subscriptions
  const goToNextItem = useCallback(() => {
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
        setActiveRoom(null)
        setActiveConversation(conversations[0].id)
      } else if (currentIndex < conversations.length - 1) {
        setActiveRoom(null)
        setActiveConversation(conversations[currentIndex + 1].id)
      }
      // At bottom: do nothing
    } else if (sidebarView === 'rooms') {
      // Read current state without subscribing
      const joinedRooms = roomStore.getState().joinedRooms()
      const activeRoomJid = roomStore.getState().activeRoomJid

      // Navigate through joined rooms - stop at bottom
      if (joinedRooms.length === 0) return
      const currentIndex = joinedRooms.findIndex(r => r.jid === activeRoomJid)
      // If not found (-1), select first; if at end, stay there
      if (currentIndex < 0) {
        setActiveConversation(null)
        setActiveRoom(joinedRooms[0].jid)
      } else if (currentIndex < joinedRooms.length - 1) {
        setActiveConversation(null)
        setActiveRoom(joinedRooms[currentIndex + 1].jid)
      }
      // At bottom: do nothing
    }
  }, [sidebarView, setActiveConversation, setActiveRoom])

  // Handle escape key with hierarchy (closes innermost context first)
  const handleEscape = useCallback(() => {
    const esc = escapeHierarchy
    if (!esc) return false

    // Priority order: modals first, then panels, then focus states
    // 1. Command Palette (highest priority - topmost modal)
    if (esc.isCommandPaletteOpen) {
      esc.onCloseCommandPalette()
      return true
    }

    // 2. Shortcut Help modal
    if (esc.isShortcutHelpOpen) {
      esc.onCloseShortcutHelp()
      return true
    }

    // 3. Presence Menu
    if (esc.isPresenceMenuOpen) {
      esc.onClosePresenceMenu()
      return true
    }

    // 4. Quick Chat modal
    if (esc.isQuickChatOpen) {
      esc.onCloseQuickChat()
      return true
    }

    // 5. Console panel
    if (esc.isConsoleOpen) {
      esc.onCloseConsole()
      return true
    }

    // 6. Contact Profile view
    if (esc.isContactProfileOpen) {
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
  }, [escapeHierarchy])

  // Define all shortcuts
  const shortcuts = useMemo<ShortcutDefinition[]>(() => [
    {
      key: '?',
      modifiers: ['ctrl'],
      description: 'Show keyboard shortcuts',
      category: 'general',
      action: onToggleShortcutHelp,
    },
    {
      key: 'F12',
      modifiers: [],
      description: 'Toggle XMPP Console',
      category: 'general',
      action: onToggleConsole,
    },
    {
      key: 'i',
      modifiers: ['ctrl', 'alt'],
      description: 'JavaScript Console (if enabled)',
      category: 'general',
      action: () => {},
      displayOnly: true, // Handled by browser/Tauri
    },
    {
      key: 'u',
      modifiers: ['meta'],
      description: 'Next unread conversation',
      category: 'navigation',
      action: goToNextUnread,
    },
    {
      key: '1',
      modifiers: ['alt'],
      description: 'Messages view',
      category: 'navigation',
      action: () => onSidebarViewChange('messages'),
    },
    {
      key: '2',
      modifiers: ['alt'],
      description: 'Rooms view',
      category: 'navigation',
      action: () => onSidebarViewChange('rooms'),
    },
    {
      key: '3',
      modifiers: ['alt'],
      description: 'Connections view',
      category: 'navigation',
      action: () => onSidebarViewChange('directory'),
    },
    {
      key: '4',
      modifiers: ['alt'],
      description: 'Archive view',
      category: 'navigation',
      action: () => onSidebarViewChange('archive'),
    },
    {
      key: '5',
      modifiers: ['alt'],
      description: 'Events view',
      category: 'navigation',
      action: () => onSidebarViewChange('events'),
    },
    {
      key: '0',
      modifiers: ['alt'],
      description: 'Admin view',
      category: 'navigation',
      action: () => onSidebarViewChange('admin'),
    },
    {
      key: 'ArrowUp',
      modifiers: ['alt'],
      description: 'Previous conversation/room',
      category: 'navigation',
      action: goToPreviousItem,
    },
    {
      key: 'ArrowDown',
      modifiers: ['alt'],
      description: 'Next conversation/room',
      category: 'navigation',
      action: goToNextItem,
    },
    {
      key: ',',
      modifiers: ['meta'],
      description: 'Settings',
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
      description: 'Change status',
      category: 'actions',
      action: () => {
        // Toggle presence menu - close if open, open if closed
        if (escapeHierarchy?.isPresenceMenuOpen) {
          escapeHierarchy.onClosePresenceMenu()
        } else {
          onOpenPresenceMenu()
        }
      },
    },
    {
      key: 'n',
      modifiers: ['meta'],
      description: 'Create quick chat',
      category: 'actions',
      action: onCreateQuickChat,
    },
    {
      key: 'k',
      modifiers: ['meta'],
      description: 'Go to...',
      category: 'general',
      action: () => {
        // Toggle command palette - close if open, open if closed
        if (escapeHierarchy?.isCommandPaletteOpen) {
          escapeHierarchy.onCloseCommandPalette()
        } else {
          onOpenCommandPalette()
        }
      },
    },
    ...(quitShortcut ? [quitShortcut] : []),
    {
      key: 'Escape',
      modifiers: [],
      description: 'Close modal/panel/blur input',
      category: 'general',
      action: handleEscape,
    },
  ], [
    onToggleShortcutHelp,
    onToggleConsole,
    goToNextUnread,
    onSidebarViewChange,
    goToPreviousItem,
    goToNextItem,
    sidebarView,
    onOpenSettings,
    escapeHierarchy,
    onOpenPresenceMenu,
    onCreateQuickChat,
    onOpenCommandPalette,
    quitShortcut,
    handleEscape,
  ])

  const shortcutsRef = useRef<ShortcutDefinition[]>(shortcuts)
  const isCommandPaletteOpenRef = useRef(escapeHierarchy?.isCommandPaletteOpen ?? false)

  useEffect(() => {
    shortcutsRef.current = shortcuts
  }, [shortcuts])

  useEffect(() => {
    isCommandPaletteOpenRef.current = escapeHierarchy?.isCommandPaletteOpen ?? false
  }, [escapeHierarchy?.isCommandPaletteOpen])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in input fields (except for specific ones)
      const target = e.target as HTMLElement
      const isInputField = target.tagName === 'INPUT' ||
                          target.tagName === 'TEXTAREA' ||
                          target.isContentEditable

      // Skip navigation shortcuts when command palette is open (it handles its own keyboard nav)
      const isCommandPaletteOpen = isCommandPaletteOpenRef.current

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
          const isCmdQ = shortcut.key.toLowerCase() === 'q' &&
                         (shortcut.modifiers?.includes('meta') || shortcut.modifiers?.includes('ctrl'))
          const allowInInput = shortcut.key === '?' || shortcut.key === 'F12' || shortcut.key === 'Escape' || isAltArrow || isCmdK || isCmdU || isCmdQ

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
