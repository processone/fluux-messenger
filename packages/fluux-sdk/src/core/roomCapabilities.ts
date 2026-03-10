/**
 * Room capability detection utilities.
 *
 * Pure functions for determining room capabilities based on
 * disco#info features (XEP-0030).
 *
 * @packageDocumentation
 * @module Core/RoomCapabilities
 */

import { NS_OCCUPANT_ID } from './namespaces'

/**
 * Determine whether a MUC room provides stable occupant identity.
 *
 * Stable identity is needed for features like reactions (XEP-0444), where
 * we must reliably track who performed an action. Identity is considered
 * stable when at least one of these conditions is met:
 *
 * - **Non-anonymous** (`muc_nonanonymous`): real JIDs are visible to all occupants
 * - **Members-only** (`muc_membersonly`): membership is controlled, nicks are stable
 * - **Occupant ID** (`urn:xmpp:occupant-id:0`): XEP-0421 provides a stable
 *   anonymous identifier that survives nick changes
 *
 * The only case that returns `false` is an **open, semi-anonymous room
 * without occupant-id support**, where nicks can change freely and there
 * is no reliable way to identify occupants.
 *
 * When features are missing or ambiguous, defaults to `true` (optimistic)
 * since most modern MUC rooms support stable identity.
 *
 * @param features - Array of feature namespace strings from disco#info
 * @returns `true` if the room provides stable occupant identity
 */
export function hasStableOccupantIdentity(features: string[]): boolean {
  const isNonAnonymous = features.includes('muc_nonanonymous')
  const isMembersOnly = features.includes('muc_membersonly')
  const hasOccupantId = features.includes(NS_OCCUPANT_ID)

  // Any of these guarantees stable identity
  if (isNonAnonymous || isMembersOnly || hasOccupantId) {
    return true
  }

  // Open + semi-anonymous + no occupant-id: nicks are unreliable
  const isSemiAnonymous = features.includes('muc_semianonymous')
  const isOpen = features.includes('muc_open')
  if (isSemiAnonymous && isOpen) {
    return false
  }

  // Features not advertised or ambiguous: default to optimistic
  return true
}
