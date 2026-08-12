import type { SideEffectHost } from './sideEffectHost'

interface RoomMembershipState {
  epoch: number
  joined: boolean
}

const clientRoomMemberships = new WeakMap<
  SideEffectHost,
  Map<string, RoomMembershipState>
>()

function getClientRoomMemberships(
  client: SideEffectHost,
): Map<string, RoomMembershipState> {
  let memberships = clientRoomMemberships.get(client)
  if (!memberships) {
    memberships = new Map()
    clientRoomMemberships.set(client, memberships)
  }
  return memberships
}

export function recordRoomMembership(
  client: SideEffectHost,
  roomJid: string,
  joined: boolean,
): number {
  const memberships = getClientRoomMemberships(client)
  const membership = memberships.get(roomJid)
  if (!membership) {
    memberships.set(roomJid, { epoch: 1, joined })
    return 1
  }
  if (membership.joined !== joined) {
    membership.joined = joined
    membership.epoch += 1
  }
  return membership.epoch
}

export function getRoomMembershipEpoch(
  client: SideEffectHost,
  roomJid: string,
): number {
  return clientRoomMemberships.get(client)?.get(roomJid)?.epoch ?? 0
}

export function invalidateRoomMemberships(client: SideEffectHost): void {
  const memberships = clientRoomMemberships.get(client)
  if (!memberships) return
  for (const membership of memberships.values()) {
    if (membership.joined) {
      membership.joined = false
      membership.epoch += 1
    }
  }
}
