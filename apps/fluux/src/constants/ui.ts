/**
 * UI Constants
 *
 * Shared UI-related constants used across components.
 */

import type { PresenceStatus } from '@fluux/sdk'

/**
 * Tailwind CSS classes for presence status indicator colors
 */
export const PRESENCE_COLORS: Record<PresenceStatus, string> = {
  online: 'bg-fluux-green',
  away: 'bg-fluux-yellow',
  dnd: 'bg-fluux-red',
  offline: 'bg-fluux-gray',
}

/**
 * Presence indicator color used when the app itself is offline.
 * Distinct from contact-level offline gray.
 */
export const APP_OFFLINE_PRESENCE_COLOR = 'bg-slate-500'
