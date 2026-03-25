import type { DemoRoomData } from '@fluux/sdk'
import { getTeamRoom } from './teamChat'
import { getDesignRoom } from './designReview'

export { TEAM_ROOM_MESSAGES } from './teamChat'
export { DESIGN_ROOM_MESSAGES } from './designReview'

export function getDemoRooms(): DemoRoomData[] {
  return [getTeamRoom(), getDesignRoom()]
}
