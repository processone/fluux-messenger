import type { SideEffectHost } from './sideEffectHost'

type RoomMamHandoffEvent =
  | {
      roomJid: string
      membershipEpoch: number
      state: 'released'
    }
  | {
      roomJid: string
      membershipEpoch: number
      state: 'completed'
    }

type RoomMamHandoffHandler = (event: RoomMamHandoffEvent) => void

export interface RoomMamForegroundCoverage {
  readonly roomJid: string
  readonly generation: number
  readonly membershipEpoch: number
}

interface RoomMamForegroundCoverageState {
  generation: number
  rooms: Map<
    string,
    {
      owner: RoomMamForegroundCoverage
      completed: boolean
    }
  >
}

const roomMamHandoffHandlers = new WeakMap<
  SideEffectHost,
  Set<RoomMamHandoffHandler>
>()
const roomMamForegroundCoverage = new WeakMap<
  SideEffectHost,
  RoomMamForegroundCoverageState
>()

function getRoomMamForegroundCoverageState(
  client: SideEffectHost,
): RoomMamForegroundCoverageState {
  let state = roomMamForegroundCoverage.get(client)
  if (!state) {
    state = { generation: 0, rooms: new Map() }
    roomMamForegroundCoverage.set(client, state)
  }
  return state
}

export function beginRoomMamForegroundCoverage(
  client: SideEffectHost,
  roomJid: string,
  membershipEpoch: number,
): RoomMamForegroundCoverage {
  const state = getRoomMamForegroundCoverageState(client)
  const owner = {
    roomJid,
    generation: state.generation,
    membershipEpoch,
  }
  state.rooms.set(roomJid, { owner, completed: false })
  return owner
}

export function completeRoomMamForegroundCoverage(
  client: SideEffectHost,
  owner: RoomMamForegroundCoverage,
): void {
  const state = roomMamForegroundCoverage.get(client)
  const coverage = state?.rooms.get(owner.roomJid)
  if (
    state?.generation === owner.generation &&
    coverage?.owner === owner
  ) {
    coverage.completed = true
    roomMamHandoffHandlers.get(client)?.forEach((handler) => {
      handler({
        roomJid: owner.roomJid,
        membershipEpoch: owner.membershipEpoch,
        state: 'completed',
      })
    })
  }
}

export function releaseRoomMamForegroundCoverage(
  client: SideEffectHost,
  owner: RoomMamForegroundCoverage,
): void {
  const state = roomMamForegroundCoverage.get(client)
  const coverage = state?.rooms.get(owner.roomJid)
  if (
    state?.generation === owner.generation &&
    coverage?.owner === owner
  ) {
    state.rooms.delete(owner.roomJid)
  }
}

export function releaseRoomMamForegroundCoverageForRoom(
  client: SideEffectHost,
  roomJid: string,
): void {
  roomMamForegroundCoverage.get(client)?.rooms.delete(roomJid)
}

export function releaseInFlightRoomMamForegroundCoverage(
  client: SideEffectHost,
): void {
  const state = roomMamForegroundCoverage.get(client)
  if (!state) return
  for (const [roomJid, coverage] of state.rooms) {
    if (!coverage.completed) {
      state.rooms.delete(roomJid)
    }
  }
}

export function resetRoomMamForegroundCoverage(
  client: SideEffectHost,
): void {
  const state = getRoomMamForegroundCoverageState(client)
  state.generation += 1
  state.rooms.clear()
}

export function hasRoomMamForegroundCoverage(
  client: SideEffectHost,
  roomJid: string,
  membershipEpoch: number,
): boolean {
  const state = roomMamForegroundCoverage.get(client)
  const coverage = state?.rooms.get(roomJid)
  return !!(
    coverage &&
    coverage.owner.generation === state?.generation &&
    coverage.owner.membershipEpoch === membershipEpoch
  )
}

export function requestRoomMamHandoff(
  client: SideEffectHost,
  owner: RoomMamForegroundCoverage,
): void {
  roomMamHandoffHandlers.get(client)?.forEach((handler) => {
    handler({
      roomJid: owner.roomJid,
      membershipEpoch: owner.membershipEpoch,
      state: 'released',
    })
  })
}

export function subscribeRoomMamHandoff(
  client: SideEffectHost,
  handler: RoomMamHandoffHandler,
): () => void {
  let handlers = roomMamHandoffHandlers.get(client)
  if (!handlers) {
    handlers = new Set()
    roomMamHandoffHandlers.set(client, handlers)
  }
  handlers.add(handler)
  return () => {
    handlers.delete(handler)
    if (handlers.size === 0) {
      roomMamHandoffHandlers.delete(client)
    }
  }
}
