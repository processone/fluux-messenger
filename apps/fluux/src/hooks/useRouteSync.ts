/**
 * Hook to sync React Router URL with view state.
 *
 * Phase 2.1: Provides URL-derived state and navigation helpers.
 * ChatLayout can use this to read view state from URL instead of useState.
 *
 * URL Structure:
 * - /messages           → messages view, no selection
 * - /messages/:jid      → messages view, conversation selected
 * - /rooms              → rooms view, no selection
 * - /rooms/:jid         → rooms view, room selected
 * - /contacts           → directory view, no selection
 * - /contacts/:jid      → directory view, contact profile selected
 * - /archive            → archive view, no selection
 * - /archive/:jid       → archive view, archived conversation selected
 * - /events             → events view
 * - /admin              → admin view, no category
 * - /admin/:category    → admin view, category selected
 * - /settings           → settings view
 * - /settings/:category → settings view with category selected
 */
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useCallback, useMemo } from 'react'
import type { SidebarView } from '@/components/sidebar-components/types'

export interface RouteState {
  /** Current sidebar view derived from URL path */
  sidebarView: SidebarView
  /** JID from URL params (conversation, room, or contact) */
  activeJid: string | null
  /** Admin category from URL (for /admin/:category) */
  adminCategory: string | null
  /** Settings category from URL (for /settings/:category) */
  settingsCategory: string | null
}

export interface RouteActions {
  /** Navigate to messages view, optionally selecting a conversation */
  navigateToMessages: (jid?: string) => void
  /** Navigate to rooms view, optionally selecting a room */
  navigateToRooms: (jid?: string) => void
  /** Navigate to contacts/directory view, optionally selecting a contact */
  navigateToContacts: (jid?: string) => void
  /** Navigate to archive view, optionally selecting an archived conversation */
  navigateToArchive: (jid?: string) => void
  /** Navigate to events view */
  navigateToEvents: () => void
  /** Navigate to admin view, optionally selecting a category */
  navigateToAdmin: (category?: string) => void
  /** Navigate to settings view, optionally selecting a category */
  navigateToSettings: (category?: string) => void
  /** Navigate back to previous view (or messages as default) */
  goBack: () => void
}

/**
 * Parse the current URL path to derive view state.
 */
function parseRoute(pathname: string): SidebarView {
  // Parse main views (including settings as a regular view)
  if (pathname.startsWith('/settings')) {
    return 'settings'
  }
  if (pathname.startsWith('/rooms')) {
    return 'rooms'
  }
  if (pathname.startsWith('/contacts')) {
    return 'directory'
  }
  if (pathname.startsWith('/archive')) {
    return 'archive'
  }
  if (pathname.startsWith('/events')) {
    return 'events'
  }
  if (pathname.startsWith('/admin')) {
    return 'admin'
  }

  // Default to messages
  return 'messages'
}

/**
 * Extract JID or admin category from URL params.
 * JIDs need URL decoding since they contain @ characters.
 */
function extractJidFromPath(pathname: string): string | null {
  // Match patterns like /messages/:jid, /rooms/:jid, /contacts/:jid, /archive/:jid
  const viewPaths = ['/messages/', '/rooms/', '/contacts/', '/archive/']
  for (const prefix of viewPaths) {
    if (pathname.startsWith(prefix)) {
      const encoded = pathname.slice(prefix.length)
      if (encoded) {
        try {
          return decodeURIComponent(encoded)
        } catch {
          return encoded
        }
      }
    }
  }
  return null
}

/**
 * Extract admin category from URL path.
 */
function extractAdminCategory(pathname: string): string | null {
  if (pathname.startsWith('/admin/')) {
    const parts = pathname.slice('/admin/'.length).split('/')
    return parts[0] || null
  }
  return null
}

/**
 * Extract settings category from URL path.
 */
function extractSettingsCategory(pathname: string): string | null {
  if (pathname.startsWith('/settings/')) {
    const parts = pathname.slice('/settings/'.length).split('/')
    return parts[0] || null
  }
  return null
}

