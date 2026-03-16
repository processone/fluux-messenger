/**
 * MUC permission utilities for XEP-0045 affiliation and role management.
 *
 * Pure functions that encode the XEP-0045 permission matrix for determining
 * which affiliation/role changes an actor is allowed to perform.
 *
 * @packageDocumentation
 * @module Utils/MUCPermissions
 */

import type { RoomAffiliation, RoomRole } from '../core/types'

const AFFILIATION_RANK: Record<RoomAffiliation, number> = {
  owner: 4,
  admin: 3,
  member: 2,
  none: 1,
  outcast: 0,
}

/**
 * Whether the actor can change the target's affiliation to the given value.
 *
 * XEP-0045 rules:
 * - Only owners can grant/revoke owner or admin
 * - Admins can grant/revoke member, outcast, none on targets below admin rank
 * - Nobody can modify someone of equal or higher rank (except owners on other owners)
 */
export function canSetAffiliation(
  actorAffiliation: RoomAffiliation,
  targetCurrentAffiliation: RoomAffiliation,
  newAffiliation: RoomAffiliation,
): boolean {
  if (actorAffiliation === 'none' || actorAffiliation === 'member' || actorAffiliation === 'outcast') {
    return false
  }

  if (actorAffiliation === 'owner') {
    // Owners can set any affiliation on anyone
    return true
  }

  // Admin logic
  if (actorAffiliation === 'admin') {
    // Admins cannot promote to owner or admin
    if (newAffiliation === 'owner' || newAffiliation === 'admin') return false
    // Admins cannot modify owners or other admins
    if (AFFILIATION_RANK[targetCurrentAffiliation] >= AFFILIATION_RANK['admin']) return false
    return true
  }

  return false
}

/**
 * Whether the actor can change the target's role.
 *
 * XEP-0045 rules:
 * - Only moderators (role) can change roles
 * - Cannot change roles of owners/admins (unless actor is owner)
 * - Moderators can grant/revoke voice (participant↔visitor)
 * - Admins+ can grant/revoke moderator
 */
export function canSetRole(
  actorRole: RoomRole,
  actorAffiliation: RoomAffiliation,
  _targetRole: RoomRole,
  targetAffiliation: RoomAffiliation,
): boolean {
  if (actorRole !== 'moderator') return false

  // Cannot modify owners (unless actor is also owner)
  if (targetAffiliation === 'owner') return false
  // Cannot modify admins (unless actor is owner)
  if (targetAffiliation === 'admin' && actorAffiliation !== 'owner') return false

  return true
}

/**
 * Whether the actor can kick the target (set role to 'none').
 */
export function canKick(
  actorRole: RoomRole,
  actorAffiliation: RoomAffiliation,
  targetAffiliation: RoomAffiliation,
): boolean {
  if (actorRole !== 'moderator') return false
  if (targetAffiliation === 'owner') return false
  if (targetAffiliation === 'admin' && actorAffiliation !== 'owner') return false
  return true
}

/**
 * Whether the actor can moderate (retract) the target's messages.
 *
 * XEP-0425 rules mirror kick permissions:
 * - Only moderators can moderate messages
 * - Cannot moderate owners' messages
 * - Cannot moderate admins' messages (unless actor is owner)
 */
export function canModerate(
  actorRole: RoomRole,
  actorAffiliation: RoomAffiliation,
  targetAffiliation: RoomAffiliation,
): boolean {
  if (actorRole !== 'moderator') return false
  if (targetAffiliation === 'owner') return false
  if (targetAffiliation === 'admin' && actorAffiliation !== 'owner') return false
  return true
}

/**
 * Whether the actor can ban the target (set affiliation to 'outcast').
 */
export function canBan(
  actorAffiliation: RoomAffiliation,
  targetAffiliation: RoomAffiliation,
): boolean {
  return canSetAffiliation(actorAffiliation, targetAffiliation, 'outcast')
}

/**
 * Get the affiliations the actor can assign to the target.
 * Returns only values different from the target's current affiliation.
 */
export function getAvailableAffiliations(
  actorAffiliation: RoomAffiliation,
  targetCurrentAffiliation: RoomAffiliation,
): RoomAffiliation[] {
  const all: RoomAffiliation[] = ['owner', 'admin', 'member', 'none', 'outcast']
  return all.filter(
    aff => aff !== targetCurrentAffiliation && canSetAffiliation(actorAffiliation, targetCurrentAffiliation, aff)
  )
}

/**
 * Get the roles the actor can assign to the target.
 * Returns only values different from the target's current role.
 */
export function getAvailableRoles(
  actorRole: RoomRole,
  actorAffiliation: RoomAffiliation,
  targetRole: RoomRole,
  targetAffiliation: RoomAffiliation,
): RoomRole[] {
  if (!canSetRole(actorRole, actorAffiliation, targetRole, targetAffiliation)) return []

  const all: RoomRole[] = ['moderator', 'participant', 'visitor']
  return all.filter(role => role !== targetRole)
}
