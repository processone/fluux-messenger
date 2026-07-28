import type { DemoRoomData } from '@fluux/sdk/demo'
import { getTeamRoom } from './teamChat'
import { getDesignRoom } from './designReview'
import { getBoardRoom } from './boardPrivate'

export { TEAM_ROOM_MESSAGES } from './teamChat'
export { DESIGN_ROOM_MESSAGES } from './designReview'
export { BOARD_ROOM_MESSAGES } from './boardPrivate'
export { getDiscoverableRooms } from './discoverableRooms'
export type { DiscoverableRoom } from './discoverableRooms'

export function getDemoRooms(): DemoRoomData[] {
  return [getTeamRoom(), getDesignRoom(), getBoardRoom()]
}
