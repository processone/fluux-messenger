/**
 * Presence Display Utilities
 *
 * App-specific utilities for displaying XMPP presence states in the UI.
 * Generic presence utilities are in @fluux/sdk (getPresenceFromShow, etc.)
 */

import type { PresenceShow } from '@fluux/sdk'
import { APP_OFFLINE_PRESENCE_COLOR, PRESENCE_COLORS } from '../constants/ui'

/**
 * Map PresenceShow to shared presence indicator classes.
 */
export function getShowColor(show: PresenceShow | null | undefined, forceOffline = false): string {
  if (forceOffline) return APP_OFFLINE_PRESENCE_COLOR
  if (show === null || show === undefined || show === 'chat') return PRESENCE_COLORS.online
  if (show === 'away' || show === 'xa') return PRESENCE_COLORS.away
  if (show === 'dnd') return PRESENCE_COLORS.dnd
  return 'bg-fluux-muted'
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
