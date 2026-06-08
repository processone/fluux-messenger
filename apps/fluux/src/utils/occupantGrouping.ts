/**
 * Pure occupant-grouping helpers for the MUC occupant panel.
 *
 * Extracted from OccupantPanel so the (O(n log n)) sort + grouping can be memoized
 * on the occupants Map reference — and unit-tested / spied in isolation. The panel
 * re-renders whenever its parent passes a new `room` (message activity, menu state,
 * connection status), so running this on every render is wasted work when the
 * occupants themselves did not change.
 */
import { getBareJid, getBestPresenceShow } from '@fluux/sdk'
import type { RoomOccupant, PresenceShow } from '@fluux/sdk'

/** A bare-JID group of one or more occupant connections (same person, multiple devices). */
export interface GroupedOccupant {
  bareJid?: string
  connections: RoomOccupant[]
  primaryNick: string // Main display nick
  bestPresence?: PresenceShow // Best presence show state (online > chat > away > xa > dnd)
}

/** Occupants of a single MUC role (moderator / participant / visitor), grouped by bare JID. */
export interface OccupantRoleGroup {
  role: string
  occupants: GroupedOccupant[]
}

// Role display order: lower number sorts higher in the list.
const ROLE_PRIORITY: Record<string, number> = {
  moderator: 0,
  participant: 1,
  visitor: 2,
  none: 3,
}

/**
 * Group occupants by bare JID within a role. Occupants sharing a bare JID are merged
 * into one group (multi-device); occupants without a JID each get their own group.
 * Result is sorted by primary nick.
 */
export function groupOccupantsByBareJid(occupants: RoomOccupant[]): GroupedOccupant[] {
  const byBareJid = new Map<string, RoomOccupant[]>()
  const noJid: RoomOccupant[] = []

  for (const occupant of occupants) {
    if (occupant.jid) {
      const bareJid = getBareJid(occupant.jid)
      const existing = byBareJid.get(bareJid)
      if (existing) {
        existing.push(occupant)
      } else {
        byBareJid.set(bareJid, [occupant])
      }
    } else {
      noJid.push(occupant)
    }
  }

  const result: GroupedOccupant[] = []

  // Grouped occupants (those with JIDs)
  for (const [bareJid, connections] of byBareJid) {
    connections.sort((a, b) => a.nick.localeCompare(b.nick))
    result.push({
      bareJid,
      connections,
      primaryNick: connections[0].nick,
      bestPresence: getBestPresenceShow(connections.map(c => c.show)),
    })
  }

  // Occupants without JIDs as individual groups
  for (const occupant of noJid) {
    result.push({
      bareJid: undefined,
      connections: [occupant],
      primaryNick: occupant.nick,
      bestPresence: occupant.show,
    })
  }

  // Sort all by primary nick
  result.sort((a, b) => a.primaryNick.localeCompare(b.primaryNick))

  return result
}

/**
 * Sort occupants by role priority then nick, and group them by role (and by bare JID
 * within each role). Pure — callers should memoize on the occupants Map reference so
 * this is skipped when a parent re-render does not change the occupants.
 */
export function groupOccupantsByRole(occupants: Map<string, RoomOccupant>): OccupantRoleGroup[] {
  const sorted = Array.from(occupants.values()).sort((a, b) => {
    const roleDiff = (ROLE_PRIORITY[a.role] ?? 3) - (ROLE_PRIORITY[b.role] ?? 3)
    if (roleDiff !== 0) return roleDiff
    return a.nick.localeCompare(b.nick)
  })

  const groups: OccupantRoleGroup[] = []
  let currentRole: string | null = null
  let currentRoleOccupants: RoomOccupant[] = []

  for (const occupant of sorted) {
    if (occupant.role !== currentRole) {
      if (currentRoleOccupants.length > 0 && currentRole) {
        groups.push({ role: currentRole, occupants: groupOccupantsByBareJid(currentRoleOccupants) })
      }
      currentRole = occupant.role
      currentRoleOccupants = [occupant]
    } else {
      currentRoleOccupants.push(occupant)
    }
  }

  // Last role group
  if (currentRoleOccupants.length > 0 && currentRole) {
    groups.push({ role: currentRole, occupants: groupOccupantsByBareJid(currentRoleOccupants) })
  }

  return groups
}
