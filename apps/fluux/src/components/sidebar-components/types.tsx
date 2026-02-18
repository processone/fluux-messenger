import { createContext, useContext, type RefObject, type ReactNode } from 'react'
import type { Contact } from '@fluux/sdk'
import { getTranslatedStatusText } from '@/utils/statusText'
import { getTranslatedShowText } from '@/utils/presence'

export type SidebarView = 'messages' | 'rooms' | 'directory' | 'archive' | 'events' | 'admin' | 'settings'

// Context to share sidebarListRef with child components for focus zone scoping
export const SidebarZoneContext = createContext<RefObject<HTMLDivElement> | undefined>(undefined)

export function useSidebarZone() {
  return useContext(SidebarZoneContext)
}

/**
 * Generate rich tooltip content for contact's connected devices.
 * Returns a ReactNode with proper formatting for the Tooltip component.
 */
export function ContactDevicesTooltip({
  contact,
  t,
  forceOffline = false,
}: {
  contact: Contact
  t: (key: string) => string
  forceOffline?: boolean
}): ReactNode {
  const hasDevices = contact.resources && contact.resources.size > 0

  return (
    <div className="space-y-1">
      <div className="font-medium">{contact.name}</div>
      <div className="text-fluux-muted text-xs">{contact.jid}</div>
      {hasDevices && (
        <div className="pt-1 border-t border-fluux-border mt-1 space-y-0.5">
          {Array.from(contact.resources!.entries()).map(([resource, presence]) => {
            const clientName = presence.client || resource || t('contacts.unknown')
            const status = getTranslatedShowText(presence.show, t, forceOffline)
            return (
              <div key={resource} className="text-xs whitespace-nowrap">
                <span className="text-fluux-text">{clientName}:</span>{' '}
                <span className="text-fluux-muted">{status}</span>
              </div>
            )
          })}
        </div>
      )}
      {!hasDevices && (
        <div className="text-xs text-fluux-muted">
          {forceOffline ? t('presence.offline') : getTranslatedStatusText(contact, t)}
        </div>
      )}
    </div>
  )
}

// Sidebar sizing constants
export const SIDEBAR_MIN_WIDTH = 200
export const SIDEBAR_MAX_WIDTH = 400
export const SIDEBAR_DEFAULT_WIDTH = 288 // 18rem = 288px (matches md:w-72)
export const SIDEBAR_WIDTH_KEY = 'sidebar-width'

// URL paths for each sidebar view
export const VIEW_PATHS: Record<SidebarView, string> = {
  messages: '/messages',
  rooms: '/rooms',
  directory: '/contacts',
  archive: '/archive',
  events: '/events',
  admin: '/admin',
  settings: '/settings/appearance', // Default to appearance category
}
