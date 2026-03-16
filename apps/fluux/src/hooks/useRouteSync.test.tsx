/**
 * Tests for useRouteSync hook.
 *
 * Tests URL parsing, state derivation, and navigation actions.
 */
import { describe, it, expect } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useRouteSync, getViewPath } from './useRouteSync'
import type { ReactNode } from 'react'

// Helper to create wrapper with specific initial route
function createWrapper(initialEntries: string[] = ['/messages']) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={initialEntries}>
        {children}
      </MemoryRouter>
    )
  }
}

describe('useRouteSync', () => {
  describe('URL parsing - sidebarView', () => {
    it('returns "messages" for /messages', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/messages']),
      })
      expect(result.current.sidebarView).toBe('messages')
    })

    it('returns "messages" for /messages/:jid', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/messages/user@example.com']),
      })
      expect(result.current.sidebarView).toBe('messages')
    })

    it('returns "rooms" for /rooms', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/rooms']),
      })
      expect(result.current.sidebarView).toBe('rooms')
    })

    it('returns "rooms" for /rooms/:jid', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/rooms/room@conference.example.com']),
      })
      expect(result.current.sidebarView).toBe('rooms')
    })

    it('returns "directory" for /contacts', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/contacts']),
      })
      expect(result.current.sidebarView).toBe('directory')
    })

    it('returns "directory" for /contacts/:jid', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/contacts/contact@example.com']),
      })
      expect(result.current.sidebarView).toBe('directory')
    })

    it('returns "archive" for /archive', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/archive']),
      })
      expect(result.current.sidebarView).toBe('archive')
    })

    it('returns "events" for /events', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/events']),
      })
      expect(result.current.sidebarView).toBe('events')
    })

    it('returns "admin" for /admin', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/admin']),
      })
      expect(result.current.sidebarView).toBe('admin')
    })

    it('returns "admin" for /admin/:category', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/admin/users']),
      })
      expect(result.current.sidebarView).toBe('admin')
    })

    it('returns "messages" for / (root)', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/']),
      })
      expect(result.current.sidebarView).toBe('messages')
    })

    it('returns "messages" for unknown routes', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/unknown/path']),
      })
      expect(result.current.sidebarView).toBe('messages')
    })
  })

  describe('URL parsing - activeJid', () => {
    it('returns null when no JID in URL', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/messages']),
      })
      expect(result.current.activeJid).toBeNull()
    })

    it('extracts JID from /messages/:jid', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/messages/user@example.com']),
      })
      expect(result.current.activeJid).toBe('user@example.com')
    })

    it('extracts JID from /rooms/:jid', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/rooms/room@conference.example.com']),
      })
      expect(result.current.activeJid).toBe('room@conference.example.com')
    })

    it('extracts JID from /contacts/:jid', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/contacts/contact@example.com']),
      })
      expect(result.current.activeJid).toBe('contact@example.com')
    })

    it('extracts JID from /archive/:jid', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/archive/archived@example.com']),
      })
      expect(result.current.activeJid).toBe('archived@example.com')
    })

    it('decodes URL-encoded JIDs', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/messages/user%40example.com']),
      })
      expect(result.current.activeJid).toBe('user@example.com')
    })

    it('handles JIDs with special characters', () => {
      const jid = 'user+tag@example.com/resource'
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper([`/messages/${encodeURIComponent(jid)}`]),
      })
      expect(result.current.activeJid).toBe(jid)
    })
  })

  describe('URL parsing - adminCategory', () => {
    it('returns null for /admin', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/admin']),
      })
      expect(result.current.adminCategory).toBeNull()
    })

    it('extracts category from /admin/:category', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/admin/users']),
      })
      expect(result.current.adminCategory).toBe('users')
    })

    it('extracts category from /admin/:category with nested path', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/admin/rooms/details']),
      })
      expect(result.current.adminCategory).toBe('rooms')
    })
  })

  describe('URL parsing - settings', () => {
    it('returns "settings" sidebarView for /settings', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/settings']),
      })
      // Settings is now a regular sidebar view
      expect(result.current.sidebarView).toBe('settings')
    })

    it('returns "settings" sidebarView for /settings/:category', () => {
      const { result } = renderHook(() => useRouteSync(), {
        wrapper: createWrapper(['/settings/language']),
      })
      expect(result.current.sidebarView).toBe('settings')
      expect(result.current.settingsCategory).toBe('language')
    })
  })

  describe('navigation actions', () => {
    it('navigateToMessages navigates to /messages', () => {
      let currentPath = '/rooms'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/rooms']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToMessages()
      })

      expect(currentPath).toBe('/messages')
    })

    it('navigateToMessages with JID navigates to /messages/:jid', () => {
      let currentPath = '/rooms'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/rooms']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToMessages('user@example.com')
      })

      expect(currentPath).toBe('/messages/user%40example.com')
    })

    it('navigateToRooms navigates to /rooms', () => {
      let currentPath = '/messages'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToRooms()
      })

      expect(currentPath).toBe('/rooms')
    })

    it('navigateToRooms with JID navigates to /rooms/:jid', () => {
      let currentPath = '/messages'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToRooms('room@conference.example.com')
      })

      expect(currentPath).toBe('/rooms/room%40conference.example.com')
    })

    it('navigateToContacts navigates to /contacts', () => {
      let currentPath = '/messages'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToContacts()
      })

      expect(currentPath).toBe('/contacts')
    })

    it('navigateToArchive navigates to /archive', () => {
      let currentPath = '/messages'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToArchive()
      })

      expect(currentPath).toBe('/archive')
    })

    it('navigateToEvents navigates to /events', () => {
      let currentPath = '/messages'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToEvents()
      })

      expect(currentPath).toBe('/events')
    })

    it('navigateToAdmin navigates to /admin', () => {
      let currentPath = '/messages'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToAdmin()
      })

      expect(currentPath).toBe('/admin')
    })

    it('navigateToAdmin with category navigates to /admin/:category', () => {
      let currentPath = '/messages'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToAdmin('users')
      })

      expect(currentPath).toBe('/admin/users')
    })

    it('navigateToSettings navigates to /settings', () => {
      let currentPath = '/messages'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToSettings()
      })

      expect(currentPath).toBe('/settings')
    })

    it('navigateToSettings with category navigates to /settings/:category', () => {
      let currentPath = '/messages'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateToSettings('notifications')
      })

      expect(currentPath).toBe('/settings/notifications')
    })

    it('navigateUp goes from detail to list within current tab', () => {
      let currentPath = '/messages/user%40example.com'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/messages/user%40example.com']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateUp()
      })

      expect(currentPath).toBe('/messages')
    })

    it('navigateUp goes to messages when already at list level', () => {
      let currentPath = '/rooms'
      const wrapper = ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/rooms']}>
          {children}
          <LocationCapture onPathChange={(p) => (currentPath = p)} />
        </MemoryRouter>
      )

      const { result } = renderHook(() => useRouteSync(), { wrapper })

      act(() => {
        result.current.navigateUp()
      })

      expect(currentPath).toBe('/messages')
    })
  })

  describe('getViewPath helper', () => {
    it('returns /messages for messages view', () => {
      expect(getViewPath('messages')).toBe('/messages')
    })

    it('returns /messages/:jid with encoded JID', () => {
      expect(getViewPath('messages', 'user@example.com')).toBe('/messages/user%40example.com')
    })

    it('returns /rooms for rooms view', () => {
      expect(getViewPath('rooms')).toBe('/rooms')
    })

    it('returns /contacts for directory view', () => {
      expect(getViewPath('directory')).toBe('/contacts')
    })

    it('returns /archive for archive view', () => {
      expect(getViewPath('archive')).toBe('/archive')
    })

    it('returns /events for events view', () => {
      expect(getViewPath('events')).toBe('/events')
    })

    it('returns /admin for admin view', () => {
      expect(getViewPath('admin')).toBe('/admin')
    })
  })
})

// Helper component to capture location changes in tests
function LocationCapture({ onPathChange }: { onPathChange: (path: string) => void }) {
  const location = useLocation()
  onPathChange(location.pathname)
  return null
}
