import type { RoomOccupant } from '@fluux/sdk'

export function selectSelfOccupant(
  occupants: ReadonlyMap<string, RoomOccupant>,
  myNick: string | undefined,
): RoomOccupant | undefined {
  return myNick ? occupants.get(myNick) : undefined
}

export function stableNickSet(
  occupants: ReadonlyMap<string, RoomOccupant>,
  prev: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  if (prev && prev.size === occupants.size) {
    let same = true
    for (const nick of occupants.keys()) {
      if (!prev.has(nick)) { same = false; break }
    }
    if (same) return prev
  }
  return new Set(occupants.keys())
}