/**
 * Hook to sync React Router URL with view state.
 *
 * @example
 * ```tsx
 * function ChatLayout() {
 *   const { sidebarView, activeJid, navigateToMessages, navigateToRooms } = useRouteSync()
 *
 *   // Use sidebarView instead of useState
 *   // Use navigateToMessages() instead of handleSidebarViewChange('messages')
 * }
 * ```
 */
export function useRouteSync(): RouteState & RouteActions {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams<{ jid?: string; category?: string }>()

  // Derive state from URL
  const sidebarView = useMemo(
    () => parseRoute(location.pathname),
    [location.pathname]
  )

  // Extract JID from URL (either from params or path parsing)
  const activeJid = useMemo(() => {
    // Try params first (for routes with :jid param)
    if (params.jid) {
      try {
        return decodeURIComponent(params.jid)
      } catch {
        return params.jid
      }
    }
    // Fall back to path parsing
    return extractJidFromPath(location.pathname)
  }, [params.jid, location.pathname])

  // Extract admin category
  const adminCategory = useMemo(
    () => extractAdminCategory(location.pathname),
    [location.pathname]
  )

  // Extract settings category
  const settingsCategory = useMemo(
    () => extractSettingsCategory(location.pathname),
    [location.pathname]
  )

  // Navigation actions
  const navigateToMessages = useCallback((jid?: string) => {
    if (jid) {
      void navigate(`/messages/${encodeURIComponent(jid)}`)
    } else {
      void navigate('/messages')
    }
  }, [navigate])

  const navigateToRooms = useCallback((jid?: string) => {
    if (jid) {
      void navigate(`/rooms/${encodeURIComponent(jid)}`)
    } else {
      void navigate('/rooms')
    }
  }, [navigate])

  const navigateToContacts = useCallback((jid?: string) => {
    if (jid) {
      void navigate(`/contacts/${encodeURIComponent(jid)}`)
    } else {
      void navigate('/contacts')
    }
  }, [navigate])

  const navigateToArchive = useCallback((jid?: string) => {
    if (jid) {
      void navigate(`/archive/${encodeURIComponent(jid)}`)
    } else {
      void navigate('/archive')
    }
  }, [navigate])

  const navigateToEvents = useCallback(() => {
    void navigate('/events')
  }, [navigate])

  const navigateToAdmin = useCallback((category?: string) => {
    if (category) {
      void navigate(`/admin/${encodeURIComponent(category)}`)
    } else {
      void navigate('/admin')
    }
  }, [navigate])

  const navigateToSettings = useCallback((category?: string) => {
    if (category) {
      void navigate(`/settings/${encodeURIComponent(category)}`)
    } else {
      void navigate('/settings')
    }
  }, [navigate])

  const goBack = useCallback(() => {
    // Use browser history if available, otherwise go to messages
    if (window.history.length > 1) {
      void navigate(-1)
    } else {
      void navigate('/messages')
    }
  }, [navigate])

  // Memoize the entire return value to prevent unnecessary re-renders
  // in consumers that might use the whole object in dependency arrays
  return useMemo(() => ({
    // State
    sidebarView,
    activeJid,
    adminCategory,
    settingsCategory,
    // Actions
    navigateToMessages,
    navigateToRooms,
    navigateToContacts,
    navigateToArchive,
    navigateToEvents,
    navigateToAdmin,
    navigateToSettings,
    goBack,
  }), [
    sidebarView,
    activeJid,
    adminCategory,
    settingsCategory,
    navigateToMessages,
    navigateToRooms,
    navigateToContacts,
    navigateToArchive,
    navigateToEvents,
    navigateToAdmin,
    navigateToSettings,
    goBack,
  ])
}

/**
 * Helper to convert SidebarView to the corresponding navigation function name.
 * Useful for programmatic navigation based on view type.
 */
export function getViewPath(view: SidebarView, jid?: string): string {
  const base = view === 'directory' ? '/contacts' : `/${view}`
  if (jid) {
    return `${base}/${encodeURIComponent(jid)}`
  }
  return base
}
