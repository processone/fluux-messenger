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

/**
 * Whether a MUC room is non-anonymous — every occupant can see every other
 * occupant's real JID (`muc_nonanonymous`, XEP-0045 §6.4).
 *
 * This is the reliable, safety-critical signal for real-JID exposure: compliant
 * servers report the room's `whois` configuration in disco#info. The opposite
 * (`muc_semianonymous`, where only moderators see real JIDs) is the common,
 * safe default. When anonymity is not advertised we conservatively return
 * `false` (we cannot confirm exposure).
 *
 * @param features - Array of feature namespace strings from disco#info
 */
export function isNonAnonymousRoom(features: string[]): boolean {
  return features.includes('muc_nonanonymous')
}

/**
 * Whether a MUC room is deliberately private — members-only (`muc_membersonly`)
 * or unlisted/hidden (`muc_hidden`). These are rooms a user joins by deliberate
 * invitation rather than public discovery.
 *
 * Note: we intentionally do NOT key off `muc_public`. That flag is optional and
 * means "listed in the service directory" (discoverability), not "world-readable";
 * gateways and many rooms omit it. Keying off the positive private signals instead
 * keeps real-JID-exposure detection fail-safe (see {@link roomExposesRealJid}).
 *
 * @param features - Array of feature namespace strings from disco#info
 */
export function isPrivateRoom(features: string[]): boolean {
  return features.includes('muc_membersonly') || features.includes('muc_hidden')
}

/**
 * Whether joining a room would expose the user's real JID to people they did not
 * deliberately share it with — i.e. the room is non-anonymous AND not clearly
 * private. This is the trigger for the pre-join warning (issue #37).
 *
 * Fail-safe by design: a missing public/access flag never silences the warning;
 * only a positive private signal (`muc_membersonly`/`muc_hidden`) suppresses it.
 *
 * @param features - Array of feature namespace strings from disco#info
 */
export function roomExposesRealJid(features: string[]): boolean {
  return isNonAnonymousRoom(features) && !isPrivateRoom(features)
}
