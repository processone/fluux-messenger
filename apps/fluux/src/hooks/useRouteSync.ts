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
 *
 * Navigation uses a push/replace discipline for clean mobile back behavior:
 * - Tab switches use `replace` (no history accumulation across tabs)
 * - First item selection uses `push` (one back-able entry: detail → list)
 * - Switching items uses `replace` (lateral moves don't accumulate)
 * - Back/up navigation uses `replace` (clean return to list)
 */
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useCallback, useMemo } from 'react'
import type { SidebarView } from '@/components/sidebar-components/types'

/** Options for navigation functions to control history behavior */
export interface NavigateOptions {
  /** Use replace instead of push (prevents adding to browser history stack) */
  replace?: boolean
}

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
  navigateToMessages: (jid?: string, options?: NavigateOptions) => void
  /** Navigate to rooms view, optionally selecting a room */
  navigateToRooms: (jid?: string, options?: NavigateOptions) => void
  /** Navigate to contacts/directory view, optionally selecting a contact */
  navigateToContacts: (jid?: string, options?: NavigateOptions) => void
  /** Navigate to archive view, optionally selecting an archived conversation */
  navigateToArchive: (jid?: string, options?: NavigateOptions) => void
  /** Navigate to events view */
  navigateToEvents: (options?: NavigateOptions) => void
  /** Navigate to admin view, optionally selecting a category */
  navigateToAdmin: (category?: string, options?: NavigateOptions) => void
  /** Navigate to settings view, optionally selecting a category */
  navigateToSettings: (category?: string, options?: NavigateOptions) => void
  /** Deterministic "go up" within current tab (detail → list, or list → messages) */
  navigateUp: () => void
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

  // Navigation actions - all accept optional { replace: true } for history control
  const navigateToMessages = useCallback((jid?: string, options?: NavigateOptions) => {
    const opts = options?.replace ? { replace: true } : undefined
    if (jid) {
      void navigate(`/messages/${encodeURIComponent(jid)}`, opts)
    } else {
      void navigate('/messages', opts)
    }
  }, [navigate])

  const navigateToRooms = useCallback((jid?: string, options?: NavigateOptions) => {
    const opts = options?.replace ? { replace: true } : undefined
    if (jid) {
      void navigate(`/rooms/${encodeURIComponent(jid)}`, opts)
    } else {
      void navigate('/rooms', opts)
    }
  }, [navigate])

  const navigateToContacts = useCallback((jid?: string, options?: NavigateOptions) => {
    const opts = options?.replace ? { replace: true } : undefined
    if (jid) {
      void navigate(`/contacts/${encodeURIComponent(jid)}`, opts)
    } else {
      void navigate('/contacts', opts)
    }
  }, [navigate])

  const navigateToArchive = useCallback((jid?: string, options?: NavigateOptions) => {
    const opts = options?.replace ? { replace: true } : undefined
    if (jid) {
      void navigate(`/archive/${encodeURIComponent(jid)}`, opts)
    } else {
      void navigate('/archive', opts)
    }
  }, [navigate])

  const navigateToEvents = useCallback((options?: NavigateOptions) => {
    const opts = options?.replace ? { replace: true } : undefined
    void navigate('/events', opts)
  }, [navigate])

  const navigateToAdmin = useCallback((category?: string, options?: NavigateOptions) => {
    const opts = options?.replace ? { replace: true } : undefined
    if (category) {
      void navigate(`/admin/${encodeURIComponent(category)}`, opts)
    } else {
      void navigate('/admin', opts)
    }
  }, [navigate])

  const navigateToSettings = useCallback((category?: string, options?: NavigateOptions) => {
    const opts = options?.replace ? { replace: true } : undefined
    if (category) {
      void navigate(`/settings/${encodeURIComponent(category)}`, opts)
    } else {
      void navigate('/settings', opts)
    }
  }, [navigate])

  // Deterministic "go up" - navigates from detail to list within current tab.
  // Uses replace to keep the history stack clean.
  const navigateUp = useCallback(() => {
    const view = parseRoute(location.pathname)
    const hasDetail = extractJidFromPath(location.pathname) !== null
      || extractAdminCategory(location.pathname) !== null
      || extractSettingsCategory(location.pathname) !== null

    if (hasDetail) {
      // Detail -> list: replace to keep stack clean
      const base = view === 'directory' ? '/contacts' : `/${view}`
      void navigate(base, { replace: true })
    } else {
      // Already at list level, go to messages as fallback
      void navigate('/messages', { replace: true })
    }
  }, [navigate, location.pathname])

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
    navigateUp,
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
    navigateUp,
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
