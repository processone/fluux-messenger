import type { Room } from '@fluux/sdk'
import { getBareJid } from '@fluux/sdk/core'

export interface ContactSuggestion {
  jid: string
  name?: string
}

/**
 * Build extra contact suggestions from a room's occupants and affiliated members.
 * Occupant device addresses are reduced to the bare addresses used for membership and hats.
 * Used by ContactSelector in modals that manage room membership or hat assignments.
 */
export function buildRoomContactSuggestions(room: Room): ContactSuggestion[] {
  const seen = new Set<string>()
  const result: ContactSuggestion[] = []

  for (const occupant of room.occupants.values()) {
    if (!occupant.jid) continue
    const jid = getBareJid(occupant.jid)
    if (!seen.has(jid)) {
      seen.add(jid)
      result.push({ jid, name: occupant.nick })
    }
  }

  if (room.affiliatedMembers) {
    for (const member of room.affiliatedMembers) {
      if (!seen.has(member.jid)) {
        seen.add(member.jid)
        result.push({ jid: member.jid, name: member.nick })
      }
    }
  }

  return result
}
