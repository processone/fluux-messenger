/**
 * Presence Display Utilities
 *
 * App-specific utilities for displaying XMPP presence states in the UI.
 * Generic presence utilities are in @fluux/sdk (getPresenceFromShow, etc.)
 */

import type { PresenceShow } from '@fluux/sdk'
import { APP_OFFLINE_PRESENCE_COLOR } from '../constants/ui'

/**
 * Map PresenceShow to a Tailwind background color class.
 * Used for presence indicator dots.
 */
export function getShowColor(show: PresenceShow | null | undefined, forceOffline = false): string {
  if (forceOffline) return APP_OFFLINE_PRESENCE_COLOR
  if (show === null || show === undefined || show === 'chat') return 'bg-fluux-green'
  if (show === 'away' || show === 'xa') return 'bg-fluux-yellow'
  if (show === 'dnd') return 'bg-fluux-red'
  return 'bg-fluux-muted'
}

/**
 * Map PresenceShow to readable text.
 * 'xa' (extended away) is shown as 'Away' like 'chat' is shown as 'Online'.
 */
export function getShowText(show: PresenceShow | null | undefined, forceOffline = false): string {
  if (forceOffline) return 'Offline'
  if (show === null || show === undefined || show === 'chat') return 'Online'
  if (show === 'away' || show === 'xa') return 'Away'
  if (show === 'dnd') return 'Do Not Disturb'
  return 'Unknown'
}

// Use simplified type for translation function to avoid complex i18next type issues
type TranslateFn = (key: string) => string

/**
 * Map PresenceShow to translated readable text.
 * Uses i18next translation function for localized strings.
 */
export function getTranslatedShowText(show: PresenceShow | null | undefined, t: TranslateFn, forceOffline = false): string {
  if (forceOffline) return t('presence.offline')
  if (show === null || show === undefined || show === 'chat') return t('presence.online')
  if (show === 'away' || show === 'xa') return t('presence.away')
  if (show === 'dnd') return t('presence.dnd')
  return t('contacts.unknown')
}
